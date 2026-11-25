# Windows local-launch inspection helper (009C-1)

This is the native source for the restricted quick-workspace adapter. It is
not a command runner, program loader, process discovery utility or general
filesystem API. Main's QuickLaunchPolicy must drive all operations; never
expose this executable or adapter methods through a raw renderer API.

## Packaging gate

The V1 helper targets Windows x64 and the Windows 10/11 SDK. From a Windows
developer environment with Visual Studio 2022 C++ build tools and CMake:

```powershell
cmake -S apps/desktop/native/launch-inspect -B build/launch-inspect -G "Visual Studio 17 2022" -A x64
cmake --build build/launch-inspect --config Release
Get-FileHash build/launch-inspect/Release/launch-inspect.exe -Algorithm SHA256
```

These are developer build steps, not user application behavior. After any
release signing or other binary mutation, compute the final binary digest
again. Package the resulting binary in the application's resources at exactly
`native/launch-inspect/launch-inspect.exe` (outside ASAR). Embed the approved
final lower-case SHA-256 in trusted Main build code and set
`expectedInspectorSha256`. Do not load the digest from an adjacent mutable
file, settings, renderer, user-selected folder or AI tool.

The source is intentionally provided without a fabricated Windows executable,
signature or pinned digest. A missing/mismatched helper, unsupported host or
unavailable native observation means local executable/directory support is not
available. The Main HTTPS adapter may remain separately available, only with
explicit manual input and native confirmation. Do not substitute a script,
PowerShell, command shell, file association, or PATH-discovered helper.

## Scope and limitations

- Fixed stdin protocol, no arguments, three operations: DRIVE, INSPECT and
  HASH_EXE. Requests contain only a canonical local drive/path and size bound;
  responses contain bounded identity, file metadata and executable digest.
- The native helper accepts direct fixed volumes only. It opens each relative
  component using handles with reparse handling disabled, compares canonical
  final paths and volume/file IDs, and rejects incomplete observations.
  Restrictive file sharing and ancestor re-observation may conservatively
  make busy files/directories unavailable.
- The executable slice is intentionally narrow: GUI PE application (not
  console, DLL or system image), embedded version metadata naming the original
  application, embedded Authenticode certificate and a successful OS trust
  check without UI or network revocation retrieval. Local full-content SHA-256
  is read from the same held file handle, bounded to 256 MiB.
- The helper rejects execution under an elevated process token. The app uses
  direct process creation, no target arguments and no privilege request.
  Opening a user-approved directory or an HTTPS URL uses Electron's narrow host
  shell methods. A successful launch outcome means the system accepted the
  operation, not that the external app is ready or succeeded.
- The deny list and PE/signature checks narrow the supported application
  class. They do **not** prove arbitrary signed application behavior, identify
  every unsafe application or provide a sandbox. Offline/cached signature
  trust is not fresh certificate revocation information. A user's app may
  itself perform network operations, load dependencies or display prompts.
- Main revalidates an approved fingerprint before launch, but separate
  inspection and OS launch calls do not provide a fully atomic identity/launch
  guarantee. The bundled helper directory is a trusted packaged-installation
  boundary. Stronger guarantees against an attacker able to race local file
  replacement or modify the installation require a distinct future design.
- The adapter consumes a short-lived one-use exact target observation
  synchronously when the policy calls it. This avoids an extra asynchronous
  helper capability lookup or queued OS operation after authorization. The
  observation alone is not permission: only Main's QuickLaunchPolicy can
  invoke the launcher after rechecking the saved revision, fingerprint and
  native approval. Parallel routine read-only inspection is serialized.
- No raw launcher paths, binary bytes or helper errors should be passed to the
  renderer. The native dialogs show the selected canonical target and default
  to cancellation; saved-action invocation currently requires a fresh Main
  native approval because renderer IPC alone does not attest a physical click.

## Verification status

Repository tests exercise the TypeScript adapter using synthetic temporary
helper bytes and injected fake native dialog, shell and process ports. They
test the pinned digest, bounded stdin/stdout, reply validation, sender checks,
native confirmation and fixed dispatch. They do not execute a helper, target
program, shell, browser or real Electron window.

The Windows helper must still be compiled, code-reviewed and packaged on
Windows; validate real filesystem handle behavior, exact path casing,
reparse/mapped volume refusal, token checks, PE resource parsing and offline
trust behavior before enabling local target support. In particular, verify
WinVerifyTrust's actual offline behavior with networking disabled on the
supported OS builds; cache-only flags are not a claim of process-wide network
isolation. Native trust and signature checks do not have a mock-based success
substitute.

## Official API references

- [FILE_ID_INFO](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info),
  [GetFileInformationByHandleEx](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
  [CreateFileW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew),
  [GetFinalPathNameByHandleW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [Naming Files, Paths, and Namespaces](https://learn.microsoft.com/windows/win32/fileio/naming-a-file),
  [Reparse Points and File Operations](https://learn.microsoft.com/windows/win32/fileio/reparse-points-and-file-operations),
  [GetDriveTypeW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getdrivetypew),
  [QueryDosDeviceW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-querydosdevicew)
- [PE format](https://learn.microsoft.com/windows/win32/debug/pe-format),
  [VS_VERSIONINFO](https://learn.microsoft.com/windows/win32/menurc/vs-versioninfo),
  [StringFileInfo](https://learn.microsoft.com/windows/win32/menurc/stringfileinfo)
- [WinVerifyTrust](https://learn.microsoft.com/windows/win32/api/wintrust/nf-wintrust-winverifytrust),
  [WINTRUST_DATA](https://learn.microsoft.com/windows/win32/api/wintrust/ns-wintrust-wintrust_data),
  [WINTRUST_FILE_INFO](https://learn.microsoft.com/windows/win32/api/wintrust/ns-wintrust-wintrust_file_info),
  [BCryptFinishHash](https://learn.microsoft.com/windows/win32/api/bcrypt/nf-bcrypt-bcryptfinishhash),
  [TOKEN_ELEVATION](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-token_elevation)
- [Node child_process](https://nodejs.org/api/child_process.html),
  [Electron dialog](https://www.electronjs.org/docs/latest/api/dialog),
  [Electron shell](https://www.electronjs.org/docs/latest/api/shell),
  [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
