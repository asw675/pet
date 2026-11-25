# Windows local speech helper (008B-2 source)

This is a single-invocation, Windows x64 System.Speech helper. It consumes one bounded JSON request from stdin (`ENUMERATE` or `SYNTHESIZE`) and returns a bounded installed-voice JSON list or a complete validated PCM16 RIFF WAV on stdout. Synthesis uses an exact installed voice identity and plain `Speak(string)` with a WAV stream output, never SSML or the system audio device. It has no file-path or command-line execution request. Exit codes are closed: `0` success, `2` invalid request/text, `3` missing voice, `4` unavailable, `5` invalid/over-budget output. Audio and text are not logged.

Windows build/restore, SAPI voice enumeration, single-file publication and actual synthesis are **not yet validated**. No runtime binary is included. The intended Windows build is a self-contained x64 `net10.0-windows` publication with pinned `System.Speech` 10.0.0; record the actual output digest, runtime version and dependency/license inventory before the application can execute it. The .NET build is not invoked by current desktop packaging.

Official references consulted 2026-11-25:

- [Microsoft: GetInstalledVoices](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.getinstalledvoices) and [VoiceInfo](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.voiceinfo). Enabled installed voices provide the actual metadata.
- [Microsoft: SelectVoice](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.selectvoice). Name matching has substring behavior; the helper eliminates ambiguous names and checks actual selected voice identity, rather than guessing a name or selecting by hint.
- [Microsoft: SetOutputToWaveStream](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.setoutputtowavestream), [SetOutputToAudioStream](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.setoutputtoaudiostream) and [Rate](https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.rate). WAV output is redirected and bounded; the normalized multiplier maps to System.Speech's finite rate range, not exact timing.
- [.NET single-file publication](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) and [System.Speech 10.0.0 package](https://www.nuget.org/packages/System.Speech/10.0.0).

Installed system voices are not assets bundled by this project. The helper does not download, clone, distribute or substitute them.
