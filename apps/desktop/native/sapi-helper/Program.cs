using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Speech.Synthesis;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// A fixed one-request Windows helper. No command-line arguments, paths,
// real-time recording, SSML, network, subprocesses or audio-device output.
internal static class Program
{
    private const int MaxInputBytes = 128 * 1024;
    private const int MaxListBytes = 128 * 1024;
    private const int MaxAudioBytes = 12 * 1024 * 1024;
    private const int MaxTextLength = 16_384;
    private static readonly Regex VoiceId = new("^sapi-[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex Locale = new("^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,5}$", RegexOptions.CultureInvariant);

    // Controlled exit codes only. Never print raw system voice paths,
    // exception details, input text, diagnostics or identifying metadata.
    public static int Main(string[] args)
    {
        if (args.Length != 0) return 2;
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64) return 4;
        try
        {
            byte[] input = ReadInput();
            using JsonDocument document = JsonDocument.Parse(input, new JsonDocumentOptions { MaxDepth = 6, AllowTrailingCommas = false });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeProperty) || typeProperty.ValueKind != JsonValueKind.String)
                return 2;
            switch (typeProperty.GetString())
            {
                case "ENUMERATE":
                    ExactFields(root, "type");
                    Enumerate();
                    return 0;
                case "SYNTHESIZE":
                    ExactFields(root, "type", "voiceId", "locale", "rate", "text");
                    Synthesize(root);
                    return 0;
                default: return 2;
            }
        }
        catch (BadInput) { return 2; }
        catch (JsonException) { return 2; }
        catch (MissingVoice) { return 3; }
        catch (InvalidOutput) { return 5; }
        catch { return 4; }
    }

    private static byte[] ReadInput()
    {
        using Stream stdin = Console.OpenStandardInput();
        using MemoryStream result = new();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = stdin.Read(buffer, 0, buffer.Length)) != 0)
        {
            if (result.Length + count > MaxInputBytes) throw new BadInput();
            result.Write(buffer, 0, count);
        }
        if (result.Length == 0) throw new BadInput();
        return result.ToArray();
    }

    private static void ExactFields(JsonElement value, params string[] fields)
    {
        var expected = new HashSet<string>(fields, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
            if (!expected.Contains(property.Name) || !seen.Add(property.Name)) throw new BadInput();
        if (seen.Count != expected.Count) throw new BadInput();
    }

    private static string FieldString(JsonElement root, string key, int maximum)
    {
        JsonElement value = root.GetProperty(key);
        if (value.ValueKind != JsonValueKind.String) throw new BadInput();
        string text = value.GetString() ?? throw new BadInput();
        if (text.Length < 1 || text.Length > maximum) throw new BadInput();
        return text;
    }

    private sealed record VoiceEntry(VoiceInfo Info, string VoiceId, string Locale, string DisplayName);

    private static List<VoiceEntry> EnabledVoices(SpeechSynthesizer synthesizer)
    {
        // SelectVoice uses a name/substring match. Keep only unambiguous full
        // enabled names, and verify the actual selected VoiceInfo again below.
        List<VoiceInfo> enabled = synthesizer.GetInstalledVoices().Where(voice => voice.Enabled).Select(voice => voice.VoiceInfo).ToList();
        if (enabled.Count > 512) throw new InvalidOutput();
        List<VoiceEntry> candidates = new();
        foreach (VoiceInfo info in enabled)
        {
            string name = info.Name, locale = info.Culture.Name, installedId = info.Id;
            if (string.IsNullOrEmpty(name) || name.Length > 240 || string.IsNullOrEmpty(installedId) || installedId.Length > 4096
                || locale.Length > 48 || !Locale.IsMatch(locale) || name.Any(ch => char.IsControl(ch) || char.IsSurrogate(ch) || char.GetUnicodeCategory(ch) == UnicodeCategory.Format)) continue;
            if (enabled.Count(other => other.Name.Contains(name, StringComparison.Ordinal)) != 1) continue;
            string identity = installedId + "\0" + name + "\0" + locale;
            string key = "sapi-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
            candidates.Add(new VoiceEntry(info, key, locale, name));
        }
        return candidates.GroupBy(entry => entry.VoiceId, StringComparer.Ordinal).Where(group => group.Count() == 1)
            .Select(group => group.Single()).OrderBy(entry => entry.Locale, StringComparer.Ordinal)
            .ThenBy(entry => entry.DisplayName, StringComparer.Ordinal).ThenBy(entry => entry.VoiceId, StringComparer.Ordinal).Take(128).ToList();
    }

    private static void Enumerate()
    {
        using SpeechSynthesizer synthesizer = new();
        // An empty list is allowed only if the actual system enumeration has
        // no usable installed voice. Never invent a default voice.
        var entries = EnabledVoices(synthesizer).Select(voice => new { voiceId = voice.VoiceId, locale = voice.Locale, displayName = voice.DisplayName });
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { voices = entries });
        if (bytes.Length > MaxListBytes) throw new InvalidOutput();
        using Stream output = Console.OpenStandardOutput();
        output.Write(bytes, 0, bytes.Length);
    }

    private static void Synthesize(JsonElement root)
    {
        string voiceId = FieldString(root, "voiceId", 69);
        string locale = FieldString(root, "locale", 48);
        string text = FieldString(root, "text", MaxTextLength).Trim();
        if (!VoiceId.IsMatch(voiceId) || !Locale.IsMatch(locale) || text.Length == 0 || InvalidText(text)) throw new BadInput();
        JsonElement rateProperty = root.GetProperty("rate");
        if (rateProperty.ValueKind != JsonValueKind.Number || !rateProperty.TryGetDouble(out double rate) || !double.IsFinite(rate) || rate < 0.5 || rate > 2) throw new BadInput();
        using SpeechSynthesizer synthesizer = new();
        VoiceEntry? selected = EnabledVoices(synthesizer).SingleOrDefault(entry => entry.VoiceId == voiceId && entry.Locale == locale);
        if (selected is null) throw new MissingVoice();
        try { synthesizer.SelectVoice(selected.Info.Name); } catch (ArgumentException) { throw new MissingVoice(); }
        VoiceInfo actual = synthesizer.Voice;
        if (actual.Id != selected.Info.Id || actual.Name != selected.Info.Name || actual.Culture.Name != selected.Locale) throw new MissingVoice();
        // Provider-specific approximate mapping for the normalized 0.5..2
        // requested rate. It is not a measured duration guarantee.
        synthesizer.Rate = Math.Clamp((int)Math.Round(Math.Log2(rate) * 10.0), -10, 10);
        synthesizer.Volume = 100; // renderer owns per-pet playback volume
        using BoundedWaveStream wav = new(MaxAudioBytes);
        // Speak(string) is plain text. Never call SpeakSsml or default audio
        // output. A WAV target is installed before any synthesis begins.
        synthesizer.SetOutputToWaveStream(wav);
        try { synthesizer.Speak(text); }
        finally { synthesizer.SetOutputToNull(); }
        ReadOnlySpan<byte> bytes = wav.GetBuffer().AsSpan(0, checked((int)wav.Length));
        if (!ValidPcm16Wave(bytes)) throw new InvalidOutput();
        using Stream output = Console.OpenStandardOutput();
        output.Write(bytes);
    }

    private static bool InvalidText(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (char.IsHighSurrogate(ch)) { if (++i >= value.Length || !char.IsLowSurrogate(value[i])) return true; }
            else if (char.IsLowSurrogate(ch) || (char.IsControl(ch) && ch is not ('\r' or '\n' or '\t'))) return true;
        }
        return false;
    }

    // Validate actual produced RIFF metadata and length before writing stdout;
    // the TypeScript boundary parses it again independently.
    private static bool ValidPcm16Wave(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 44 || bytes.Length > MaxAudioBytes || !bytes[..4].SequenceEqual("RIFF"u8)
            || !bytes.Slice(8, 4).SequenceEqual("WAVE"u8) || BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(4, 4)) != bytes.Length - 8) return false;
        int offset = 12, chunks = 0, rate = 0, alignment = 0, pcmBytes = 0;
        bool foundFmt = false, foundData = false;
        while (offset < bytes.Length)
        {
            if (++chunks > 64 || offset > bytes.Length - 8) return false;
            uint size = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(offset + 4, 4));
            int payload = offset + 8;
            long next = (long)payload + size + (size & 1);
            if (next > bytes.Length) return false;
            if (bytes.Slice(offset, 4).SequenceEqual("fmt "u8))
            {
                if (foundFmt || foundData || (size != 16 && size != 18)) return false;
                ushort format = BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(payload, 2));
                ushort channels = BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(payload + 2, 2));
                uint sampleRate = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(payload + 4, 4));
                uint byteRate = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(payload + 8, 4));
                ushort blockAlign = BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(payload + 12, 2));
                ushort bits = BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(payload + 14, 2));
                if (format != 1 || channels is < 1 or > 2 || sampleRate is < 8000 or > 48000 || bits != 16
                    || blockAlign != channels * 2 || byteRate != sampleRate * blockAlign
                    || (size == 18 && BinaryPrimitives.ReadUInt16LittleEndian(bytes.Slice(payload + 16, 2)) != 0)) return false;
                rate = (int)sampleRate; alignment = blockAlign; foundFmt = true;
            }
            else if (bytes.Slice(offset, 4).SequenceEqual("data"u8))
            {
                if (!foundFmt || foundData || size == 0) return false;
                pcmBytes = (int)size; foundData = true;
            }
            offset = (int)next;
        }
        return foundFmt && foundData && alignment > 0 && pcmBytes % alignment == 0
            && (long)pcmBytes <= (long)rate * alignment * 60;
    }

    private sealed class BoundedWaveStream(int maximum) : MemoryStream
    {
        private void EnsureWrite(int count)
        {
            if (count < 0 || Position < 0 || Position + count > maximum) throw new InvalidOutput();
        }
        public override void Write(byte[] buffer, int offset, int count) { EnsureWrite(count); base.Write(buffer, offset, count); }
        public override void Write(ReadOnlySpan<byte> buffer) { EnsureWrite(buffer.Length); base.Write(buffer); }
        public override void WriteByte(byte value) { EnsureWrite(1); base.WriteByte(value); }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) { EnsureWrite(count); return base.WriteAsync(buffer, offset, count, cancellationToken); }
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) { EnsureWrite(buffer.Length); return base.WriteAsync(buffer, cancellationToken); }
        public override void SetLength(long value) { if (value < 0 || value > maximum) throw new InvalidOutput(); base.SetLength(value); }
        public override long Position { get => base.Position; set { if (value < 0 || value > maximum) throw new InvalidOutput(); base.Position = value; } }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long target = checked((origin switch { SeekOrigin.Begin => 0, SeekOrigin.Current => Position, SeekOrigin.End => Length, _ => throw new InvalidOutput() }) + offset);
            if (target < 0 || target > maximum) throw new InvalidOutput();
            return base.Seek(offset, origin);
        }
    }
    private sealed class BadInput : Exception { }
    private sealed class MissingVoice : Exception { }
    private sealed class InvalidOutput : Exception { }
}
