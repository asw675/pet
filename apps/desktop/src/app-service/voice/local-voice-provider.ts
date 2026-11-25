import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_VOICE_AUDIO_BYTES, MAX_VOICE_TEXT_LENGTH, voiceAudioSchema, voiceRecordingAudioSchema, voiceRefSchema,
  voiceSttConfigSchema } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceProviderStatus, VoiceRef, VoiceSttConfig } from '../../../../../packages/contracts/src/voice.js';
import { LOCAL_WHISPER_MODELS, MAX_SAPI_EXECUTABLE_BYTES, MAX_WHISPER_EXECUTABLE_BYTES, RECORDING_FILENAME,
  SAPI_EXECUTABLE, TRANSCRIPT_BASENAME, WHISPER_EXECUTABLE, nodeVoiceFilePort, validVoiceDigest } from './local-assets';
import type { LocalWhisperModelId, VoiceFilePort, VoiceWorkspace } from './local-assets';
import { checkVoiceAbort, LocalVoiceProviderError, nodeVoiceProcessPort, runBoundedVoiceProcess, UnconfirmedVoiceExit, voiceAbortError } from './local-process';
import type { VoiceProcessLimits, VoiceProcessPort, VoiceProcessResult, VoiceProcessSpec } from './local-process';

export { LocalVoiceProviderError } from './local-process';

const MAX_TEXT_BYTES = MAX_VOICE_TEXT_LENGTH * 4;
const MAX_HELPER_INPUT_BYTES = 128 * 1024;
const MAX_VOICE_LIST_BYTES = 128 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_WHISPER_STDOUT_BYTES = 64 * 1024;
const systemVoiceId = /^sapi-[0-9a-f]{64}$/u;

export interface LocalVoicePaths {
  /** Supplied by trusted host startup, never renderer settings or a command. */
  readonly bundledRoot: string;
  readonly modelsRoot: string;
  readonly tempRoot: string;
}
export interface LocalVoiceIntegrity {
  /** Actual build/release digests are required. No artifact hash is invented. */
  readonly whisperCliSha256?: string;
  readonly sapiHelperSha256?: string;
}
export interface LocalVoiceOptions extends LocalVoicePaths {
  readonly integrity: LocalVoiceIntegrity;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}
export interface LocalVoiceDependencies {
  readonly platform: string;
  readonly arch: string;
  readonly files: VoiceFilePort;
  readonly processes: VoiceProcessPort;
}
export interface InstalledSystemVoice {
  readonly ref: VoiceRef;
  readonly displayName: string;
}
type LocalProviderId = 'WHISPER_CPP' | 'WINDOWS_SYSTEM_SPEECH';
type Health = VoiceProviderStatus['health'];

interface Operation {
  readonly signal: AbortSignal;
  workspace(): Promise<VoiceWorkspace>;
  watchTranscript(maxBytes: number): () => void;
  execute(executable: string, args: readonly string[], limits: Omit<VoiceProcessLimits, 'killGraceMs'>, stdin?: Uint8Array): Promise<VoiceProcessResult>;
}

const localeLanguage = new Set(['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar', 'hi', 'vi', 'th', 'id', 'ms', 'nl', 'pl', 'uk', 'tr', 'sv', 'da', 'fi', 'no', 'he']);
function whisperLanguage(locale: string | undefined): string {
  const language = locale?.split('-', 1)[0]?.toLowerCase();
  // Always a fixed authored whisper language or auto detection, never an
  // arbitrary caller-supplied string, filename or command-line flag.
  return language && localeLanguage.has(language) ? language : 'auto';
}
function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new LocalVoiceProviderError('invalid_text'); }
}
function plainText(text: unknown): string {
  if (typeof text !== 'string' || text.length > MAX_VOICE_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(text)) {
    throw new LocalVoiceProviderError('invalid_text');
  }
  const value = text.trim();
  if (!value || new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) throw new LocalVoiceProviderError('invalid_text');
  return value;
}

const voiceListSchema = z.strictObject({ voices: z.array(z.strictObject({
  voiceId: z.string().regex(systemVoiceId), locale: z.string().min(2).max(48),
  displayName: z.string().min(1).max(240).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)),
})).max(128) });

function parseInstalledVoices(bytes: Uint8Array): InstalledSystemVoice[] {
  let raw: unknown;
  try { raw = JSON.parse(decodeUtf8(bytes)); } catch { throw new LocalVoiceProviderError('unavailable'); }
  const parsed = voiceListSchema.safeParse(raw);
  if (!parsed.success) throw new LocalVoiceProviderError('unavailable');
  const seen = new Set<string>();
  return parsed.data.voices.map(entry => {
    const ref = voiceRefSchema.safeParse({ providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: entry.voiceId, locale: entry.locale });
    if (!ref.success || seen.has(entry.voiceId)) throw new LocalVoiceProviderError('unavailable');
    seen.add(entry.voiceId);
    return { ref: ref.data, displayName: entry.displayName };
  });
}

/** Obtain actual system output metadata from the bounded RIFF container and
 * then apply the same strict PCM16/audio-duration contract used by playback. */
function parseSystemWave(bytes: Uint8Array<ArrayBuffer>): VoiceAudio {
  const fail = () => { throw new LocalVoiceProviderError('invalid_audio'); };
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_VOICE_AUDIO_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, key: string) => [...key].every((value, i) => bytes[offset + i] === value.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || view.getUint32(4, true) !== bytes.byteLength - 8) return fail();
  let offset = 12;
  for (let chunks = 0; offset <= bytes.byteLength - 8 && chunks < 64; chunks++) {
    const size = view.getUint32(offset + 4, true), payload = offset + 8, next = payload + size + (size & 1);
    if (next > bytes.byteLength) return fail();
    if (tag(offset, 'fmt ')) {
      if (size < 16) return fail();
      const parsed = voiceAudioSchema.safeParse({ bytes, codec: 'wav', sampleRate: view.getUint32(payload + 4, true), channels: view.getUint16(payload + 2, true) });
      if (!parsed.success) return fail();
      return parsed.data;
    }
    offset = next;
  }
  return fail();
}

function helperExit(code: number): void {
  switch (code) {
    case 0: return;
    case 2: throw new LocalVoiceProviderError('invalid_text');
    case 3: throw new LocalVoiceProviderError('voice_missing');
    case 5: throw new LocalVoiceProviderError('invalid_audio');
    default: throw new LocalVoiceProviderError('unavailable');
  }
}
function helperInput(request: object): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  if (bytes.byteLength > MAX_HELPER_INPUT_BYTES) throw new LocalVoiceProviderError('invalid_text');
  return bytes;
}

/** Windows-only local speech provider set for the trusted service. One
 * instance per application coordinates both CLI/voice-list/synthesis calls;
 * no concurrent children or arbitrary execution surface. */
export class LocalVoiceProviders {
  private readonly deps: LocalVoiceDependencies;
  private readonly option: Readonly<LocalVoiceOptions>;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly supported: boolean;
  private whisperHealth: Health;
  private systemHealth: Health;
  private busy = false;
  private quarantined = false;
  private disposed = false;
  private activeAbort: AbortController | null = null;

  constructor(options: LocalVoiceOptions, dependencies: Partial<LocalVoiceDependencies> = {}) {
    this.deps = { platform: process.platform, arch: process.arch, files: nodeVoiceFilePort, processes: nodeVoiceProcessPort, ...dependencies };
    this.option = Object.freeze({ ...options, integrity: Object.freeze({ ...options.integrity }) });
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.killGraceMs = options.killGraceMs ?? 2000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000
      || !Number.isSafeInteger(this.killGraceMs) || this.killGraceMs < 1 || this.killGraceMs > 5000) throw new RangeError('Invalid local voice limits');
    this.supported = this.deps.platform === 'win32' && this.deps.arch === 'x64'
      && [options.bundledRoot, options.modelsRoot, options.tempRoot].every(value => typeof value === 'string' && isAbsolute(value));
    this.whisperHealth = this.supported && validVoiceDigest(this.option.integrity.whisperCliSha256) ? 'UNCONFIGURED' : 'UNAVAILABLE';
    this.systemHealth = this.supported && validVoiceDigest(this.option.integrity.sapiHelperSha256) ? 'UNCONFIGURED' : 'UNAVAILABLE';
  }

  status(providerId: LocalProviderId): VoiceProviderStatus {
    return providerId === 'WHISPER_CPP'
      ? { providerId, requiresNetwork: false, health: this.disposed || this.quarantined ? 'UNAVAILABLE' : this.whisperHealth, capabilities: ['STT'] }
      : { providerId, requiresNetwork: false, health: this.disposed || this.quarantined ? 'UNAVAILABLE' : this.systemHealth, capabilities: ['TTS'] };
  }
  get isBusy(): boolean { return this.busy; }
  /** Abort only this known operation; its returned result/cleanup observes
   * actual process close. No retry/fallback and no global process scanning. */
  dispose(): void { this.disposed = true; this.activeAbort?.abort(new LocalVoiceProviderError('canceled')); }

  async probeWhisper(modelId: LocalWhisperModelId, signal: AbortSignal): Promise<VoiceProviderStatus> {
    try { await this.operation('WHISPER_CPP', signal, async run => { await this.whisperAssets(modelId, run.signal); }); }
    catch (error) {
      if (error instanceof LocalVoiceProviderError && (error.code === 'canceled' || error.code === 'timeout')) throw error;
      this.whisperHealth = 'UNAVAILABLE';
    }
    return this.status('WHISPER_CPP');
  }

  async transcribe(rawConfig: VoiceSttConfig, rawAudio: VoiceAudio, signal: AbortSignal): Promise<{ text: string }> {
    const config = voiceSttConfigSchema.safeParse(rawConfig);
    if (!config.success || config.data.mode !== 'LOCAL') throw new LocalVoiceProviderError('unavailable');
    const localConfig = config.data;
    const parsed = voiceRecordingAudioSchema.safeParse(rawAudio);
    if (!parsed.success) throw new LocalVoiceProviderError('invalid_audio');
    // Own the bounded recording even if an upstream caller later mutates it.
    const bytes = Uint8Array.from(parsed.data.bytes);
    try {
      return await this.operation('WHISPER_CPP', signal, async run => {
        const assets = await this.whisperAssets(localConfig.modelId, run.signal);
        const workspace = await run.workspace();
        await workspace.writeRecording(bytes, run.signal);
        checkVoiceAbort(run.signal);
        const stopBudgetWatch = run.watchTranscript(MAX_TEXT_BYTES);
        let result: VoiceProcessResult;
        try {
          result = await run.execute(assets.executable, [
            '-m', assets.model, '-f', RECORDING_FILENAME, '-l', whisperLanguage(localConfig.locale), '-t', '2',
            '-ng', '-otxt', '-of', TRANSCRIPT_BASENAME, '-np', '-nt',
          ], { maxStdoutBytes: MAX_WHISPER_STDOUT_BYTES, maxStderrBytes: MAX_DIAGNOSTIC_BYTES, retainStdout: false, overflowCode: 'unavailable' });
        } finally { stopBudgetWatch(); }
        if (result.code !== 0) throw new LocalVoiceProviderError('unavailable');
        const output = await workspace.readTranscript(MAX_TEXT_BYTES, run.signal);
        if (!(output instanceof Uint8Array) || output.byteLength > MAX_TEXT_BYTES) throw new LocalVoiceProviderError('invalid_text');
        const transcript = decodeUtf8(output).trim();
        if (!transcript) throw new LocalVoiceProviderError('no_speech');
        this.whisperHealth = 'READY';
        return { text: plainText(transcript) };
      });
    } finally { bytes.fill(0); }
  }

  async listSystemVoiceOptions(signal: AbortSignal = new AbortController().signal): Promise<InstalledSystemVoice[]> {
    return this.operation('WINDOWS_SYSTEM_SPEECH', signal, async run => {
      const executable = await this.sapiAsset(run.signal);
      const result = await run.execute(executable, [], { maxStdoutBytes: MAX_VOICE_LIST_BYTES, maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
        retainStdout: true, overflowCode: 'unavailable' }, helperInput({ type: 'ENUMERATE' }));
      helperExit(result.code);
      const voices = parseInstalledVoices(result.stdout);
      // A valid empty installed-voice list is not an invented default sound.
      this.systemHealth = voices.length > 0 ? 'READY' : 'UNCONFIGURED';
      return voices;
    });
  }
  async listVoices(signal?: AbortSignal): Promise<VoiceRef[]> {
    return (await this.listSystemVoiceOptions(signal)).map(voice => voice.ref);
  }

  async synthesize(text: string, rawVoice: VoiceRef, signal: AbortSignal): Promise<{ audio: VoiceAudio }> {
    const normalized = plainText(text);
    const voice = voiceRefSchema.safeParse(rawVoice);
    if (!voice.success || voice.data.providerId !== 'WINDOWS_SYSTEM_SPEECH' || !systemVoiceId.test(voice.data.voiceId)) {
      throw new LocalVoiceProviderError('voice_missing');
    }
    const input = helperInput({ type: 'SYNTHESIZE', voiceId: voice.data.voiceId, locale: voice.data.locale, rate: voice.data.rate ?? 1, text: normalized });
    return this.operation('WINDOWS_SYSTEM_SPEECH', signal, async run => {
      const executable = await this.sapiAsset(run.signal);
      // JSON stdin only; no user text/voice name/path in args. The fixed
      // helper re-enumerates enabled installed voices and checks exact ID.
      const result = await run.execute(executable, [], { maxStdoutBytes: MAX_VOICE_AUDIO_BYTES, maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
        retainStdout: true, overflowCode: 'invalid_audio' }, input);
      helperExit(result.code);
      const audio = parseSystemWave(result.stdout);
      this.systemHealth = 'READY';
      return { audio }; // never played in the service or helper; no viseme claim
    });
  }

  private async whisperAssets(modelId: LocalWhisperModelId, signal: AbortSignal): Promise<{ executable: string; model: string }> {
    const digest = this.option.integrity.whisperCliSha256;
    if (!validVoiceDigest(digest) || !Object.hasOwn(LOCAL_WHISPER_MODELS, modelId)) throw new LocalVoiceProviderError('unavailable');
    const selected = LOCAL_WHISPER_MODELS[modelId];
    const executable = await this.verified(this.option.bundledRoot, WHISPER_EXECUTABLE, digest, MAX_WHISPER_EXECUTABLE_BYTES, signal);
    const model = await this.verified(this.option.modelsRoot, selected.file, selected.sha256, selected.maxBytes, signal);
    this.whisperHealth = 'READY'; // verified local package/model; real performance is POC
    return { executable, model };
  }
  private async sapiAsset(signal: AbortSignal): Promise<string> {
    const digest = this.option.integrity.sapiHelperSha256;
    if (!validVoiceDigest(digest)) throw new LocalVoiceProviderError('unavailable');
    return this.verified(this.option.bundledRoot, SAPI_EXECUTABLE, digest, MAX_SAPI_EXECUTABLE_BYTES, signal);
  }
  private async verified(root: string, relativeName: string, digest: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    const path = await this.deps.files.verify(root, relativeName, digest, maxBytes, signal);
    const expected = join(root, ...relativeName.split('/'));
    // Even an injected verification port cannot silently redirect dispatch to
    // an alternate executable/model. Only the fixed path under its root.
    if (path.toLowerCase() !== expected.toLowerCase() || !isAbsolute(path)) throw new LocalVoiceProviderError('unavailable');
    checkVoiceAbort(signal);
    return path;
  }

  private async operation<T>(id: LocalProviderId, external: AbortSignal, work: (operation: Operation) => Promise<T>): Promise<T> {
    checkVoiceAbort(external);
    if (this.disposed || !this.supported || this.busy) throw new LocalVoiceProviderError('unavailable');
    const digest = id === 'WHISPER_CPP' ? this.option.integrity.whisperCliSha256 : this.option.integrity.sapiHelperSha256;
    if (!validVoiceDigest(digest)) throw new LocalVoiceProviderError('unavailable');
    this.busy = true;
    const controller = new AbortController(); this.activeAbort = controller;
    const abort = () => controller.abort(new LocalVoiceProviderError('canceled'));
    external.addEventListener('abort', abort, { once: true });
    if (external.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new LocalVoiceProviderError('timeout')), this.timeoutMs);
    let workspace: VoiceWorkspace | undefined;
    let deferredClose: Promise<void> | undefined;
    const getWorkspace = async () => {
      checkVoiceAbort(controller.signal);
      workspace ??= await this.deps.files.createWorkspace(this.option.tempRoot, controller.signal);
      if (!isAbsolute(workspace.directory) || dirname(resolve(workspace.directory)).toLowerCase() !== resolve(this.option.tempRoot).toLowerCase()
        || !/^job-[A-Za-z0-9]+$/u.test(basename(workspace.directory))) throw new LocalVoiceProviderError('unavailable');
      checkVoiceAbort(controller.signal);
      return workspace;
    };
    const release = async () => {
      // A filesystem cleanup failure leaves the runtime quarantined rather
      // than retaining undetected private recordings and starting more jobs.
      try { await workspace?.dispose(); }
      catch { this.quarantined = true; throw new LocalVoiceProviderError('unavailable'); }
      this.busy = false;
      this.quarantined = false;
    };
    const operation: Operation = {
      signal: controller.signal, workspace: getWorkspace,
      watchTranscript: maxBytes => {
        // Bound retained transcript reads even after real child close;
        // monitor the fixed result during execution as an additional
        // safety check. This is not an OS-level file quota.
        let watching = true, checking = false;
        const timer = setInterval(() => {
          const temp = workspace;
          if (!watching || checking || !temp || controller.signal.aborted) return;
          checking = true;
          void temp.checkTranscriptBudget(maxBytes, controller.signal).catch(error => {
            if (watching && !controller.signal.aborted) controller.abort(error instanceof LocalVoiceProviderError ? error : new LocalVoiceProviderError('unavailable'));
          }).finally(() => { checking = false; });
        }, 100);
        return () => { watching = false; clearInterval(timer); };
      },
      execute: async (executable, args, limits, stdin) => {
        const temp = await getWorkspace(); checkVoiceAbort(controller.signal);
        const spec: VoiceProcessSpec = { executable, args: Object.freeze([...args]), cwd: temp.directory, shell: false, windowsHide: true,
          ...(stdin === undefined ? {} : { stdin }) };
        return runBoundedVoiceProcess(this.deps.processes, spec, { ...limits, killGraceMs: this.killGraceMs }, controller.signal);
      },
    };
    try {
      const result = await work(operation);
      checkVoiceAbort(controller.signal);
      return result;
    } catch (error) {
      if (error instanceof UnconfirmedVoiceExit) { this.quarantined = true; deferredClose = error.closed; throw error; }
      const failure = controller.signal.aborted ? voiceAbortError(controller.signal)
        : error instanceof LocalVoiceProviderError ? error : new LocalVoiceProviderError('unavailable');
      if (failure.code === 'unavailable') {
        if (id === 'WHISPER_CPP') this.whisperHealth = 'UNAVAILABLE'; else this.systemHealth = 'UNAVAILABLE';
      }
      throw failure;
    } finally {
      clearTimeout(timeout); external.removeEventListener('abort', abort); this.activeAbort = null;
      if (deferredClose) {
        // Keep the single-flight lock and isolated directory until the OS
        // really reports close. There is no fake cleanup/second invocation.
        void deferredClose.then(release).catch(() => { /* quarantined */ });
      } else await release();
    }
  }
}
