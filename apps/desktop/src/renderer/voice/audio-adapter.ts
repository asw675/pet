import captureWorkletUrl from './audio-capture-worklet.ts?worker&url';
import { CAPTURE_BATCH_FRAMES, CAPTURE_OUTPUT_RATE } from './audio-capture-worklet';
import { inspectVoiceAudio, MAX_VOICE_RECORDING_MS, voiceAudioSchema, voiceEventSchema, voiceJobSchema } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceErrorCode, VoiceEvent, VoiceJob } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceEffect } from './voice-session';
import { PlaybackMouthSampler } from './mouth-rms';

type CaptureEffect = Extract<VoiceEffect, { type: 'START_CAPTURE' }>;
type PlaybackEffect = Extract<VoiceEffect, { type: 'PREPARE_PLAYBACK' }>;

export interface VoiceMicrophoneGrant {
  readonly grantId: string;
  readonly job: VoiceJob;
}
/** The actual trusted Main/preload broker is required. No renderer adapter
 * can change Electron permission handling or manufacture authorization. */
export interface VoiceMicrophoneGrantBroker {
  request(job: Readonly<VoiceJob>): Promise<VoiceMicrophoneGrant | null>;
  revoke(grant: VoiceMicrophoneGrant): Promise<void> | void;
}

export interface VoiceAudioTimerPort {
  after(callback: () => void, ms: number): unknown;
  clearAfter(handle: unknown): void;
  every(callback: () => void, ms: number): unknown;
  clearEvery(handle: unknown): void;
}
export interface VoiceAudioDependencies {
  /** Injected in tests; production requires real trusted transient activation. */
  isExplicitGesture(event: Event): boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(kind: 'capture' | 'playback'): AudioContext;
  createCaptureWorklet(context: AudioContext, maxFrames: number): Promise<AudioWorkletNode>;
  timers: VoiceAudioTimerPort;
}
export interface VoiceAudioAdapterOptions {
  readonly broker: VoiceMicrophoneGrantBroker;
  readonly emit: (event: VoiceEvent) => void;
  readonly dependencies?: Partial<VoiceAudioDependencies>;
}

const CAPTURE_START_TIMEOUT_MS = 20_000;
const FLUSH_TIMEOUT_MS = 250;
const PLAYBACK_START_TIMEOUT_MS = 10_000;
const PLAYBACK_PRIME_TIMEOUT_MS = 120_000;
const SAMPLE_INTERVAL_MS = 34;
const CAPTURE_NOISE_FLOOR = .002; // engineering energy heuristic, not speech detection
const grantIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const realTimers: VoiceAudioTimerPort = {
  after: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearAfter: handle => globalThis.clearTimeout(handle as number),
  every: (callback, ms) => globalThis.setInterval(callback, ms),
  clearEvery: handle => globalThis.clearInterval(handle as number),
};

function realUserGesture(event: Event): boolean {
  return event.isTrusted && (event.type === 'pointerdown' || event.type === 'keydown' || event.type === 'click')
    && navigator.userActivation?.isActive === true;
}
async function realCaptureWorklet(context: AudioContext, maxFrames: number): Promise<AudioWorkletNode> {
  // Static Vite-built local module URL. No blob/eval/remote worklet, CSP can
  // remain script-src 'self' and worker-src 'self'.
  await context.audioWorklet.addModule(captureWorkletUrl);
  return new AudioWorkletNode(context, 'pet-desktop-capture-v1', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxFrames },
  });
}
const defaults: VoiceAudioDependencies = {
  isExplicitGesture: realUserGesture,
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  createContext: () => new AudioContext({ latencyHint: 'interactive' }),
  createCaptureWorklet: realCaptureWorklet,
  timers: realTimers,
};

function sameJob(a: VoiceJob | null, b: VoiceJob): boolean {
  return a !== null && a.petId === b.petId && a.conversationId === b.conversationId && a.turnId === b.turnId
    && a.generation === b.generation && a.requestId === b.requestId;
}
function validatedJob(raw: unknown): VoiceJob | null {
  const parsed = voiceJobSchema.safeParse(raw);
  return parsed.success && parsed.data.requestId !== undefined ? Object.freeze(parsed.data) : null;
}
function validGrant(grant: unknown, job: VoiceJob): grant is VoiceMicrophoneGrant {
  if (!grant || typeof grant !== 'object' || Object.keys(grant).length !== 2 || !('grantId' in grant) || !('job' in grant)
    || typeof grant.grantId !== 'string' || !grantIdPattern.test(grant.grantId)) return false;
  const identity = validatedJob(grant.job);
  return identity !== null && sameJob(identity, job);
}
function safeStopStream(stream: MediaStream): void {
  try { for (const track of stream.getTracks()) { try { track.stop(); } catch { /* continue releasing remaining tracks */ } } }
  catch { /* no track access after a detached stream */ }
}
function safeDisconnect(node: AudioNode | null): void { try { node?.disconnect(); } catch { /* already disconnected */ } }
function safeCloseContext(context: AudioContext): void {
  try { if (context.state !== 'closed') void context.close().catch(() => {}); } catch { /* already closed */ }
}
function resumeContext(context: AudioContext): Promise<boolean> {
  try {
    if (context.state === 'running') return Promise.resolve(true);
    return context.resume().then(() => context.state === 'running', () => false);
  } catch { return Promise.resolve(false); }
}
function captureError(error: unknown): VoiceErrorCode {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission_denied'
    : name === 'NotReadableError' || name === 'NotFoundError' || name === 'AbortError' ? 'device_lost' : 'unavailable';
}

function writeTag(bytes: Uint8Array, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) bytes[offset + i] = tag.charCodeAt(i);
}
/** Deterministic PCM16 RIFF envelope. Callers validate input sizes first. */
function pcmWave(pcmBytes: Uint8Array, sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcmBytes.length), view = new DataView(bytes.buffer);
  writeTag(bytes, 0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); writeTag(bytes, 8, 'WAVE');
  writeTag(bytes, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  writeTag(bytes, 36, 'data'); view.setUint32(40, pcmBytes.length, true); bytes.set(pcmBytes, 44);
  return bytes;
}
export function encodeRecordedPcm(samples: Int16Array): VoiceAudio & { bytes: Uint8Array<ArrayBuffer>; codec: 'wav' } {
  if (!(samples instanceof Int16Array) || !(samples.buffer instanceof ArrayBuffer) || samples.length < 1
    || samples.length > CAPTURE_OUTPUT_RATE * MAX_VOICE_RECORDING_MS / 1000) throw new RangeError('Invalid recorded PCM bounds');
  const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return { bytes: pcmWave(pcm, CAPTURE_OUTPUT_RATE, 1), codec: 'wav', sampleRate: CAPTURE_OUTPUT_RATE, channels: 1 };
}

interface CaptureSession {
  readonly job: VoiceJob;
  readonly context: AudioContext;
  readonly resumed: Promise<boolean>;
  readonly maxMs: number;
  readonly samples: Int16Array;
  grant: VoiceMicrophoneGrant | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  worklet: AudioWorkletNode | null;
  silence: GainNode | null;
  trackListeners: { track: MediaStreamTrack; listener: () => void }[];
  startTimer: unknown | null;
  durationTimer: unknown | null;
  flushTimer: unknown | null;
  count: number;
  energySquares: number;
  started: boolean;
  stopping: boolean;
  limitSignaled: boolean;
}
interface PlaybackSession {
  readonly job: VoiceJob;
  readonly context: AudioContext;
  readonly resumed: Promise<boolean>;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  startTimer: unknown | null;
  sampleTimer: unknown | null;
  endTimer: unknown | null;
  startedAt: number | null;
  durationMs: number;
  preparing: boolean;
}

/** Concrete Chromium capture/playback adapter, still unconnected to UI or
 * service authority. All hardware entry points require explicit activation
 * and, for microphone capture, an externally granted one-job permission.
 * Never persist, upload, transcribe or log raw audio here. */
export class WebAudioVoiceAdapter {
  private readonly deps: VoiceAudioDependencies;
  private readonly sampler = new PlaybackMouthSampler();
  private currentJob: VoiceJob | null = null;
  private highestGeneration = -1;
  private captureAttempted = false;
  private capture: CaptureSession | null = null;
  private playback: PlaybackSession | null = null;
  // Browser permission/decode promises cannot truly be aborted. Bound even
  // the invalidated asynchronous work: never queue unbounded device requests
  // or retained decoding buffers while a previously cancelled call hangs.
  private openingCapture = false;
  private openingPlayback = false;
  private disposed = false;

  constructor(private readonly options: VoiceAudioAdapterOptions) {
    this.deps = { ...defaults, ...options.dependencies };
  }

  /** Invoke synchronously from the trusted pointer/key event handler. The
   * permission broker is checked before getUserMedia; async grants cannot
   * resurrect a stopped or replaced generation. */
  beginCapture(effect: CaptureEffect, gesture: Event): boolean {
    const job = validatedJob(effect.job);
    if (!job || this.disposed || effect.sampleRate !== CAPTURE_OUTPUT_RATE || effect.channels !== 1 || effect.codec !== 'wav'
      || !Number.isSafeInteger(effect.maxDurationMs) || effect.maxDurationMs < 100 || effect.maxDurationMs > MAX_VOICE_RECORDING_MS) return false;
    if (job.generation < this.highestGeneration || (job.generation === this.highestGeneration
      && (!sameJob(this.currentJob, job) || this.captureAttempted))) return false;
    if (!this.gestureAllowed(gesture)) {
      this.cancelJob(job); this.publish({ type: 'FAILED', job, phase: 'RECORDING', code: 'permission_denied' }); return false;
    }
    if (!this.claim(job) || this.captureAttempted || this.playback?.preparing) return false;
    this.captureAttempted = true;
    if (this.openingCapture) {
      this.cancelJob(job); this.publish({ type: 'FAILED', job, phase: 'RECORDING', code: 'unavailable' }); return false;
    }
    let context: AudioContext;
    try { context = this.deps.createContext('capture'); }
    catch { this.cancelJob(job); this.publish({ type: 'FAILED', job, phase: 'RECORDING', code: 'unavailable' }); return false; }
    const session: CaptureSession = {
      job, context, resumed: resumeContext(context), maxMs: effect.maxDurationMs,
      samples: new Int16Array(effect.maxDurationMs * CAPTURE_OUTPUT_RATE / 1000),
      grant: null, stream: null, source: null, worklet: null, silence: null, trackListeners: [],
      startTimer: null, durationTimer: null, flushTimer: null, count: 0, energySquares: 0,
      started: false, stopping: false, limitSignaled: false,
    };
    this.capture = session;
    session.startTimer = this.deps.timers.after(() => this.failCapture(session, 'timeout'), CAPTURE_START_TIMEOUT_MS);
    this.openingCapture = true;
    void this.openCapture(session).finally(() => { this.openingCapture = false; });
    return true;
  }

  /** Prime a silent playback context from the same explicit user gesture.
   * Keep no device/track open. The context is tied to this job and closed on
   * cancellation/end/disposal. The async TTS path never unlocks autoplay on
   * its own, nor opens playback without this user-gesture-bound context. */
  primePlaybackFromGesture(rawJob: VoiceJob, gesture: Event): boolean {
    const job = validatedJob(rawJob);
    if (!job || this.disposed || !this.gestureAllowed(gesture) || !this.claim(job)) return false;
    if (this.playback) return sameJob(this.playback.job, job);
    let context: AudioContext;
    try { context = this.deps.createContext('playback'); } catch { return false; }
    const session: PlaybackSession = { job, context, resumed: resumeContext(context), source: null, gain: null, analyser: null,
      startTimer: null, sampleTimer: null, endTimer: null, startedAt: null, durationMs: 0, preparing: false };
    this.playback = session;
    session.startTimer = this.deps.timers.after(() => {
      if (this.playbackCurrent(session) && !session.preparing) this.discardPlayback(session);
    }, PLAYBACK_PRIME_TIMEOUT_MS);
    // A denied autoplay resume need not terminate text recognition. Close
    // the unusable context and report failure only if TTS actually arrives.
    void session.resumed.then(ready => { if (!ready && this.playback === session) safeCloseContext(context); });
    return true;
  }

  /** Coordinator STOP_CAPTURE flushes captured PCM after releasing all tracks
   * and revoking the broker grant immediately. A following RELEASE_CAPTURE
   * is idempotent and preserves this bounded no-device flush. */
  stopCapture(rawJob: VoiceJob): boolean {
    const job = validatedJob(rawJob), session = this.capture;
    if (!job || !session || !sameJob(session.job, job) || !this.captureCurrent(session)) return false;
    if (session.stopping) return true;
    if (!session.started || !session.worklet) { this.failCapture(session, 'no_speech'); return false; }
    session.stopping = true;
    this.clearCaptureTimer(session, 'durationTimer');
    this.releaseHardware(session);
    safeDisconnect(session.source); session.source = null;
    session.flushTimer = this.deps.timers.after(() => this.failCapture(session, 'timeout'), FLUSH_TIMEOUT_MS);
    try { session.worklet.port.postMessage({ type: 'FLUSH' }); } catch { this.failCapture(session, 'invalid_audio'); }
    return true;
  }

  releaseCapture(rawJob: VoiceJob): void {
    const job = validatedJob(rawJob), session = this.capture;
    if (!job || !session || !sameJob(session.job, job)) return;
    if (session.stopping) this.releaseHardware(session);
    else this.discardCapture(session);
  }

  /** Only the already primed same-job context may decode verified, bounded
   * complete WAV/PCM and start one audio source. No media URL or file fetch. */
  preparePlayback(effect: PlaybackEffect): boolean {
    const job = validatedJob(effect.job), active = this.playback;
    if (!job || this.disposed || this.capture || active?.preparing) return false;
    if (!sameJob(this.currentJob, job)) {
      // Old-generation results are deliberately silent. A fresh unprimed
      // request fails rather than waiting indefinitely or auto-unlocking audio.
      if (job.generation > this.highestGeneration) this.publish({ type: 'FAILED', job, phase: 'TTS_PENDING', code: 'playback_failed' });
      return false;
    }
    if (!active || !sameJob(active.job, job)) {
      this.cancelJob(job); this.publish({ type: 'FAILED', job, phase: 'TTS_PENDING', code: 'playback_failed' }); return false;
    }
    const parsed = voiceAudioSchema.safeParse(effect.audio);
    const event = voiceEventSchema.safeParse({ type: 'TTS_DONE', job, audio: effect.audio, visemes: effect.visemes });
    if (!parsed.success || !event.success || !Number.isFinite(effect.volume) || effect.volume < 0 || effect.volume > 1) {
      this.failPlayback(active, 'invalid_audio'); return false;
    }
    if (this.openingPlayback) { this.failPlayback(active, 'unavailable'); return false; }
    active.preparing = true;
    this.clearPlaybackTimer(active, 'startTimer');
    active.startTimer = this.deps.timers.after(() => this.failPlayback(active, 'timeout'), PLAYBACK_START_TIMEOUT_MS);
    this.openingPlayback = true;
    void this.openPlayback(active, { ...effect, audio: { ...parsed.data, bytes: Uint8Array.from(parsed.data.bytes) }, visemes: effect.visemes.map(value => ({ ...value })) })
      .finally(() => { this.openingPlayback = false; });
    return true;
  }

  /** The voice reducer's terminal/interruption STOP_PLAYBACK effect is the
   * first cleanup effect for the old job. Its executor must call cancelJob
   * so pending capture grants/flushes and silent primed audio are also lost. */
  stopPlayback(rawJob: VoiceJob): void { this.cancelJob(rawJob); }
  cancelJob(rawJob: VoiceJob): void {
    const job = validatedJob(rawJob);
    if (!job || !sameJob(this.currentJob, job)) return;
    // Invalidate first: stop(), close() or promise continuations can trigger
    // late onended/permission events synchronously or asynchronously.
    this.currentJob = null;
    if (this.capture && sameJob(this.capture.job, job)) this.discardCapture(this.capture);
    if (this.playback && sameJob(this.playback.job, job)) this.discardPlayback(this.playback);
    this.sampler.cancel(job);
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.currentJob) this.cancelJob(this.currentJob);
    this.disposed = true;
  }

  private gestureAllowed(event: Event): boolean { try { return this.deps.isExplicitGesture(event); } catch { return false; } }
  private claim(job: VoiceJob): boolean {
    if (job.generation < this.highestGeneration) return false;
    if (job.generation === this.highestGeneration) return sameJob(this.currentJob, job);
    if (this.currentJob) this.cancelJob(this.currentJob);
    this.highestGeneration = job.generation;
    this.currentJob = job;
    this.captureAttempted = false;
    return true;
  }
  private captureCurrent(session: CaptureSession): boolean { return !this.disposed && this.capture === session && sameJob(this.currentJob, session.job); }
  private playbackCurrent(session: PlaybackSession): boolean { return !this.disposed && this.playback === session && sameJob(this.currentJob, session.job); }
  private publish(event: VoiceEvent): void {
    const parsed = voiceEventSchema.safeParse(event);
    if (!parsed.success) { this.cancelJob(event.job); return; }
    try { this.options.emit(parsed.data); } catch { this.cancelJob(event.job); }
  }

  private async openCapture(session: CaptureSession): Promise<void> {
    let grant: VoiceMicrophoneGrant | null = null;
    try {
      grant = await this.options.broker.request(session.job);
      if (!this.captureCurrent(session)) { if (grant) this.revokeGrant(grant); return; }
      if (!validGrant(grant, session.job)) { if (grant) this.revokeGrant(grant); this.failCapture(session, 'permission_denied'); return; }
      session.grant = grant;
      // No microphone/device request until the explicit grant has passed.
      const stream = await this.deps.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!this.captureCurrent(session)) { safeStopStream(stream); return; }
      session.stream = stream;
      const tracks = stream.getAudioTracks();
      if (tracks.length !== 1 || stream.getVideoTracks().length !== 0 || tracks[0]?.readyState !== 'live') { this.failCapture(session, 'device_lost'); return; }
      const track = tracks[0]!;
      const settings = track.getSettings();
      if ((settings.channelCount !== undefined && (!Number.isSafeInteger(settings.channelCount) || settings.channelCount < 1 || settings.channelCount > 8))
        || (settings.sampleRate !== undefined && (!Number.isSafeInteger(settings.sampleRate) || settings.sampleRate < 8_000 || settings.sampleRate > 192_000))) {
        this.failCapture(session, 'invalid_audio'); return;
      }
      const ended = () => this.failCapture(session, 'device_lost');
      track.addEventListener('ended', ended);
      session.trackListeners.push({ track, listener: ended });
      const ready = await session.resumed;
      if (!this.captureCurrent(session)) return;
      if (!ready || session.context.sampleRate < CAPTURE_OUTPUT_RATE || session.context.sampleRate > 192_000) { this.failCapture(session, 'unavailable'); return; }
      const worklet = await this.deps.createCaptureWorklet(session.context, session.samples.length);
      if (!this.captureCurrent(session)) { safeDisconnect(worklet); try { worklet.port.close(); } catch {} return; }
      session.worklet = worklet;
      session.source = session.context.createMediaStreamSource(stream);
      session.silence = session.context.createGain(); session.silence.gain.value = 0;
      worklet.port.onmessage = event => this.onCaptureMessage(session, event.data);
      worklet.onprocessorerror = () => this.failCapture(session, 'invalid_audio');
      session.source.connect(worklet); worklet.connect(session.silence); session.silence.connect(session.context.destination);
      session.context.onstatechange = () => { if (session.started && !session.stopping && session.context.state !== 'running') this.failCapture(session, 'device_lost'); };
      session.started = true;
      this.clearCaptureTimer(session, 'startTimer');
      // Separate actual frame cap exists in the worklet and this receiving
      // buffer. Also cap wall-time microphone ownership if rendering stalls.
      session.durationTimer = this.deps.timers.after(() => this.notifyCaptureLimit(session), session.maxMs);
      this.publish({ type: 'CAPTURE_STARTED', job: session.job });
    } catch (error) {
      if (this.captureCurrent(session)) this.failCapture(session, captureError(error));
    }
  }

  private onCaptureMessage(session: CaptureSession, data: unknown): void {
    if (!this.captureCurrent(session)) return;
    if (!data || typeof data !== 'object' || !('type' in data)) { this.failCapture(session, 'invalid_audio'); return; }
    if (data.type === 'PCM16') {
      if (Object.keys(data).length !== 2 || !('samples' in data) || !(data.samples instanceof Int16Array)
        || !(data.samples.buffer instanceof ArrayBuffer) || data.samples.length < 1 || data.samples.length > CAPTURE_BATCH_FRAMES
        || session.count + data.samples.length > session.samples.length) { this.failCapture(session, 'invalid_audio'); return; }
      session.samples.set(data.samples, session.count); session.count += data.samples.length;
      for (const value of data.samples) session.energySquares += (value / 32768) ** 2;
      if (session.count === session.samples.length && !session.stopping) this.notifyCaptureLimit(session);
    } else if (data.type === 'LIMIT_REACHED' && Object.keys(data).length === 1) {
      if (session.count !== session.samples.length) { this.failCapture(session, 'invalid_audio'); return; }
      this.notifyCaptureLimit(session);
    } else if (data.type === 'FLUSHED' && Object.keys(data).length === 1) {
      if (!session.stopping) { this.failCapture(session, 'invalid_audio'); return; }
      this.finishCapture(session);
    } else if (data.type === 'ERROR') this.failCapture(session, 'invalid_audio');
    else this.failCapture(session, 'invalid_audio');
  }
  private notifyCaptureLimit(session: CaptureSession): void {
    if (!this.captureCurrent(session) || session.stopping || session.limitSignaled) return;
    session.limitSignaled = true;
    this.publish({ type: 'RECORDING_LIMIT_REACHED', job: session.job });
    // Even if the coordinator does not immediately process the signal, the
    // adapter itself stops owning the physical microphone at the limit.
    if (this.captureCurrent(session) && !session.stopping) this.stopCapture(session.job);
  }
  private finishCapture(session: CaptureSession): void {
    if (!this.captureCurrent(session)) return;
    if (!session.count || Math.sqrt(session.energySquares / session.count) < CAPTURE_NOISE_FLOOR) { this.failCapture(session, 'no_speech'); return; }
    try {
      const audio = encodeRecordedPcm(session.samples.subarray(0, session.count));
      this.discardCapture(session);
      this.publish({ type: 'RECORDING_DONE', job: session.job, audio });
    } catch { this.failCapture(session, 'invalid_audio'); }
  }
  private failCapture(session: CaptureSession, code: VoiceErrorCode): void {
    if (!this.captureCurrent(session)) return;
    const phase = session.stopping ? 'TRANSCRIBING' : 'RECORDING';
    this.cancelJob(session.job); this.publish({ type: 'FAILED', job: session.job, phase, code });
  }
  private clearCaptureTimer(session: CaptureSession, field: 'startTimer' | 'durationTimer' | 'flushTimer'): void {
    if (session[field] !== null) this.deps.timers.clearAfter(session[field]);
    session[field] = null;
  }
  private revokeGrant(grant: VoiceMicrophoneGrant): void {
    try { void Promise.resolve(this.options.broker.revoke(grant)).catch(() => {}); } catch { /* owner revokes its own grant */ }
  }
  private releaseHardware(session: CaptureSession): void {
    for (const { track, listener } of session.trackListeners) { try { track.removeEventListener('ended', listener); } catch {} }
    session.trackListeners = [];
    if (session.stream) { safeStopStream(session.stream); session.stream = null; }
    if (session.grant) { this.revokeGrant(session.grant); session.grant = null; }
  }
  private discardCapture(session: CaptureSession): void {
    if (this.capture === session) this.capture = null;
    this.clearCaptureTimer(session, 'startTimer'); this.clearCaptureTimer(session, 'durationTimer'); this.clearCaptureTimer(session, 'flushTimer');
    this.releaseHardware(session);
    session.context.onstatechange = null;
    if (session.worklet) {
      session.worklet.onprocessorerror = null;
      try { session.worklet.port.onmessage = null; session.worklet.port.close(); } catch {}
    }
    safeDisconnect(session.source); safeDisconnect(session.worklet); safeDisconnect(session.silence);
    safeCloseContext(session.context);
    // Do not retain the recording after handoff or cancellation.
    session.samples.fill(0); session.count = 0; session.energySquares = 0;
  }

  private async openPlayback(session: PlaybackSession, effect: PlaybackEffect): Promise<void> {
    try {
      const ready = await session.resumed;
      if (!this.playbackCurrent(session)) return;
      if (!ready || session.context.state !== 'running') { this.failPlayback(session, 'playback_failed'); return; }
      const info = inspectVoiceAudio(effect.audio);
      const wav = effect.audio.codec === 'wav' ? Uint8Array.from(effect.audio.bytes)
        : pcmWave(effect.audio.bytes, effect.audio.sampleRate, effect.audio.channels);
      const buffer = await session.context.decodeAudioData(wav.buffer);
      if (!this.playbackCurrent(session)) return;
      const durationMs = buffer.duration * 1000;
      if (!Number.isFinite(durationMs) || Math.abs(durationMs - info.durationMs) > 2 || buffer.numberOfChannels !== effect.audio.channels
        || buffer.length < 1 || !this.sampler.begin(session.job, durationMs, effect.visemes)) {
        this.failPlayback(session, 'invalid_audio'); return;
      }
      session.source = session.context.createBufferSource(); session.source.buffer = buffer;
      session.gain = session.context.createGain(); session.gain.gain.value = effect.volume;
      session.analyser = session.context.createAnalyser(); session.analyser.fftSize = 1024;
      session.source.connect(session.gain); session.gain.connect(session.analyser); session.analyser.connect(session.context.destination);
      session.source.onended = () => {
        if (!this.playbackCurrent(session) || session.startedAt === null) return;
        this.cancelJob(session.job); this.publish({ type: 'PLAYBACK_ENDED', job: session.job });
      };
      session.context.onstatechange = () => { if (session.startedAt !== null && session.context.state !== 'running') this.failPlayback(session, 'playback_failed'); };
      const startAt = session.context.currentTime;
      if (!Number.isFinite(startAt) || startAt < 0) { this.failPlayback(session, 'playback_failed'); return; }
      session.durationMs = durationMs;
      session.source.start(startAt);
      session.startedAt = startAt;
      if (!this.playbackCurrent(session)) return;
      this.clearPlaybackTimer(session, 'startTimer');
      const waveform = new Float32Array(session.analyser.fftSize);
      session.endTimer = this.deps.timers.after(() => this.failPlayback(session, 'timeout'), Math.ceil(durationMs) + 2000);
      session.sampleTimer = this.deps.timers.every(() => {
        if (!this.playbackCurrent(session) || session.startedAt === null || !session.analyser || session.context.state !== 'running') return;
        try {
          // Scheduler cadence is not the playback clock. The Web Audio
          // context's absolute time advances as its graph consumes samples.
          const atMs = Math.min(session.durationMs, Math.max(0, (session.context.currentTime - session.startedAt) * 1000));
          session.analyser.getFloatTimeDomainData(waveform);
          const sample = this.sampler.sample(session.job, atMs, waveform);
          if (sample) this.publish({ type: 'PLAYBACK_SAMPLE', job: session.job, atMs: sample.atMs, mouthOpen: sample.mouthOpen,
            speaking: sample.speaking, ...(sample.viseme === undefined ? {} : { viseme: sample.viseme }) });
        } catch { this.failPlayback(session, 'playback_failed'); }
      }, SAMPLE_INTERVAL_MS);
      this.publish({ type: 'PLAYBACK_STARTED', job: session.job, durationMs });
    } catch { if (this.playbackCurrent(session)) this.failPlayback(session, 'playback_failed'); }
  }
  private failPlayback(session: PlaybackSession, code: VoiceErrorCode): void {
    if (!this.playbackCurrent(session)) return;
    const phase = session.startedAt === null ? 'TTS_PENDING' : 'PLAYING';
    this.cancelJob(session.job); this.publish({ type: 'FAILED', job: session.job, phase, code });
  }
  private clearPlaybackTimer(session: PlaybackSession, field: 'startTimer' | 'sampleTimer' | 'endTimer'): void {
    if (session[field] !== null) {
      if (field === 'sampleTimer') this.deps.timers.clearEvery(session[field]); else this.deps.timers.clearAfter(session[field]);
    }
    session[field] = null;
  }
  private discardPlayback(session: PlaybackSession): void {
    if (this.playback === session) this.playback = null;
    this.clearPlaybackTimer(session, 'startTimer'); this.clearPlaybackTimer(session, 'sampleTimer'); this.clearPlaybackTimer(session, 'endTimer');
    this.sampler.cancel(session.job);
    session.context.onstatechange = null;
    if (session.source) { session.source.onended = null; try { session.source.stop(); } catch {} }
    safeDisconnect(session.source); safeDisconnect(session.gain); safeDisconnect(session.analyser);
    safeCloseContext(session.context);
  }
}
