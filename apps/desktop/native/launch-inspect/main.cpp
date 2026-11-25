// Windows-only inspection helper. No target is loaded or executed; the closed
// stdin operation returns bounded metadata, not file contents or raw errors.
#include <windows.h>
#include <bcrypt.h>
#include <softpub.h>
#include <wintrust.h>
#include <winver.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <cwchar>
#include <iterator>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {
constexpr uint64_t maxExecutable = 256ull * 1024 * 1024;
constexpr uint64_t maxSafe = 9007199254740991ull;
constexpr uint64_t maxResourceBytes = 8ull * 1024 * 1024;
constexpr uint32_t maxVersionBytes = 1024 * 1024;
constexpr int64_t unixEpochFileTime = 116444736000000000ll;
constexpr size_t maxPath = 259, maxComponents = 64, maxInput = 4096;
constexpr uint32_t resourceDirectoryFlag = 0x80000000u, resourceOffsetMask = 0x7fffffffu;

class Handle {
public:
  explicit Handle(HANDLE v) : value_(v) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& v) noexcept : value_(v.value_) { v.value_ = INVALID_HANDLE_VALUE; }
  ~Handle() { if (valid()) CloseHandle(value_); }
  bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE get() const { return value_; }
private:
  HANDLE value_;
};

struct FileIdentity { uint64_t volume; std::array<unsigned char, 16> id; };
struct Observation {
  std::wstring path;
  FileIdentity identity;
  bool directory;
  uint64_t size, modifiedMs;
  int64_t rawWrite, rawChange;
};
struct Chain {
  std::vector<Handle> handles;
  std::vector<Observation> observations;
};

bool nonElevatedProcess() {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
  Handle token(raw);
  TOKEN_ELEVATION elevation{};
  DWORD returned = 0;
  return GetTokenInformation(token.get(), TokenElevation, &elevation, sizeof(elevation), &returned) &&
    returned == sizeof(elevation) && elevation.TokenIsElevated == 0;
}

std::wstring lower(std::wstring input) {
  for (wchar_t& c : input) if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
  return input;
}
bool startsWith(std::wstring_view value, std::wstring_view prefix) {
  return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}
bool endsWith(std::wstring_view value, std::wstring_view suffix) {
  return value.size() >= suffix.size() && value.substr(value.size() - suffix.size()) == suffix;
}
bool digit(wchar_t c) { return c >= L'0' && c <= L'9'; }
bool hex(wchar_t c) { return digit(c) || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F'); }

bool reservedName(std::wstring_view part) {
  const auto prefix = lower(std::wstring(part.substr(0, part.find(L'.'))));
  if (prefix == L"con" || prefix == L"prn" || prefix == L"aux" || prefix == L"nul" || prefix == L"conin$" ||
      prefix == L"conout$" || prefix == L"clock$") return true;
  if (prefix.size() == 4 && (startsWith(prefix, L"com") || startsWith(prefix, L"lpt"))) {
    const wchar_t c = prefix[3];
    return digit(c) || c == L'\u00b9' || c == L'\u00b2' || c == L'\u00b3';
  }
  return false;
}
bool safeComponent(std::wstring_view part) {
  if (part.empty() || part.size() > 255 || part == L"." || part == L".." || part.back() == L'.' ||
      iswspace(part.front()) || iswspace(part.back()) || reservedName(part)) return false;
  for (wchar_t c : part) {
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0xfeff || (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) ||
        std::wstring_view(L"<>:\"/\\|?*~").find(c) != std::wstring_view::npos) return false;
  }
  return true;
}
std::optional<std::vector<std::wstring>> pathPrefixes(const std::wstring& path) {
  if (path.size() < 3 || path.size() > maxPath || path[0] < L'A' || path[0] > L'Z' || path[1] != L':' || path[2] != L'\\') return {};
  std::vector<std::wstring> result{path.substr(0, 3)};
  size_t cursor = 3;
  while (cursor < path.size()) {
    const size_t slash = path.find(L'\\', cursor);
    const size_t end = slash == std::wstring::npos ? path.size() : slash;
    if (!safeComponent(std::wstring_view(path).substr(cursor, end - cursor))) return {};
    result.push_back(path.substr(0, end));
    if (result.size() > maxComponents + 1 || (end + 1 == path.size() && slash != std::wstring::npos)) return {};
    cursor = end + 1;
  }
  return result;
}

bool deniedStem(std::wstring stem) {
  stem = lower(std::move(stem));
  const std::set<std::wstring> denied{
    L"cmd",L"powershell",L"pwsh",L"wscript",L"cscript",L"mshta",L"rundll32",L"regsvr32",L"msiexec",
    L"runas",L"schtasks",L"wmic",L"wsl",L"bash",L"sh",L"zsh",L"dash",L"ksh",L"fish",L"busybox",
    L"python",L"pythonw",L"py",L"node",L"nodejs",L"deno",L"bun",L"perl",L"ruby",L"php",L"lua",
    L"java",L"javaw",L"dotnet",L"csi",L"csc",L"msbuild",L"installutil",L"conhost",L"wt",
    L"windowsterminal",L"reg",L"regedit",L"certutil",L"bitsadmin",L"curl",L"ftp",L"sc",L"services",
    L"taskkill",L"explorer",L"mmc",L"control",L"diskpart"
  };
  if (denied.count(stem)) return true;
  for (const auto prefix : {L"python",L"ruby",L"perl",L"php",L"lua",L"node",L"java",L"pwsh"}) {
    if (!startsWith(stem, prefix)) continue;
    const std::wstring_view suffix = std::wstring_view(stem).substr(wcslen(prefix));
    if (!suffix.empty() && std::all_of(suffix.begin(), suffix.end(), [](wchar_t c) { return digit(c) || c == L'.' || c == L'w'; })) return true;
  }
  return false;
}
bool allowedFilename(std::wstring name) {
  return safeComponent(name) && endsWith(lower(name), L".exe") && name.size() > 4 && !deniedStem(name.substr(0, name.size() - 4));
}
bool deniedMetadata(std::wstring value) {
  value = lower(std::move(value));
  if (endsWith(value, L".exe")) value.resize(value.size() - 4);
  if (deniedStem(value)) return true;
  for (const auto term : {L"command prompt", L"command processor", L"powershell", L"script host", L"script interpreter",
      L"terminal emulator", L"windows terminal", L"python interpreter", L"javascript runtime", L"windows installer"}) {
    if (value.find(term) != std::wstring::npos) return true;
  }
  return false;
}

bool directFixedVolume(const std::wstring& root) {
  if (root.size() != 3 || GetDriveTypeW(root.c_str()) != DRIVE_FIXED) return false;
  std::array<wchar_t, 4096> devices{};
  const auto drive = root.substr(0, 2);
  const DWORD written = QueryDosDeviceW(drive.c_str(), devices.data(), static_cast<DWORD>(devices.size()));
  if (written == 0 || written >= devices.size()) return false;
  const auto end = std::find(devices.begin(), devices.begin() + written, L'\0');
  if (end == devices.begin() + written) return false;
  const std::wstring device(devices.begin(), end);
  constexpr std::wstring_view direct = L"\\Device\\HarddiskVolume";
  // Reject SUBST/mappings/alternate device namespaces and ambiguous multiple
  // mappings before opening any user-selected object.
  if (!startsWith(device, direct) || device.size() == direct.size()) return false;
  if (!std::all_of(device.begin() + direct.size(), device.end(), digit) ||
      !std::all_of(end, devices.begin() + written, [](wchar_t c) { return c == 0; })) return false;
  std::array<wchar_t, 512> mount{}, guid{};
  if (!GetVolumePathNameW(root.c_str(), mount.data(), static_cast<DWORD>(mount.size())) || std::wstring(mount.data()) != root ||
      !GetVolumeNameForVolumeMountPointW(root.c_str(), guid.data(), static_cast<DWORD>(guid.size()))) return false;
  const std::wstring volume(guid.data());
  constexpr std::wstring_view prefix = L"\\\\?\\Volume{";
  if (!startsWith(volume, prefix) || !endsWith(volume, L"}\\") || volume.size() != prefix.size() + 36 + 2) return false;
  for (size_t i = 0; i < 36; ++i) {
    const wchar_t c = volume[prefix.size() + i];
    if ((i == 8 || i == 13 || i == 18 || i == 23) ? c != L'-' : !hex(c)) return false;
  }
  return true;
}

std::optional<Observation> observe(HANDLE handle, const std::wstring& exactPath) {
  if (GetFileType(handle) != FILE_TYPE_DISK) return {};
  FILE_ID_INFO identity{};
  FILE_ATTRIBUTE_TAG_INFO tags{};
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &identity, sizeof(identity)) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tags, sizeof(tags)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))) return {};
  constexpr DWORD forbidden = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE;
  if ((tags.FileAttributes & forbidden) || (basic.FileAttributes & forbidden) || standard.DeletePending || identity.VolumeSerialNumber == 0 ||
      std::all_of(std::begin(identity.FileId.Identifier), std::end(identity.FileId.Identifier), [](unsigned char c) { return c == 0; })) return {};
  const bool isDirectory = (tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (isDirectory != (standard.Directory != FALSE) || (isDirectory != ((basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0))) return {};
  std::array<wchar_t, maxPath + 16> finalPath{};
  const DWORD size = GetFinalPathNameByHandleW(handle, finalPath.data(), static_cast<DWORD>(finalPath.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (size == 0 || size >= finalPath.size() || std::wstring(finalPath.data(), size) != L"\\\\?\\" + exactPath) return {};
  if (standard.EndOfFile.QuadPart < 0 || basic.LastWriteTime.QuadPart < unixEpochFileTime) return {};
  const uint64_t bytes = isDirectory ? 0u : static_cast<uint64_t>(standard.EndOfFile.QuadPart);
  const uint64_t modified = static_cast<uint64_t>(basic.LastWriteTime.QuadPart - unixEpochFileTime) / 10000u;
  if (bytes > maxSafe || modified > maxSafe) return {};
  FileIdentity id{identity.VolumeSerialNumber, {}};
  std::copy(std::begin(identity.FileId.Identifier), std::end(identity.FileId.Identifier), id.id.begin());
  return Observation{exactPath, id, isDirectory, bytes, modified, basic.LastWriteTime.QuadPart, basic.ChangeTime.QuadPart};
}

std::optional<Chain> openChain(const std::wstring& path, bool readFile) {
  const auto prefixes = pathPrefixes(path);
  if (!prefixes || !directFixedVolume(prefixes->front())) return {};
  Chain chain;
  for (size_t i = 0; i < prefixes->size(); ++i) {
    const auto& part = (*prefixes)[i];
    const bool last = i + 1 == prefixes->size();
    // Hold ancestor and target handles through the complete inspection.
    // Conservative share-read only denies common replacement/write races;
    // files/directories currently held incompatibly are simply unavailable.
    const DWORD access = FILE_READ_ATTRIBUTES | (readFile && last ? GENERIC_READ : 0u);
    Handle handle(CreateFileW(part.c_str(), access, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (!handle.valid()) return {};
    auto observed = observe(handle.get(), part);
    if (!observed || (!last && !observed->directory) || (readFile && last && observed->directory)) return {};
    if (!chain.observations.empty() && observed->identity.volume != chain.observations.front().identity.volume) return {};
    chain.observations.push_back(std::move(*observed));
    chain.handles.push_back(std::move(handle));
  }
  return std::optional<Chain>(std::move(chain));
}
bool stillSame(const Chain& chain) {
  if (chain.handles.size() != chain.observations.size() || !directFixedVolume(chain.observations.front().path)) return false;
  for (size_t i = 0; i < chain.handles.size(); ++i) {
    const auto& old = chain.observations[i];
    const auto current = observe(chain.handles[i].get(), old.path);
    if (!current || current->identity.volume != old.identity.volume || current->identity.id != old.identity.id ||
        current->directory != old.directory || current->size != old.size || current->rawWrite != old.rawWrite || current->rawChange != old.rawChange) return false;
  }
  return true;
}

bool range(uint64_t fileSize, uint64_t at, uint64_t bytes) { return at <= fileSize && bytes <= fileSize - at; }
bool readAt(HANDLE handle, uint64_t fileSize, uint64_t at, void* destination, uint64_t length) {
  if (!range(fileSize, at, length) || length > maxExecutable) return false;
  LARGE_INTEGER position{}; position.QuadPart = static_cast<LONGLONG>(at);
  if (!SetFilePointerEx(handle, position, nullptr, FILE_BEGIN)) return false;
  auto* output = static_cast<unsigned char*>(destination);
  uint64_t consumed = 0;
  while (consumed < length) {
    const auto want = static_cast<DWORD>(std::min<uint64_t>(65536, length - consumed));
    DWORD read = 0;
    if (!ReadFile(handle, output + consumed, want, &read, nullptr) || read == 0 || read > want) return false;
    consumed += read;
  }
  return true;
}
template<typename T> bool readStruct(HANDLE handle, uint64_t fileSize, uint64_t at, T& value) {
  return readAt(handle, fileSize, at, &value, sizeof(T));
}
struct PeInfo {
  IMAGE_DATA_DIRECTORY resource{};
  IMAGE_DATA_DIRECTORY certificate{};
  std::vector<IMAGE_SECTION_HEADER> sections;
};
template<typename Header> bool validOptionalHeader(const Header& header, uint64_t size) {
  if (header.Subsystem != IMAGE_SUBSYSTEM_WINDOWS_GUI || header.AddressOfEntryPoint == 0 ||
      header.SizeOfImage == 0 || header.SizeOfImage > 0x80000000u || header.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_SECURITY) return false;
  const auto cert = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_SECURITY];
  const auto res = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_RESOURCE];
  return cert.VirtualAddress > 0 && cert.VirtualAddress % 8 == 0 && cert.Size >= 8 && cert.Size <= 4 * 1024 * 1024 &&
    range(size, cert.VirtualAddress, cert.Size) && static_cast<uint64_t>(cert.VirtualAddress) + cert.Size == size &&
    res.VirtualAddress > 0 && res.Size > 0 && res.Size <= maxResourceBytes;
}
std::optional<PeInfo> inspectPe(HANDLE handle, uint64_t size) {
  if (size < sizeof(IMAGE_DOS_HEADER) || size > maxExecutable) return {};
  IMAGE_DOS_HEADER dos{};
  if (!readStruct(handle, size, 0, dos) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
      dos.e_lfanew < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) || dos.e_lfanew > 1024 * 1024) return {};
  const auto nt = static_cast<uint64_t>(dos.e_lfanew);
  DWORD signature{};
  IMAGE_FILE_HEADER file{};
  if (!readStruct(handle, size, nt, signature) || signature != IMAGE_NT_SIGNATURE ||
      !readStruct(handle, size, nt + sizeof(signature), file) || !(file.Characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) ||
      (file.Characteristics & (IMAGE_FILE_DLL | IMAGE_FILE_SYSTEM)) || file.NumberOfSections < 1 || file.NumberOfSections > 96) return {};
  const uint64_t optOffset = nt + sizeof(signature) + sizeof(file);
  WORD magic{};
  if (!readStruct(handle, size, optOffset, magic)) return {};
  PeInfo pe;
  uint32_t entry = 0;
  if (magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC && file.Machine == IMAGE_FILE_MACHINE_I386 &&
      file.SizeOfOptionalHeader == sizeof(IMAGE_OPTIONAL_HEADER32)) {
    IMAGE_OPTIONAL_HEADER32 header{};
    if (!readStruct(handle, size, optOffset, header) || !validOptionalHeader(header, size)) return {};
    pe.resource = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_RESOURCE];
    pe.certificate = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_SECURITY]; entry = header.AddressOfEntryPoint;
  } else if (magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC && (file.Machine == IMAGE_FILE_MACHINE_AMD64 || file.Machine == IMAGE_FILE_MACHINE_ARM64) &&
      file.SizeOfOptionalHeader == sizeof(IMAGE_OPTIONAL_HEADER64)) {
    IMAGE_OPTIONAL_HEADER64 header{};
    if (!readStruct(handle, size, optOffset, header) || !validOptionalHeader(header, size)) return {};
    pe.resource = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_RESOURCE];
    pe.certificate = header.DataDirectory[IMAGE_DIRECTORY_ENTRY_SECURITY]; entry = header.AddressOfEntryPoint;
  } else return {};
  const uint64_t sectionOffset = optOffset + file.SizeOfOptionalHeader;
  pe.sections.resize(file.NumberOfSections);
  if (!readAt(handle, size, sectionOffset, pe.sections.data(), pe.sections.size() * sizeof(IMAGE_SECTION_HEADER))) return {};
  bool entryIsExecutable = false;
  for (const auto& section : pe.sections) {
    // Reject sections overlapping unsigned certificate bytes. Embedded
    // application metadata is accepted from ordinary PE section ranges only.
    if (section.SizeOfRawData && (!range(size, section.PointerToRawData, section.SizeOfRawData) ||
        section.PointerToRawData < sectionOffset + pe.sections.size() * sizeof(IMAGE_SECTION_HEADER) ||
        static_cast<uint64_t>(section.PointerToRawData) + section.SizeOfRawData > pe.certificate.VirtualAddress)) return {};
    const uint64_t from = section.VirtualAddress;
    const uint64_t span = std::max(section.Misc.VirtualSize, section.SizeOfRawData);
    if ((section.Characteristics & IMAGE_SCN_MEM_EXECUTE) && entry >= from && static_cast<uint64_t>(entry) - from < span) entryIsExecutable = true;
  }
  return entryIsExecutable ? std::optional<PeInfo>(std::move(pe)) : std::nullopt;
}

std::optional<uint64_t> rvaOffset(const PeInfo& pe, uint64_t size, uint32_t rva, uint32_t length) {
  std::optional<uint64_t> result;
  for (const auto& section : pe.sections) {
    if (rva < section.VirtualAddress) continue;
    const uint64_t delta = static_cast<uint64_t>(rva) - section.VirtualAddress;
    if (!range(section.SizeOfRawData, delta, length)) continue;
    const uint64_t offset = static_cast<uint64_t>(section.PointerToRawData) + delta;
    if (result || !range(size, offset, length)) return {}; // ambiguous/malformed section mapping
    result = offset;
  }
  return result;
}

struct ResourceEntry { uint32_t name, data; };
static_assert(sizeof(ResourceEntry) == sizeof(IMAGE_RESOURCE_DIRECTORY_ENTRY));
std::optional<std::vector<ResourceEntry>> directoryEntries(HANDLE handle, uint64_t size, uint64_t base, uint32_t resSize, uint32_t relative) {
  IMAGE_RESOURCE_DIRECTORY directory{};
  if (!range(resSize, relative, sizeof(directory)) || !readStruct(handle, size, base + relative, directory)) return {};
  const uint64_t count = static_cast<uint64_t>(directory.NumberOfNamedEntries) + directory.NumberOfIdEntries;
  if (count == 0 || count > 256 || !range(resSize, static_cast<uint64_t>(relative) + sizeof(directory), count * sizeof(ResourceEntry))) return {};
  std::vector<ResourceEntry> entries(static_cast<size_t>(count));
  if (!readAt(handle, size, base + relative + sizeof(directory), entries.data(), count * sizeof(ResourceEntry))) return {};
  return entries;
}

// Parse the bounded version resource from the actual signed PE handle, not
// from a potentially separate MUI/version sidecar and never via LoadLibrary.
uint16_t word(const std::vector<unsigned char>& bytes, size_t at) {
  return static_cast<uint16_t>(bytes[at] | (static_cast<uint16_t>(bytes[at + 1]) << 8));
}
size_t align4(size_t value) { return (value + 3) & ~size_t{3}; }
struct VersionNode { size_t end, valueAt, valueBytes, children; uint16_t type; std::wstring key; };
std::optional<VersionNode> versionNode(const std::vector<unsigned char>& bytes, size_t at, size_t limit) {
  if (limit > bytes.size() || at > limit || limit - at < 6) return {};
  const auto length = word(bytes, at), valueLength = word(bytes, at + 2), type = word(bytes, at + 4);
  if (length < 8 || length > limit - at || type > 1) return {};
  const size_t end = at + length;
  size_t pos = at + 6;
  std::wstring key;
  bool terminated = false;
  while (pos + 2 <= end && key.size() <= 128) {
    const auto c = word(bytes, pos); pos += 2;
    if (c == 0) { terminated = true; break; }
    key.push_back(static_cast<wchar_t>(c));
  }
  if (!terminated || key.empty() || key.size() > 128) return {};
  const size_t valueAt = align4(pos), valueBytes = static_cast<size_t>(valueLength) * (type == 1 ? 2 : 1);
  if (valueAt > end || valueBytes > end - valueAt) {
    if (valueBytes == 0 && pos <= end && end < valueAt) return VersionNode{end, end, 0, end, type, std::move(key)};
    return {};
  }
  return VersionNode{end, valueAt, valueBytes, std::min(end, align4(valueAt + valueBytes)), type, std::move(key)};
}
std::optional<std::vector<VersionNode>> children(const std::vector<unsigned char>& bytes, const VersionNode& parent, size_t maxCount) {
  std::vector<VersionNode> result;
  size_t next = parent.children;
  while (next < parent.end) {
    if (parent.end - next < 6) {
      if (std::all_of(bytes.begin() + next, bytes.begin() + parent.end, [](unsigned char c) { return c == 0; })) break;
      return {};
    }
    auto child = versionNode(bytes, next, parent.end);
    if (!child || result.size() == maxCount) return {};
    next = std::min(parent.end, align4(child->end));
    result.push_back(std::move(*child));
  }
  return result;
}
std::optional<std::wstring> versionString(const std::vector<unsigned char>& bytes, const VersionNode& node) {
  if (node.type != 1 || node.valueBytes < 2 || node.valueBytes % 2 != 0 || node.children != node.end) return {};
  std::wstring result;
  for (size_t pos = 0; pos < node.valueBytes; pos += 2) {
    const auto c = word(bytes, node.valueAt + pos);
    if (c == 0) return pos + 2 == node.valueBytes ? std::optional<std::wstring>(std::move(result)) : std::nullopt;
    result.push_back(static_cast<wchar_t>(c));
  }
  return {};
}
std::optional<std::wstring> originalFromVersion(const std::vector<unsigned char>& bytes) {
  auto root = versionNode(bytes, 0, bytes.size());
  if (!root || root->key != L"VS_VERSION_INFO" || root->type != 0 || root->valueBytes != sizeof(VS_FIXEDFILEINFO)) return {};
  VS_FIXEDFILEINFO fixed{};
  memcpy(&fixed, bytes.data() + root->valueAt, sizeof(fixed));
  if (fixed.dwSignature != 0xfeef04bdu || fixed.dwFileType != VFT_APP) return {};
  const auto top = children(bytes, *root, 8);
  if (!top) return {};
  std::optional<std::wstring> original;
  bool sawStrings = false;
  for (const auto& group : *top) {
    if (group.key == L"VarFileInfo") continue;
    if (group.key != L"StringFileInfo" || group.valueBytes != 0 || sawStrings) return {};
    sawStrings = true;
    const auto tables = children(bytes, group, 32);
    if (!tables || tables->empty()) return {};
    for (const auto& table : *tables) {
      if (table.key.size() != 8 || !std::all_of(table.key.begin(), table.key.end(), hex) || table.valueBytes != 0) return {};
      const auto strings = children(bytes, table, 64);
      if (!strings || strings->empty()) return {};
      bool foundFilename = false;
      std::set<std::wstring> seenKeys;
      for (const auto& item : *strings) {
        const auto key = lower(item.key);
        if (!seenKeys.insert(key).second) return {};
        if (key != L"originalfilename" && key != L"internalname" && key != L"filedescription" && key != L"productname") continue;
        const auto value = versionString(bytes, item);
        if (!value || value->empty() || value->size() > 255 || deniedMetadata(*value)) return {};
        if (key == L"originalfilename") {
          if (foundFilename || !allowedFilename(*value) || (original && lower(*original) != lower(*value))) return {};
          foundFilename = true;
          original = *value;
        }
      }
      if (!foundFilename) return {};
    }
  }
  return original;
}

std::optional<std::wstring> embeddedOriginalFilename(HANDLE handle, uint64_t size, const PeInfo& pe) {
  const auto base = rvaOffset(pe, size, pe.resource.VirtualAddress, pe.resource.Size);
  if (!base) return {};
  const auto root = directoryEntries(handle, size, *base, pe.resource.Size, 0);
  if (!root) return {};
  std::optional<uint32_t> versionDir;
  for (const auto& entry : *root) if (entry.name == 16u) { // integer RT_VERSION
    if (versionDir || !(entry.data & resourceDirectoryFlag)) return {};
    versionDir = entry.data & resourceOffsetMask;
  }
  if (!versionDir) return {};
  const auto names = directoryEntries(handle, size, *base, pe.resource.Size, *versionDir);
  if (!names || names->size() != 1 || (names->front().name & resourceDirectoryFlag) ||
      !(names->front().data & resourceDirectoryFlag)) return {};
  const auto languages = directoryEntries(handle, size, *base, pe.resource.Size, names->front().data & resourceOffsetMask);
  if (!languages || languages->empty() || languages->size() > 16) return {};
  std::optional<std::wstring> original;
  std::set<uint32_t> seenLang;
  for (const auto& lang : *languages) {
    if ((lang.name & resourceDirectoryFlag) || (lang.data & resourceDirectoryFlag) || !seenLang.insert(lang.name).second) return {};
    IMAGE_RESOURCE_DATA_ENTRY data{};
    if (!range(pe.resource.Size, lang.data, sizeof(data)) || !readStruct(handle, size, *base + lang.data, data) ||
        data.Size == 0 || data.Size > maxVersionBytes) return {};
    const auto offset = rvaOffset(pe, size, data.OffsetToData, data.Size);
    if (!offset) return {};
    std::vector<unsigned char> bytes(data.Size);
    if (!readAt(handle, size, *offset, bytes.data(), bytes.size())) return {};
    const auto found = originalFromVersion(bytes);
    if (!found || (original && lower(*original) != lower(*found))) return {};
    original = *found;
  }
  return original;
}

bool verifySignatureOffline(HANDLE handle, const std::wstring& path) {
  WINTRUST_FILE_INFO file{};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = path.c_str();
  file.hFile = handle;
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  // Do not perform network revocation retrieval; offline OS trust is not a
  // fresh revocation check or proof that an arbitrary signed app is harmless.
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE | WTD_DISABLE_MD2_MD4;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE), &action, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE), &action, &trust);
  return status == ERROR_SUCCESS;
}

std::optional<std::array<unsigned char, 32>> hashFile(HANDLE file, uint64_t size) {
  if (size < 1 || size > maxExecutable) return {};
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return {};
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::optional<std::array<unsigned char, 32>> result;
  DWORD objectLength = 0, written = 0, digestLength = 0;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength), &written, 0) == 0 &&
      objectLength > 0 && objectLength <= 1024 * 1024 &&
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&digestLength), sizeof(digestLength), &written, 0) == 0 && digestLength == 32) {
    std::vector<unsigned char> storage(objectLength);
    if (BCryptCreateHash(algorithm, &hash, storage.data(), objectLength, nullptr, 0, 0) == 0) {
      LARGE_INTEGER start{};
      if (SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) {
        std::array<unsigned char, 64 * 1024> block{};
        uint64_t remaining = size;
        bool good = true;
        while (remaining) {
          const DWORD want = static_cast<DWORD>(std::min<uint64_t>(remaining, block.size()));
          DWORD read = 0;
          if (!ReadFile(file, block.data(), want, &read, nullptr) || read == 0 || read > want ||
              BCryptHashData(hash, block.data(), read, 0) != 0) { good = false; break; }
          remaining -= read;
        }
        DWORD extra = 0;
        if (good && ReadFile(file, block.data(), 1, &extra, nullptr) && extra == 0) {
          std::array<unsigned char, 32> digest{};
          if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0) result = digest;
        }
      }
      BCryptDestroyHash(hash);
    }
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

std::optional<std::wstring> toWide(const std::string& value) {
  if (value.empty() || value.size() > maxInput || value.find('\0') != std::string::npos) return {};
  const int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (units < 1 || units > static_cast<int>(maxPath)) return {};
  std::wstring result(static_cast<size_t>(units), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), units) != units) return {};
  return result;
}
std::optional<std::string> toUtf8(const std::wstring& value) {
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length < 1 || length > 4096) return {};
  std::string result(static_cast<size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr) != length) return {};
  return result;
}
std::string quoteJson(const std::string& value) {
  std::string out = "\"";
  constexpr char digits[] = "0123456789abcdef";
  for (unsigned char c : value) {
    if (c == '\\' || c == '"') { out.push_back('\\'); out.push_back(static_cast<char>(c)); }
    else if (c < 32) { out += "\\u00"; out.push_back(digits[c >> 4]); out.push_back(digits[c & 15]); }
    else out.push_back(static_cast<char>(c));
  }
  out.push_back('"');
  return out;
}
template<size_t N> std::string hexBytes(const std::array<unsigned char, N>& bytes) {
  constexpr char digits[] = "0123456789abcdef";
  std::string text;
  for (unsigned char c : bytes) { text.push_back(digits[c >> 4]); text.push_back(digits[c & 15]); }
  return text;
}
std::string hexNumber(uint64_t value) {
  constexpr char digits[] = "0123456789abcdef";
  std::string text(16, '0');
  for (int i = 15; i >= 0; --i) { text[static_cast<size_t>(i)] = digits[value & 15]; value >>= 4; }
  return text;
}
std::optional<std::string> observationFields(const Observation& o) {
  const auto path = toUtf8(o.path);
  if (!path) return {};
  return "\"canonicalPath\":" + quoteJson(*path) + ",\"identity\":{\"volumeSerial\":\"" + hexNumber(o.identity.volume) +
    "\",\"fileId\":\"" + hexBytes(o.identity.id) + "\"},\"kind\":\"" + (o.directory ? "DIRECTORY" : "FILE") +
    "\",\"reparsePoint\":false,\"sizeBytes\":" + std::to_string(o.size) + ",\"modifiedAtMs\":" + std::to_string(o.modifiedMs);
}
bool writeResponse(const std::string& operation, const std::string& result) {
  const std::string text = "{\"version\":1,\"operation\":" + quoteJson(operation) + ",\"result\":" + result + "}";
  return text.size() <= 16384 && fwrite(text.data(), 1, text.size(), stdout) == text.size() && fflush(stdout) == 0;
}
std::optional<uint64_t> decimal(const std::string& text) {
  if (text.empty() || text.size() > 10 || (text.size() > 1 && text[0] == '0')) return {};
  uint64_t result = 0;
  for (char c : text) { if (c < '0' || c > '9') return {}; result = result * 10 + static_cast<uint64_t>(c - '0'); }
  return result;
}

int inspect() {
  // The helper inherits Main's normal process token. Elevated Main cannot use
  // the local EXE/folder inspection-and-launch path; no privilege fallback.
  if (!nonElevatedProcess()) return 3;
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
  std::array<char, maxInput + 1> bytes{};
  const size_t read = fread(bytes.data(), 1, bytes.size(), stdin);
  if (ferror(stdin) || read == 0 || read > maxInput) return 2;
  const std::string input(bytes.data(), read);
  if (input.find('\0') != std::string::npos || input.find('\r') != std::string::npos) return 2;
  std::vector<std::string> lines;
  size_t cursor = 0;
  while (cursor < input.size()) {
    const size_t end = input.find('\n', cursor);
    if (end == std::string::npos || lines.size() >= 4) return 2;
    lines.push_back(input.substr(cursor, end - cursor)); cursor = end + 1;
  }
  if (lines.size() != 4 || lines[0] != "PET-DESKTOP-LAUNCH-INSPECT-V1") return 2;
  const auto& operation = lines[1];
  const auto path = toWide(lines[2]);
  const auto maximum = decimal(lines[3]);
  if (!path || !maximum || !pathPrefixes(*path)) return 2;
  if (operation == "DRIVE") {
    if (*maximum != 0 || path->size() != 3) return 2;
    // Any non-direct, non-fixed, unsupported volume is simply UNKNOWN.
    return writeResponse(operation, directFixedVolume(*path) ? "\"FIXED\"" : "\"UNKNOWN\"") ? 0 : 3;
  }
  const bool hash = operation == "HASH_EXE";
  if (operation != "INSPECT" && !hash) return 2;
  if (hash ? (*maximum == 0 || *maximum > maxExecutable || !allowedFilename(path->substr(path->find_last_of(L'\\') + 1))) : *maximum != 0) return 2;
  auto chain = openChain(*path, hash);
  if (!chain || chain->observations.empty()) return 3;
  const auto& observed = chain->observations.back();
  const auto fields = observationFields(observed);
  if (!fields) return 3;
  if (!hash) return stillSame(*chain) && writeResponse(operation, "{" + *fields + "}") ? 0 : 3;
  if (observed.directory || observed.size < 1 || observed.size > *maximum) return 3;
  const HANDLE file = chain->handles.back().get();
  const auto pe = inspectPe(file, observed.size);
  if (!pe) return 3;
  const auto original = embeddedOriginalFilename(file, observed.size, *pe);
  if (!original || !verifySignatureOffline(file, *path)) return 3;
  const auto originalText = toUtf8(*original);
  const auto digest = hashFile(file, observed.size);
  if (!originalText || !digest || !stillSame(*chain)) return 3;
  return writeResponse(operation, "{" + *fields + ",\"sha256\":\"" + hexBytes(*digest) +
    "\",\"format\":\"PE_EXE\",\"classification\":\"USER_APPLICATION\",\"originalFilename\":" + quoteJson(*originalText) + "}") ? 0 : 3;
}
} // namespace

int main(int argc, char**) {
  // No command-line location, flags, arguments or extension mechanism.
  if (argc != 1) return 2;
  try { return inspect(); } catch (...) { return 3; }
}
