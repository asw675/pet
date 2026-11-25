import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, lstat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectVoiceAudio, MAX_VOICE_AUDIO_BYTES } from '../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceRef, VoiceSttConfig } from '../../../packages/contracts/src/voice.js';
import { LOCAL_WHISPER_MODELS, nodeVoiceFilePort, SAPI_EXECUTABLE, WHISPER_EXECUTABLE } from '../src/app-service/voice/local-assets';
import type { VoiceFilePort, VoiceWorkspace } from '../src/app-service/voice/local-assets';
import { LocalVoiceProviderError, LocalVoiceProviders } from '../src/app-service/voice/local-voice-provider';
import type { LocalVoiceOptions } from '../src/app-service/voice/local-voice-provider';
import type { VoiceProcessObserver, VoiceProcessPort, VoiceProcessSpec } from '../src/app-service/voice/local-process';

const utf8 = new TextEncoder();
const fakeHash = 'a'.repeat(64), helperHash = 'b'.repeat(64);
const pathOptions: LocalVoiceOptions = { bundledRoot: '/trusted-bundle', modelsRoot: '/trusted-models', tempRoot: '/trusted-temp',
  integrity: { whisperCliSha256: fakeHash, sapiHelperSha256: helperHash }, timeoutMs: 1000, killGraceMs: 20 };
const config: VoiceSttConfig = { mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'MULTILINGUAL_BASE', locale: 'zh-CN' };
const ref: VoiceRef = { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: `sapi-${'d'.repeat(64)}`, locale: 'zh-CN', rate: 1.2 };
function wav(sampleRate = 16_000, channels = 1, frames = 160, bits = 16): VoiceAudio {
  const bytes = new Uint8Array(44 + frames * channels * 2), view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => [...value].forEach((letter, i) => { bytes[at + i] = letter.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, bits, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return { bytes, codec: 'wav', sampleRate, channels };
}
const signal = () => new AbortController().signal;
async function settle() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
const caught = <T>(promise: Promise<T>) => promise.then(value => value, error => error);

class FakeWorkspace implements VoiceWorkspace {
  readonly writes: Uint8Array[] = [];
  transcript = utf8.encode('  你好，桌伴！  ');
  readonly writeRecording = vi.fn(async (bytes: Uint8Array) => { this.writes.push(Uint8Array.from(bytes)); });
  readonly checkTranscriptBudget = vi.fn(async (_max: number) => {});
  readonly readTranscript = vi.fn(async (_max: number) => Uint8Array.from(this.transcript));
  readonly dispose = vi.fn(async () => {});
  constructor(readonly directory: string) {}
}
class FakeChild {
  readonly terminate = vi.fn();
  constructor(readonly spec: VoiceProcessSpec, readonly observer: VoiceProcessObserver) {}
  stdout(bytes: Uint8Array | string) { this.observer.stdout(typeof bytes === 'string' ? utf8.encode(bytes) : bytes); }
  stderr(bytes: Uint8Array | string) { this.observer.stderr(typeof bytes === 'string' ? utf8.encode(bytes) : bytes); }
  close(code: number | null = 0) { this.observer.close(code); }
  error() { this.observer.error(); }
}
function harness(overrides: { options?: Partial<LocalVoiceOptions>; platform?: string; arch?: string; verify?: VoiceFilePort['verify'];
  workspace?: (workspace: FakeWorkspace) => void; spawnThrows?: boolean } = {}) {
  const workspaces: FakeWorkspace[] = [], children: FakeChild[] = [];
  const verify = vi.fn(overrides.verify ?? (async (root: string, relative: string, _digest: string, _max: number, _signal: AbortSignal) => join(root, ...relative.split('/'))));
  const createWorkspace = vi.fn(async (root: string, _signal: AbortSignal) => {
    const workspace = new FakeWorkspace(join(root, `job-${workspaces.length + 1}`));
    overrides.workspace?.(workspace); workspaces.push(workspace); return workspace;
  });
  const start = vi.fn((spec: VoiceProcessSpec, observer: VoiceProcessObserver) => {
    if (overrides.spawnThrows) throw new Error('raw private process error');
    const child = new FakeChild(spec, observer); children.push(child); return child;
  });
  const processes: VoiceProcessPort = { start };
  const provider = new LocalVoiceProviders({ ...pathOptions, ...overrides.options }, {
    platform: overrides.platform ?? 'win32', arch: overrides.arch ?? 'x64', files: { verify, createWorkspace }, processes,
  });
  return { provider, verify, createWorkspace, start, workspaces, children };
}
const decodedStdin = (child: FakeChild) => JSON.parse(new TextDecoder().decode(child.spec.stdin));
afterEach(() => vi.useRealTimers());

describe('Pinned local whisper CLI and explicit availability', () => {
  it('reports unsupported builds and absent true artifact digests as unavailable without IO or process fallback', async () => {
    for (const h of [harness({ platform: 'darwin' }), harness({ arch: 'arm64' }), harness({ options: { integrity: {} } })]) {
      expect(h.provider.status('WHISPER_CPP').health).toBe('UNAVAILABLE');
      expect(h.provider.status('WINDOWS_SYSTEM_SPEECH').health).toBe('UNAVAILABLE');
      await expect(h.provider.transcribe(config, wav(), signal())).rejects.toMatchObject({ code: 'unavailable' });
      await expect(h.provider.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
      expect(h.verify).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
    }
  });

  it('probes only exact bundled executable and upstream multilingual model hash, never runs a command during the probe', async () => {
    const h = harness();
    expect(h.provider.status('WHISPER_CPP').health).toBe('UNCONFIGURED');
    await expect(h.provider.probeWhisper('MULTILINGUAL_BASE', signal())).resolves.toMatchObject({ providerId: 'WHISPER_CPP', health: 'READY', requiresNetwork: false, capabilities: ['STT'] });
    expect(h.verify).toHaveBeenNthCalledWith(1, pathOptions.bundledRoot, WHISPER_EXECUTABLE, fakeHash, expect.any(Number), expect.any(AbortSignal));
    expect(h.verify).toHaveBeenNthCalledWith(2, pathOptions.modelsRoot, LOCAL_WHISPER_MODELS.MULTILINGUAL_BASE.file,
      LOCAL_WHISPER_MODELS.MULTILINGUAL_BASE.sha256, LOCAL_WHISPER_MODELS.MULTILINGUAL_BASE.maxBytes, expect.any(AbortSignal));
    expect(h.start).not.toHaveBeenCalled(); expect(h.createWorkspace).not.toHaveBeenCalled();
  });

  it('uses only fixed CPU CLI arguments and isolated fixed recording/result names, returning bounded text after actual close', async () => {
    const h = harness(); const recording = wav();
    const result = h.provider.transcribe(config, recording, signal()); await settle();
    expect(h.children).toHaveLength(1); const child = h.children[0]!;
    expect(child.spec).toEqual({ executable: join(pathOptions.bundledRoot, 'win-x64', 'whisper-cli.exe'), cwd: join(pathOptions.tempRoot, 'job-1'), shell: false, windowsHide: true,
      args: ['-m', join(pathOptions.modelsRoot, 'ggml-base.bin'), '-f', 'input.wav', '-l', 'zh', '-t', '2', '-ng', '-otxt', '-of', 'transcription', '-np', '-nt'] });
    expect(h.workspaces[0]?.writes[0]).toEqual(recording.bytes);
    child.stdout('not used: private transcription diagnostic'); child.stderr('not logged');
    expect(h.workspaces[0]?.readTranscript).not.toHaveBeenCalled(); expect(h.workspaces[0]?.dispose).not.toHaveBeenCalled();
    child.close(); await expect(result).resolves.toEqual({ text: '你好，桌伴！' });
    expect(h.workspaces[0]?.readTranscript).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
    expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce(); expect(h.provider.isBusy).toBe(false);
  });

  it('maps unsupported locale to fixed auto detection and only accepts the allowlisted multilingual model variant', async () => {
    const h = harness();
    const result = h.provider.transcribe({ ...config, modelId: 'MULTILINGUAL_SMALL', locale: 'xx-XX' }, wav(), signal()); await settle();
    expect(h.verify.mock.calls[1]?.slice(0, 4)).toEqual([pathOptions.modelsRoot, 'ggml-small.bin', LOCAL_WHISPER_MODELS.MULTILINGUAL_SMALL.sha256, LOCAL_WHISPER_MODELS.MULTILINGUAL_SMALL.maxBytes]);
    expect(h.children[0]?.spec.args).toContain('auto'); expect(h.children[0]?.spec.args).not.toContain('xx-XX');
    h.children[0]?.close(); await result;
    const invalid = { ...config, modelId: '../../evil.exe' } as unknown as VoiceSttConfig;
    await expect(h.provider.transcribe(invalid, wav(), signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.start).toHaveBeenCalledOnce();
  });

  it('rejects explicit cloud config, arbitrary injected fields and invalid/non-16k/mono recordings before process or files', async () => {
    const h = harness();
    const cloud: VoiceSttConfig = { mode: 'CLOUD', providerId: 'AZURE_FAST_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'consent' } };
    await expect(h.provider.transcribe(cloud, wav(), signal())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(h.provider.transcribe({ ...config, apiKey: 'credential' } as unknown as VoiceSttConfig, wav(), signal())).rejects.toMatchObject({ code: 'unavailable' });
    for (const malformed of [wav(24_000), wav(16_000, 2), wav(16_000, 1, 480001), { ...wav(), bytes: new Uint8Array(10) }]) {
      await expect(h.provider.transcribe(config, malformed, signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    }
    expect(h.verify).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled(); expect(h.createWorkspace).not.toHaveBeenCalled();
  });

  it('fails closed on missing/corrupt assets or an unexpected verification-port redirect', async () => {
    const missing = harness({ verify: async () => { throw new Error('private path'); } });
    await expect(missing.provider.probeWhisper('MULTILINGUAL_BASE', signal())).resolves.toMatchObject({ health: 'UNAVAILABLE' });
    expect(missing.start).not.toHaveBeenCalled();
    const redirected = harness({ verify: async () => '/outside/other.exe' });
    await expect(redirected.provider.transcribe(config, wav(), signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(redirected.start).not.toHaveBeenCalled(); expect(redirected.createWorkspace).not.toHaveBeenCalled();
  });

  it('maps empty recognition, oversized transcript and malformed UTF8 without retry or cloud upload', async () => {
    for (const [output, code] of [[utf8.encode(' \n '), 'no_speech'], [new Uint8Array([0xff]), 'invalid_text'], [new Uint8Array(65537).fill(65), 'invalid_text']] as const) {
      const h = harness({ workspace: workspace => { workspace.transcript = output; } });
      const result = caught(h.provider.transcribe(config, wav(), signal())); await settle(); h.children[0]?.close();
      expect(await result).toMatchObject({ code }); expect(h.start).toHaveBeenCalledOnce(); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    }
  });

  it('converts nonzero/spawn errors to a fixed unavailable error, never exposing raw stderr', async () => {
    const h = harness(); const result = caught(h.provider.transcribe(config, wav(), signal())); await settle();
    h.children[0]?.stderr('private diagnostic and device path'); h.children[0]?.close(7);
    expect(await result).toMatchObject({ code: 'unavailable', message: 'unavailable' }); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    const bad = harness({ spawnThrows: true });
    await expect(bad.provider.transcribe(config, wav(), signal())).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
    expect(bad.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });
});

describe('Local Windows system voice protocol', () => {
  it('lists only strict actual enabled-voice options from fixed JSON stdin, exposes no arbitrary paths', async () => {
    const h = harness(); const result = h.provider.listSystemVoiceOptions(signal()); await settle();
    const child = h.children[0]!;
    expect(child.spec).toMatchObject({ executable: join(pathOptions.bundledRoot, 'win-x64', 'pet-desktop-sapi.exe'), args: [], cwd: join(pathOptions.tempRoot, 'job-1'), shell: false, windowsHide: true });
    expect(decodedStdin(child)).toEqual({ type: 'ENUMERATE' });
    child.stdout(JSON.stringify({ voices: [{ voiceId: ref.voiceId, locale: ref.locale, displayName: '真实系统音色' }] })); child.close();
    expect(await result).toEqual([{ ref: { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: ref.voiceId, locale: ref.locale }, displayName: '真实系统音色' }]);
    expect(h.provider.status('WINDOWS_SYSTEM_SPEECH').health).toBe('READY');
    expect(h.verify).toHaveBeenCalledWith(pathOptions.bundledRoot, SAPI_EXECUTABLE, helperHash, expect.any(Number), expect.any(AbortSignal));
    expect(h.workspaces[0]?.writes).toHaveLength(0); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('does not fabricate default voices: empty real enumeration remains UNCONFIGURED', async () => {
    const h = harness(), result = h.provider.listVoices(); await settle();
    h.children[0]?.stdout('{"voices":[]}'); h.children[0]?.close();
    await expect(result).resolves.toEqual([]); expect(h.provider.status('WINDOWS_SYSTEM_SPEECH').health).toBe('UNCONFIGURED');
  });

  it('rejects duplicate, malformed or extra installed-voice fields from helper stdout', async () => {
    const voice = { voiceId: ref.voiceId, locale: 'zh-CN', displayName: '真实音色' };
    for (const voices of [[voice, voice], [{ ...voice, voiceId: 'arbitrary-name' }], [{ ...voice, path: 'secret' }], [{ ...voice, locale: '../bad' }], [{ ...voice, displayName: '\u202eprivate' }]]) {
      const h = harness(), result = caught(h.provider.listSystemVoiceOptions()); await settle();
      h.children[0]?.stdout(JSON.stringify({ voices })); h.children[0]?.close();
      expect(await result).toMatchObject({ code: 'unavailable' }); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    }
  });

  it('sends only plain bounded text/opaque installed voice identity over stdin, validates actual native WAV format', async () => {
    const h = harness(); const text = '  <speak>这是普通文本</speak>  ';
    const result = h.provider.synthesize(text, ref, signal()); await settle();
    const child = h.children[0]!;
    expect(child.spec.args).toEqual([]);
    expect(decodedStdin(child)).toEqual({ type: 'SYNTHESIZE', voiceId: ref.voiceId, locale: 'zh-CN', rate: 1.2, text: text.trim() });
    const realFormat = wav(22_050, 1, 440);
    child.stdout(realFormat.bytes.subarray(0, 100)); child.stdout(realFormat.bytes.subarray(100)); child.close();
    const response = await result;
    expect(inspectVoiceAudio(response.audio)).toMatchObject({ sampleRate: 22_050, channels: 1, frames: 440 });
    expect(response).not.toHaveProperty('visemes'); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('voice missing, invalid request/output and unavailable helper exits never fall back to a guessed voice', async () => {
    for (const [exit, code] of [[2, 'invalid_text'], [3, 'voice_missing'], [4, 'unavailable'], [5, 'invalid_audio']] as const) {
      const h = harness(), result = caught(h.provider.synthesize('text', ref, signal())); await settle();
      h.children[0]?.close(exit); expect(await result).toMatchObject({ code });
      expect(h.start).toHaveBeenCalledOnce(); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    }
  });

  it('rejects nonlocal/fabricated voice IDs, invalid text and malformed WAV without execution or fake success', async () => {
    const h = harness();
    for (const voice of [{ ...ref, voiceId: 'Microsoft X' }, { ...ref, providerId: 'AZURE_NEURAL_TTS' }, { ...ref, voiceId: 'sapi-../x' }] as VoiceRef[]) {
      await expect(h.provider.synthesize('hello', voice, signal())).rejects.toMatchObject({ code: 'voice_missing' });
    }
    for (const text of ['', ' ', '\u0000x', 'a'.repeat(16385)]) await expect(h.provider.synthesize(text, ref, signal())).rejects.toMatchObject({ code: 'invalid_text' });
    expect(h.start).not.toHaveBeenCalled();
    const invalid = caught(h.provider.synthesize('text', ref, signal())); await settle();
    h.children[0]?.stdout(wav(16_000, 1, 160, 8).bytes); h.children[0]?.close();
    expect(await invalid).toMatchObject({ code: 'invalid_audio' });
  });
});

describe('Local process output limits, cancellation, deadline and single-flight cleanup', () => {
  it('polls the fixed transcript file budget while whisper is running and terminates oversized output', async () => {
    vi.useFakeTimers();
    const h = harness({ workspace: workspace => workspace.checkTranscriptBudget.mockRejectedValue(new LocalVoiceProviderError('invalid_text')) });
    const pending = caught(h.provider.transcribe(config, wav(), signal())); await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.workspaces[0]?.checkTranscriptBudget).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
    expect(h.children[0]?.terminate).toHaveBeenCalledOnce(); expect(h.workspaces[0]?.dispose).not.toHaveBeenCalled();
    h.children[0]?.close(null); expect(await pending).toMatchObject({ code: 'invalid_text' });
    expect(h.workspaces[0]?.readTranscript).not.toHaveBeenCalled(); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('caps stdout and stderr, asks the exact child to terminate and waits for actual close before cleanup', async () => {
    for (const stdout of [true, false]) {
      const h = harness(); const result = caught(h.provider.transcribe(config, wav(), signal())); await settle();
      const child = h.children[0]!;
      if (stdout) child.stdout(new Uint8Array(65537)); else child.stderr(new Uint8Array(65537));
      expect(child.terminate).toHaveBeenCalledOnce(); expect(h.workspaces[0]?.dispose).not.toHaveBeenCalled(); expect(h.provider.isBusy).toBe(true);
      child.close(null); expect(await result).toMatchObject({ code: 'unavailable' }); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    }
  });

  it('bounds binary synthesis stdout to the shared audio limit before retaining extra bytes', async () => {
    const h = harness(), result = caught(h.provider.synthesize('text', ref, signal())); await settle();
    const child = h.children[0]!; child.stdout(new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1));
    expect(child.terminate).toHaveBeenCalledOnce(); child.close(null);
    expect(await result).toMatchObject({ code: 'invalid_audio' }); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('cancels only the current child and keeps the operation lock until real termination', async () => {
    const h = harness(), controller = new AbortController();
    const result = caught(h.provider.transcribe(config, wav(), controller.signal)); await settle(); const child = h.children[0]!;
    await expect(h.provider.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
    controller.abort('raw caller reason should be hidden'); expect(child.terminate).toHaveBeenCalledOnce();
    expect(h.workspaces[0]?.dispose).not.toHaveBeenCalled(); expect(h.provider.isBusy).toBe(true);
    child.close(null); expect(await result).toMatchObject({ code: 'canceled', message: 'canceled' });
    expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce(); expect(h.provider.isBusy).toBe(false);
  });

  it('times out and quarantines an unconfirmed child; only delayed actual close releases its workspace and gate', async () => {
    vi.useFakeTimers();
    const h = harness({ options: { timeoutMs: 100, killGraceMs: 20 } }); const pending = caught(h.provider.transcribe(config, wav(), signal())); await settle();
    const child = h.children[0]!;
    await vi.advanceTimersByTimeAsync(100); expect(child.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20); expect(await pending).toMatchObject({ code: 'timeout' });
    expect(h.provider.isBusy).toBe(true); expect(h.provider.status('WHISPER_CPP').health).toBe('UNAVAILABLE');
    expect(h.workspaces[0]?.dispose).not.toHaveBeenCalled();
    await expect(h.provider.synthesize('next', ref, signal())).rejects.toMatchObject({ code: 'unavailable' }); expect(h.start).toHaveBeenCalledOnce();
    child.close(null); await settle(); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce(); expect(h.provider.isBusy).toBe(false);
  });

  it('pre-aborted requests never spawn; cancellation during asset verify or temporary recording write does not start a process', async () => {
    const pre = harness(), preCancel = new AbortController(); preCancel.abort();
    await expect(pre.provider.transcribe(config, wav(), preCancel.signal)).rejects.toMatchObject({ code: 'canceled' }); expect(pre.verify).not.toHaveBeenCalled();
    const verification = deferred<string>(), canceled = new AbortController();
    const h = harness({ verify: () => verification.promise }); const result = caught(h.provider.transcribe(config, wav(), canceled.signal));
    canceled.abort(); verification.resolve(join(pathOptions.bundledRoot, 'win-x64', 'whisper-cli.exe')); expect(await result).toMatchObject({ code: 'canceled' });
    expect(h.start).not.toHaveBeenCalled(); expect(h.createWorkspace).not.toHaveBeenCalled();
    const write = deferred<void>(), writeCancel = new AbortController();
    const w = harness({ workspace: workspace => workspace.writeRecording.mockReturnValue(write.promise) });
    const written = caught(w.provider.transcribe(config, wav(), writeCancel.signal)); await settle(); writeCancel.abort(); write.resolve();
    expect(await written).toMatchObject({ code: 'canceled' }); expect(w.start).not.toHaveBeenCalled(); expect(w.workspaces[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('process errors are sanitized, disposal cancels only the known service operation and future jobs are unavailable', async () => {
    const h = harness(), result = caught(h.provider.listVoices()); await settle(); h.provider.dispose();
    expect(h.children[0]?.terminate).toHaveBeenCalledOnce(); h.children[0]?.close(null);
    expect(await result).toMatchObject({ code: 'canceled' }); expect(h.workspaces[0]?.dispose).toHaveBeenCalledOnce();
    await expect(h.provider.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
    const errored = harness(), pending = caught(errored.provider.listVoices()); await settle(); errored.children[0]?.error();
    expect(errored.children[0]?.terminate).toHaveBeenCalledOnce(); errored.children[0]?.close(null);
    expect(await pending).toMatchObject({ code: 'unavailable', message: 'unavailable' });
  });

  it('quarantines a cleanup failure rather than accumulating unremoved private temporary recordings', async () => {
    const h = harness({ workspace: workspace => workspace.dispose.mockRejectedValue(new Error('path detail')) });
    const result = caught(h.provider.transcribe(config, wav(), signal())); await settle(); h.children[0]?.close();
    expect(await result).toMatchObject({ code: 'unavailable', message: 'unavailable' }); expect(h.provider.isBusy).toBe(true);
    expect(h.provider.status('WHISPER_CPP').health).toBe('UNAVAILABLE');
    await expect(h.provider.listVoices()).rejects.toMatchObject({ code: 'unavailable' }); expect(h.start).toHaveBeenCalledOnce();
  });
});

describe('Real local filesystem adapter with isolated synthetic bytes (no executable launched)', () => {
  const verifyDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  it('stream-checks exact trusted file bytes, rejects changed hashes/oversize/symlink and traversal', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-voice-test-'));
    try {
      const bundle = join(root, 'win-x64'); await mkdir(bundle);
      const file = join(bundle, 'test.exe'), bytes = new Uint8Array([1, 2, 3, 4]); await writeFile(file, bytes);
      await expect(nodeVoiceFilePort.verify(root, 'win-x64/test.exe', verifyDigest(bytes), 100, signal())).resolves.toBe(file);
      await expect(nodeVoiceFilePort.verify(root, 'win-x64/test.exe', '0'.repeat(64), 100, signal())).rejects.toMatchObject({ code: 'unavailable' });
      await expect(nodeVoiceFilePort.verify(root, 'win-x64/test.exe', verifyDigest(bytes), 2, signal())).rejects.toMatchObject({ code: 'unavailable' });
      await expect(nodeVoiceFilePort.verify(root, '../other.exe', verifyDigest(bytes), 100, signal())).rejects.toMatchObject({ code: 'unavailable' });
      if (process.platform !== 'win32') {
        await symlink(file, join(bundle, 'link.exe'));
        await expect(nodeVoiceFilePort.verify(root, 'win-x64/link.exe', verifyDigest(bytes), 100, signal())).rejects.toMatchObject({ code: 'unavailable' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes one fixed exclusive input, reads only a bounded transcript, and deletes exactly the owned temp directory', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-voice-test-'));
    try {
      const appTemp = join(root, 'voice-temp');
      const workspace = await nodeVoiceFilePort.createWorkspace(appTemp, signal());
      await workspace.writeRecording(wav().bytes, signal());
      await expect(workspace.writeRecording(wav().bytes, signal())).rejects.toBeDefined();
      await expect(workspace.checkTranscriptBudget(2, signal())).resolves.toBeUndefined();
      await writeFile(join(workspace.directory, 'transcription.txt'), utf8.encode('hello'));
      await expect(workspace.checkTranscriptBudget(2, signal())).rejects.toMatchObject({ code: 'invalid_text' });
      expect(new TextDecoder().decode(await workspace.readTranscript(10, signal()))).toBe('hello');
      await expect(workspace.readTranscript(2, signal())).rejects.toMatchObject({ code: 'unavailable' });
      await workspace.dispose(); await workspace.dispose();
      await expect(lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(appTemp)).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
