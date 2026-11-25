import { aiLimits } from '@pet-desktop/contracts/ai';
import { inspectVoiceAudio, voiceErrorCodeSchema, voiceEventSchema, voiceProviderStatusSchema } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceErrorCode, VoiceProviderStatus, VoiceRef, VoiceSttConfig, VoiceViseme } from '../../../../../packages/contracts/src/voice.js';
import { sameVoiceJob, voiceAuthorityConfigSchema, voiceOwnedJobSchema, voiceServiceRequestSchema, voiceServiceResultSchema, voiceTranscriptSchema } from '../../shared/voice-ipc';
import type { VoiceAuthorityConfig, VoiceOwnedJob, VoiceScope, VoiceServiceRequest, VoiceServiceResult, VoiceStatusProjection } from '../../shared/voice-ipc';
import type { LocalWhisperModelId } from './local-assets';
import { LocalVoiceProviderError } from './local-voice-provider';

export interface CompletedVoiceReply {
  readonly petId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly text: string;
}
export interface VoiceAuthorityPort {
  /** Synchronous, short authority read/transaction. Validate pet and
   * conversation existence/ownership and return durable settings revision. */
  readConfig(scope: VoiceScope): VoiceAuthorityConfig | null;
  /** Return only the already committed completed assistant reply for this
   * exact request/pet/conversation. Never use text supplied by the renderer. */
  completedAssistantText(job: VoiceOwnedJob): CompletedVoiceReply | null;
}
export interface VoiceLocalProviderPort {
  readonly isBusy: boolean;
  status(providerId: 'WHISPER_CPP' | 'WINDOWS_SYSTEM_SPEECH'): VoiceProviderStatus;
  probeWhisper(modelId: LocalWhisperModelId, signal: AbortSignal): Promise<VoiceProviderStatus>;
  transcribe(config: VoiceSttConfig, audio: VoiceAudio, signal: AbortSignal): Promise<{ text: string }>;
  synthesize(text: string, voice: VoiceRef, signal: AbortSignal): Promise<{ audio: VoiceAudio; visemes?: VoiceViseme[] }>;
  dispose(): void;
}
export interface VoiceServiceOptions {
  readonly authority: VoiceAuthorityPort;
  /** Actual integration supplies one LocalVoiceProviders instance. Tests can
   * inject a closed port without executable/audio/network access. */
  readonly providers: VoiceLocalProviderPort;
  readonly providerTimeoutMs?: number;
}

interface Turn {
  readonly job: VoiceOwnedJob;
  readonly authority: VoiceAuthorityConfig;
  phase: 'RECORDING' | 'TRANSCRIBING' | 'CHAT_WAIT' | 'TTS_PENDING' | 'PLAYBACK_READY';
}
interface InFlight {
  readonly job: VoiceOwnedJob | null;
  readonly controller: AbortController;
}

function errorResult(code: VoiceErrorCode, job?: VoiceOwnedJob): VoiceServiceResult {
  return { ok: false, kind: 'error', code, ...(job === undefined ? {} : { job }) };
}
function providerError(error: unknown): VoiceErrorCode {
  if (error instanceof LocalVoiceProviderError) return error.code;
  const code = error !== null && typeof error === 'object' && 'code' in error ? voiceErrorCodeSchema.safeParse(error.code) : null;
  return code?.success ? code.data : 'unavailable';
}
function sameConfig(a: VoiceAuthorityConfig, b: VoiceAuthorityConfig): boolean {
  return a.configRevision === b.configRevision && JSON.stringify(a.config) === JSON.stringify(b.config);
}
function sameReply(job: VoiceOwnedJob, reply: CompletedVoiceReply): boolean {
  return reply.petId === job.petId && reply.conversationId === job.conversationId && reply.requestId === job.requestId;
}

/** Caller receives a bounded cancellation result even if a provider ignores
 * AbortSignal. The independent in-flight gate remains occupied until that
 * promise settles (the real provider also guards actual process close). */
function waitCancelable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback();
    };
    const abort = () => finish(() => reject(signal.reason instanceof LocalVoiceProviderError ? signal.reason : new LocalVoiceProviderError('canceled')));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

/** The trusted utility-process voice owner. One reserved voice turn and one
 * in-flight provider (including a draining canceled task) for the whole app.
 * Renderer timestamps/playback/microphone remain outside SQLite; no async
 * transaction or model callback ever holds the authority lock. */
export class VoiceService {
  private readonly timeoutMs: number;
  private latestGeneration = 0;
  private lastJob: VoiceOwnedJob | null = null;
  private active: Turn | null = null;
  private inFlight: InFlight | null = null;
  private probedModel: LocalWhisperModelId | null = null;
  private closed = false;

  constructor(private readonly options: VoiceServiceOptions) {
    this.timeoutMs = options.providerTimeoutMs ?? 125_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) throw new RangeError('Invalid voice service limits');
  }

  async handle(raw: unknown): Promise<VoiceServiceResult> {
    const parsed = voiceServiceRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const candidate = raw !== null && typeof raw === 'object' && 'job' in raw ? voiceOwnedJobSchema.safeParse(raw.job) : null;
      const invalidAudio = raw !== null && typeof raw === 'object' && 'kind' in raw && raw.kind === 'transcribe';
      return errorResult(invalidAudio ? 'invalid_audio' : 'unavailable', candidate?.success ? candidate.data : undefined);
    }
    const request = parsed.data;
    const job = request.kind === 'status' ? undefined : request.job;
    if (this.closed) return errorResult('unavailable', job);
    try {
      let result: VoiceServiceResult;
      switch (request.kind) {
        case 'status': result = await this.status(request.scope, request.probe); break;
        case 'begin': result = this.begin(request.job, request.expectedConfigRevision); break;
        case 'transcribe': result = await this.transcribe(request.job, request.audio); break;
        case 'synthesize': result = await this.synthesize(request.job); break;
        case 'finish': result = this.finish(request.job); break;
        case 'cancel': result = { ok: true, kind: 'closed', job: request.job, changed: this.cancel(request.job) }; break;
      }
      const safe = voiceServiceResultSchema.safeParse(result);
      if (!safe.success) { if (job) this.cancel(job); return errorResult('unavailable', job); }
      return safe.data;
    } catch (error) {
      return errorResult(providerError(error), job);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = null;
    this.inFlight?.controller.abort(new LocalVoiceProviderError('canceled'));
    try { this.options.providers.dispose(); } catch { /* fail closed */ }
  }

  private authority(scope: VoiceScope): VoiceAuthorityConfig | null {
    try {
      const parsed = voiceAuthorityConfigSchema.safeParse(this.options.authority.readConfig({ petId: scope.petId, conversationId: scope.conversationId }));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
  private localStatus(providerId: 'WHISPER_CPP' | 'WINDOWS_SYSTEM_SPEECH'): VoiceProviderStatus {
    try {
      const parsed = voiceProviderStatusSchema.safeParse(this.options.providers.status(providerId));
      if (parsed.success && parsed.data.providerId === providerId) return parsed.data;
    } catch { /* closed status */ }
    return { providerId, requiresNetwork: false, health: 'UNAVAILABLE', capabilities: [providerId === 'WHISPER_CPP' ? 'STT' : 'TTS'] };
  }
  private sttStatus(authority: VoiceAuthorityConfig): VoiceProviderStatus {
    const config = authority.config.stt;
    if (config.mode === 'CLOUD') return { providerId: config.providerId, requiresNetwork: true, health: 'UNAVAILABLE', capabilities: ['STT'] };
    const local = this.localStatus('WHISPER_CPP');
    // A probe for base cannot establish the presence of the small model.
    return local.health === 'READY' && this.probedModel !== config.modelId ? { ...local, health: 'UNCONFIGURED' } : local;
  }
  private canBegin(authority: VoiceAuthorityConfig): boolean {
    return !this.closed && authority.config.stt.mode === 'LOCAL' && this.sttStatus(authority).health === 'READY';
  }
  private providerBusy(): boolean {
    try { return this.inFlight !== null || this.options.providers.isBusy; }
    catch { return true; }
  }

  private async status(scope: VoiceScope, probe: boolean): Promise<VoiceServiceResult> {
    let authority = this.authority(scope);
    if (!authority) return errorResult('unavailable');
    if (probe && authority.config.stt.mode === 'LOCAL' && !this.active && !this.providerBusy()) {
      const model = authority.config.stt.modelId;
      try {
        const result = await this.runProvider(null, signal => this.options.providers.probeWhisper(model, signal));
        const parsed = voiceProviderStatusSchema.safeParse(result);
        this.probedModel = parsed.success && parsed.data.providerId === 'WHISPER_CPP' && parsed.data.health === 'READY' ? model : null;
      } catch { this.probedModel = null; }
      // Re-read after asynchronous asset inspection, never publish an old
      // settings revision/config if the user changed it during the probe.
      authority = this.authority(scope);
      if (!authority || this.closed) return errorResult('unavailable');
    }
    const ttsConfig = authority.config.tts;
    const tts: VoiceProviderStatus | null = ttsConfig.mode === 'DISABLED' ? null : ttsConfig.mode === 'LOCAL' ? this.localStatus('WINDOWS_SYSTEM_SPEECH')
      : { providerId: ttsConfig.voice.providerId, requiresNetwork: true, health: 'UNAVAILABLE', capabilities: ['TTS'] };
    const projection: VoiceStatusProjection = { ...authority, scope, latestGeneration: this.latestGeneration,
      stt: this.sttStatus(authority), tts, canBegin: this.canBegin(authority), busy: this.active !== null || this.providerBusy() };
    return { ok: true, kind: 'status', status: projection };
  }

  private begin(job: VoiceOwnedJob, expectedConfigRevision: number): VoiceServiceResult {
    if (job.generation <= this.latestGeneration || (this.lastJob && (this.lastJob.requestId === job.requestId || this.lastJob.turnId === job.turnId))) return errorResult('canceled', job);
    const authority = this.authority(job);
    if (!authority || authority.configRevision !== expectedConfigRevision || !this.canBegin(authority)) return errorResult('unavailable', job);
    // Reusing a previously committed request ID cannot replay its historical
    // reply as a new synthesized voice turn even with a higher generation.
    if (this.options.authority.completedAssistantText(job)) return errorResult('canceled', job);
    // Reserve only after the new context has been authorized. Old invalid
    // requests cannot interrupt a valid current voice turn.
    if (this.active) this.cancel(this.active.job);
    this.latestGeneration = job.generation;
    this.lastJob = job;
    this.active = { job, authority, phase: 'RECORDING' };
    return { ok: true, kind: 'begun', job, configRevision: authority.configRevision };
  }

  private turn(job: VoiceOwnedJob, phase: Turn['phase']): Turn | null {
    return this.active && sameVoiceJob(this.active.job, job) && this.active.phase === phase ? this.active : null;
  }
  private isCurrent(turn: Turn): boolean { return !this.closed && this.active === turn; }
  private stillAuthorized(turn: Turn): boolean {
    const authority = this.authority(turn.job);
    return authority !== null && sameConfig(authority, turn.authority);
  }
  private finish(job: VoiceOwnedJob): VoiceServiceResult {
    const active = this.active;
    if (!active || !sameVoiceJob(active.job, job)) return { ok: true, kind: 'closed', job, changed: false };
    if (active.phase !== 'CHAT_WAIT' && active.phase !== 'PLAYBACK_READY') return errorResult('unavailable', job);
    this.active = null;
    return { ok: true, kind: 'closed', job, changed: true };
  }
  private cancel(job: VoiceOwnedJob): boolean {
    if (!this.active || !sameVoiceJob(this.active.job, job)) return false;
    // Invalidate before notifying the provider. A late completion can't make
    // the previous pet's transcript/audio visible in a new turn.
    this.active = null;
    if (this.inFlight?.job && sameVoiceJob(this.inFlight.job, job)) this.inFlight.controller.abort(new LocalVoiceProviderError('canceled'));
    return true;
  }

  private async transcribe(job: VoiceOwnedJob, audio: VoiceAudio): Promise<VoiceServiceResult> {
    const turn = this.turn(job, 'RECORDING');
    if (!turn) return errorResult('canceled', job);
    const config = turn.authority.config;
    if (!this.stillAuthorized(turn) || config.stt.mode !== 'LOCAL' || this.providerBusy()) { this.cancel(job); return errorResult('unavailable', job); }
    if (inspectVoiceAudio(audio).durationMs > config.maxRecordingMs) { this.cancel(job); return errorResult('invalid_audio', job); }
    turn.phase = 'TRANSCRIBING';
    // The service does not retain raw audio in turn state or log it. Give
    // only this bounded copy to the provider and clear after its own settle.
    const bytes = Uint8Array.from(audio.bytes);
    let used = false;
    try {
      const result = await this.runProvider(job, async signal => {
        used = true;
        try { return await this.options.providers.transcribe(config.stt, { ...audio, bytes }, signal); }
        finally { bytes.fill(0); }
      });
      if (!this.isCurrent(turn)) return errorResult('canceled', job);
      if (!this.stillAuthorized(turn)) { this.cancel(job); return errorResult('unavailable', job); }
      if (typeof result.text !== 'string' || result.text.trim().length === 0) { this.cancel(job); return errorResult('no_speech', job); }
      const text = voiceTranscriptSchema.safeParse(result.text.trim());
      if (!text.success) { this.cancel(job); return errorResult('invalid_text', job); }
      turn.phase = 'CHAT_WAIT';
      return { ok: true, kind: 'transcribed', job, text: text.data };
    } catch (error) {
      if (this.isCurrent(turn)) this.cancel(job);
      return errorResult(providerError(error), job);
    } finally { if (!used) bytes.fill(0); }
  }

  private async synthesize(job: VoiceOwnedJob): Promise<VoiceServiceResult> {
    const turn = this.turn(job, 'CHAT_WAIT');
    if (!turn) return errorResult('canceled', job);
    const config = turn.authority.config;
    if (!this.stillAuthorized(turn) || config.muted || config.volume === 0 || config.tts.mode !== 'LOCAL' || this.providerBusy()) {
      this.cancel(job); return errorResult('unavailable', job);
    }
    let reply: CompletedVoiceReply | null = null;
    try { reply = this.options.authority.completedAssistantText(job); } catch { /* no arbitrary reply fallback */ }
    if (!reply || !sameReply(job, reply) || typeof reply.text !== 'string' || reply.text.trim().length === 0 || reply.text.length > aiLimits.replyText) {
      this.cancel(job); return errorResult('invalid_text', job);
    }
    const voice = config.tts.voice, text = reply.text;
    turn.phase = 'TTS_PENDING';
    try {
      const result = await this.runProvider(job, signal => this.options.providers.synthesize(text, voice, signal));
      if (!this.isCurrent(turn)) return errorResult('canceled', job);
      if (!this.stillAuthorized(turn)) { this.cancel(job); return errorResult('unavailable', job); }
      // A completed reply may be redacted while the external provider is
      // synthesizing. Re-read the exact committed assistant identity/text
      // before publishing any WAV, never play the now-deleted reply.
      let latest: CompletedVoiceReply | null = null;
      try { latest = this.options.authority.completedAssistantText(job); } catch { /* fail closed */ }
      if (!latest || !sameReply(job, latest) || latest.text !== text) {
        if (result.audio?.bytes instanceof Uint8Array) result.audio.bytes.fill(0);
        this.cancel(job); return errorResult('invalid_text', job);
      }
      const validated = voiceEventSchema.safeParse({ type: 'TTS_DONE', job, audio: result.audio,
        ...(result.visemes === undefined ? {} : { visemes: result.visemes }) });
      if (!validated.success || validated.data.type !== 'TTS_DONE') { this.cancel(job); return errorResult('invalid_audio', job); }
      const audio = { ...validated.data.audio, bytes: Uint8Array.from(validated.data.audio.bytes) };
      turn.phase = 'PLAYBACK_READY';
      return { ok: true, kind: 'synthesized', job, audio, ...(validated.data.visemes === undefined ? {} : { visemes: validated.data.visemes }) };
    } catch (error) {
      if (this.isCurrent(turn)) this.cancel(job);
      return errorResult(providerError(error), job);
    }
  }

  private async runProvider<T>(job: VoiceOwnedJob | null, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.providerBusy()) throw new LocalVoiceProviderError('unavailable');
    const task: InFlight = { job, controller: new AbortController() };
    this.inFlight = task;
    const timer = setTimeout(() => task.controller.abort(new LocalVoiceProviderError('timeout')), this.timeoutMs);
    const clear = () => { if (this.inFlight === task) this.inFlight = null; };
    let running: Promise<T>;
    try { running = Promise.resolve(call(task.controller.signal)); }
    catch (error) { running = Promise.reject(error); }
    // Actual settlement owns release of the in-flight gate, not aborting the
    // client wait. The local process provider additionally quarantines kill
    // requests until real child close.
    const tracked = running.then(value => { clear(); return value; }, error => { clear(); throw error; });
    try { return await waitCancelable(tracked, task.controller.signal); }
    finally { clearTimeout(timer); }
  }
}
