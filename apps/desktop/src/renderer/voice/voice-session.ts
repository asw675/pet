import { inspectVoiceAudio, voiceEventSchema, voiceRequestSchema } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceCancelReason, VoiceErrorCode, VoiceEvent, VoiceJob, VoiceMouthSample, VoicePhase,
  VoiceRequest, VoiceSessionConfig, VoiceSttConfig, VoiceTtsConfig, VoiceViseme } from '../../../../../packages/contracts/src/voice.js';

type OwnedVoiceJob = VoiceJob & { requestId: string };
type ActiveTts = Exclude<VoiceTtsConfig, { mode: 'DISABLED' }>;

export interface VoiceSessionState {
  readonly phase: VoicePhase;
  /** Single global monotonic generation; never scoped to individual pets. */
  readonly generation: number;
  readonly selectedPetId: string | null;
  readonly muted: boolean;
  readonly job: Readonly<OwnedVoiceJob> | null;
  readonly lastJob: Readonly<OwnedVoiceJob> | null;
  readonly config: Readonly<VoiceSessionConfig> | null;
  readonly captureStarted: boolean;
  readonly sttStarted: boolean;
  readonly playbackPrepared: boolean;
  readonly playbackDurationMs: number | null;
  readonly lastPlaybackAtMs: number;
  /** Ephemeral UI fallback only. Chat is the sole owner of saved text history. */
  readonly transcript: string | null;
  readonly replyText: string | null;
  readonly error: VoiceErrorCode | null;
  readonly cancelReason: VoiceCancelReason | null;
}

/** Pure effects: the eventual trusted owner must implement each adapter and
 * correlate it to its exact job. No capture, audio device, provider, network
 * or chat calls are performed by this module. */
export type VoiceEffect =
  | { readonly type: 'START_CAPTURE'; readonly job: Readonly<OwnedVoiceJob>; readonly sampleRate: 16000; readonly channels: 1; readonly codec: 'wav'; readonly maxDurationMs: number }
  | { readonly type: 'STOP_CAPTURE'; readonly job: Readonly<OwnedVoiceJob> }
  | { readonly type: 'RELEASE_CAPTURE'; readonly job: Readonly<VoiceJob> }
  | { readonly type: 'START_STT'; readonly job: Readonly<OwnedVoiceJob>; readonly audio: VoiceAudio; readonly config: VoiceSttConfig }
  | { readonly type: 'CANCEL_STT'; readonly job: Readonly<OwnedVoiceJob> }
  | { readonly type: 'SUBMIT_CHAT'; readonly job: Readonly<OwnedVoiceJob>; readonly requestId: string; readonly text: string }
  | { readonly type: 'CANCEL_CHAT'; readonly job: Readonly<OwnedVoiceJob>; readonly requestId: string }
  | { readonly type: 'START_TTS'; readonly job: Readonly<OwnedVoiceJob>; readonly text: string; readonly config: ActiveTts }
  | { readonly type: 'CANCEL_TTS'; readonly job: Readonly<OwnedVoiceJob> }
  | { readonly type: 'PREPARE_PLAYBACK'; readonly job: Readonly<OwnedVoiceJob>; readonly audio: VoiceAudio; readonly volume: number; readonly visemes: readonly VoiceViseme[] }
  | { readonly type: 'STOP_PLAYBACK'; readonly job: Readonly<OwnedVoiceJob> }
  | { readonly type: 'BEGIN_MOUTH'; readonly job: Readonly<OwnedVoiceJob>; readonly durationMs: number }
  | { readonly type: 'MOUTH_SAMPLE'; readonly job: Readonly<OwnedVoiceJob>; readonly sample: VoiceMouthSample }
  | { readonly type: 'CLEAR_MOUTH'; readonly job: Readonly<OwnedVoiceJob> };

export interface VoiceTransition {
  readonly outcome: 'APPLIED' | 'IGNORED' | 'INVALID';
  readonly state: VoiceSessionState;
  /** Ordered: on interruption the old channel's audio, mouth and capture
   * are cleared before an effect can open a new capture. */
  readonly effects: readonly VoiceEffect[];
}

const noPlayback = { captureStarted: false, sttStarted: false, playbackPrepared: false,
  playbackDurationMs: null, lastPlaybackAtMs: -1 } as const;
export function initialVoiceSession(): VoiceSessionState {
  return Object.freeze({ phase: 'IDLE', generation: 0, selectedPetId: null, muted: false,
    job: null, lastJob: null, config: null, ...noPlayback, transcript: null, replyText: null, error: null, cancelReason: null });
}

function nextGeneration(state: VoiceSessionState): number {
  if (state.generation >= Number.MAX_SAFE_INTEGER) throw new RangeError('Voice generation exhausted');
  return state.generation + 1;
}

function sameJob(a: Readonly<VoiceJob> | null, b: Readonly<VoiceJob>): boolean {
  return !!a && a.generation === b.generation && a.petId === b.petId && a.conversationId === b.conversationId
    && a.turnId === b.turnId && a.requestId === b.requestId;
}

function applied(state: VoiceSessionState, patch: Partial<VoiceSessionState>, effects: readonly VoiceEffect[] = []): VoiceTransition {
  return { outcome: 'APPLIED', state: Object.freeze({ ...state, ...patch }), effects };
}
function ignored(state: VoiceSessionState, effects: readonly VoiceEffect[] = []): VoiceTransition {
  return { outcome: 'IGNORED', state, effects };
}
function invalid(state: VoiceSessionState): VoiceTransition { return { outcome: 'INVALID', state, effects: [] }; }

function freezeConfig(config: VoiceSessionConfig): Readonly<VoiceSessionConfig> {
  const stt = config.stt.mode === 'CLOUD' ? Object.freeze({ ...config.stt, consent: Object.freeze({ ...config.stt.consent }) }) : Object.freeze({ ...config.stt });
  const tts = config.tts.mode === 'CLOUD' ? Object.freeze({ ...config.tts, voice: Object.freeze({ ...config.tts.voice }), consent: Object.freeze({ ...config.tts.consent }) })
    : config.tts.mode === 'LOCAL' ? Object.freeze({ ...config.tts, voice: Object.freeze({ ...config.tts.voice }) }) : Object.freeze({ ...config.tts });
  return Object.freeze({ ...config, stt, tts });
}
function copyAudio(audio: VoiceAudio): VoiceAudio {
  // The state never owns raw recording/synthesis buffers. New effects receive
  // a bounded copy, so caller mutation cannot change already-validated bytes.
  return { ...audio, bytes: Uint8Array.from(audio.bytes) };
}

function cleanup(state: VoiceSessionState, completed?: 'STT' | 'CHAT'): VoiceEffect[] {
  const job = state.job;
  if (!job) return [];
  const effects: VoiceEffect[] = [
    { type: 'STOP_PLAYBACK', job }, // also discard prepared WAV/queue in the owner
    { type: 'CLEAR_MOUTH', job },
    { type: 'RELEASE_CAPTURE', job }, // idempotent, includes permission race
  ];
  if (state.phase === 'TRANSCRIBING' && state.sttStarted && completed !== 'STT') effects.push({ type: 'CANCEL_STT', job });
  if (state.phase === 'CHAT_WAIT' && completed !== 'CHAT') effects.push({ type: 'CANCEL_CHAT', job, requestId: job.requestId });
  if (state.phase === 'TTS_PENDING' && !state.playbackPrepared) effects.push({ type: 'CANCEL_TTS', job });
  return effects;
}

function end(state: VoiceSessionState, phase: 'IDLE' | 'CANCELLED' | 'ERROR', patch: Partial<VoiceSessionState> = {}, completed?: 'STT' | 'CHAT'): VoiceTransition {
  // Publish the invalidated generation before the old effects are handled;
  // late completions then cannot reopen or play an invalidated job.
  return applied(state, { phase, generation: nextGeneration(state), job: null, config: null,
    ...noPlayback, error: null, cancelReason: null, ...patch }, cleanup(state, completed));
}

function stopRecording(state: VoiceSessionState): VoiceTransition {
  if (!state.job || state.phase !== 'RECORDING') return ignored(state);
  // Pointer released while permission was still pending. No recording or
  // STT starts. A subsequently granted stale capture is released separately.
  if (!state.captureStarted) return end(state, 'ERROR', { error: 'no_speech' });
  return applied(state, { phase: 'TRANSCRIBING', captureStarted: false, sttStarted: false }, [
    { type: 'STOP_CAPTURE', job: state.job }, { type: 'RELEASE_CAPTURE', job: state.job },
  ]);
}

function requestTransition(state: VoiceSessionState, request: VoiceRequest): VoiceTransition {
  switch (request.type) {
    case 'START_PTT': {
      // A repeated pointer-down or immediately retried previous turn is not
      // new. The app service must allocate globally unique turn/chat IDs.
      if (state.lastJob && (state.lastJob.turnId === request.turnId || state.lastJob.requestId === request.requestId)) return ignored(state);
      // Reserve one unused generation to retire the new job even on error.
      if (state.generation >= Number.MAX_SAFE_INTEGER - 1) return invalid(state);
      const generation = nextGeneration(state);
      const muted = request.config.muted || (state.selectedPetId === request.petId && state.muted);
      const config = freezeConfig({ ...request.config, muted });
      const job: OwnedVoiceJob = Object.freeze({ petId: request.petId, conversationId: request.conversationId,
        turnId: request.turnId, generation, requestId: request.requestId });
      return applied(state, { phase: 'RECORDING', generation, selectedPetId: job.petId, muted,
        job, lastJob: job, config, ...noPlayback, transcript: null, replyText: null, error: null, cancelReason: null }, [
        ...cleanup(state), { type: 'START_CAPTURE', job, sampleRate: 16000, channels: 1, codec: 'wav', maxDurationMs: config.maxRecordingMs },
      ]);
    }
    case 'STOP_PTT': return sameJob(state.job, request.job) ? stopRecording(state) : ignored(state);
    case 'CANCEL': return sameJob(state.job, request.job) ? end(state, 'CANCELLED', { cancelReason: request.reason }) : ignored(state);
    case 'SELECT_PET': {
      if (state.selectedPetId === request.petId) return ignored(state);
      // Do not expose the previous pet's ephemeral text in the newly selected
      // pet. Its already-committed chat records remain in the chat module.
      const selection = { selectedPetId: request.petId, muted: false, transcript: null, replyText: null } as const;
      if (state.job) return end(state, 'CANCELLED', { ...selection, cancelReason: 'PET_SWITCH' });
      return applied(state, { ...selection, generation: nextGeneration(state), phase: 'IDLE', error: null, cancelReason: null });
    }
    case 'SET_MUTED': {
      if (request.petId !== state.selectedPetId || state.muted === request.muted) return ignored(state);
      if (request.muted && state.job) return end(state, 'CANCELLED', { muted: true, cancelReason: 'MUTED' });
      // Unmuting is not a resume. A new PTT and a new generation are necessary.
      return applied(state, { muted: request.muted });
    }
    case 'RESET': {
      if (state.job || state.phase === 'IDLE') return ignored(state);
      return applied(state, { phase: 'IDLE', transcript: null, replyText: null, error: null, cancelReason: null });
    }
  }
}

function eventTransition(state: VoiceSessionState, event: VoiceEvent): VoiceTransition {
  const job = state.job;
  if (!job || !sameJob(job, event.job)) {
    // A delayed microphone permission grant can physically create old tracks
    // after cancellation; signal their release with the old exact job.
    return event.type === 'CAPTURE_STARTED' && event.job.generation < state.generation
      ? ignored(state, [{ type: 'RELEASE_CAPTURE', job: Object.freeze({ ...event.job }) }]) : ignored(state);
  }
  const config = state.config;
  if (!config) return ignored(state);
  switch (event.type) {
    case 'CAPTURE_STARTED':
      if (state.phase !== 'RECORDING') return ignored(state, [{ type: 'RELEASE_CAPTURE', job }]);
      return state.captureStarted ? ignored(state) : applied(state, { captureStarted: true });
    case 'RECORDING_LIMIT_REACHED': return stopRecording(state);
    case 'RECORDING_DONE': {
      if (state.phase !== 'TRANSCRIBING' || state.sttStarted) return ignored(state);
      if (inspectVoiceAudio(event.audio).durationMs > config.maxRecordingMs) return end(state, 'ERROR', { error: 'invalid_audio' });
      return applied(state, { sttStarted: true }, [{ type: 'START_STT', job, audio: copyAudio(event.audio), config: config.stt }]);
    }
    case 'STT_DONE': {
      if (state.phase !== 'TRANSCRIBING' || !state.sttStarted) return ignored(state);
      const text = event.text.trim();
      // Whitespace or no speech never creates a chat message.
      if (!text) return end(state, 'ERROR', { error: 'no_speech' }, 'STT');
      return applied(state, { phase: 'CHAT_WAIT', transcript: text, sttStarted: false }, [{ type: 'SUBMIT_CHAT', job, requestId: job.requestId, text }]);
    }
    case 'CHAT_DONE': {
      if (state.phase !== 'CHAT_WAIT' || event.requestId !== job.requestId) return ignored(state);
      const text = event.text.trim();
      if (!text) {
        // This is the final response, not a reason to resend the chat turn.
        return end(state, 'ERROR', { error: 'invalid_text' }, 'CHAT');
      }
      if (state.muted || config.muted || config.volume === 0 || config.tts.mode === 'DISABLED') {
        // Completed text is retained even without an installed voice.
        return end(state, 'IDLE', { replyText: text }, 'CHAT');
      }
      return applied(state, { phase: 'TTS_PENDING', replyText: text }, [{ type: 'START_TTS', job, text, config: config.tts }]);
    }
    case 'TTS_DONE': {
      if (state.phase !== 'TTS_PENDING' || state.playbackPrepared) return ignored(state);
      const audio = copyAudio(event.audio);
      const duration = inspectVoiceAudio(audio).durationMs;
      const visemes = Object.freeze((event.visemes ?? []).map(sample => Object.freeze({ ...sample })));
      return applied(state, { playbackPrepared: true, playbackDurationMs: duration }, [
        { type: 'PREPARE_PLAYBACK', job, audio, volume: config.volume, visemes },
      ]);
    }
    case 'PLAYBACK_STARTED': {
      if (state.phase !== 'TTS_PENDING' || !state.playbackPrepared || state.playbackDurationMs === null) return ignored(state);
      // Decode/resample may round by a small number of samples. A radically
      // different duration cannot be the verified WAV that this turn prepared.
      if (Math.abs(event.durationMs - state.playbackDurationMs) > 2) return end(state, 'ERROR', { error: 'playback_failed' });
      return applied(state, { phase: 'PLAYING', playbackDurationMs: event.durationMs, lastPlaybackAtMs: -1 }, [
        { type: 'BEGIN_MOUTH', job, durationMs: event.durationMs },
      ]);
    }
    case 'PLAYBACK_SAMPLE': {
      if (state.phase !== 'PLAYING' || state.muted || state.playbackDurationMs === null
        || event.atMs <= state.lastPlaybackAtMs || event.atMs > state.playbackDurationMs) return ignored(state);
      const sample: VoiceMouthSample = { petId: job.petId, turnId: job.turnId, generation: job.generation,
        atMs: event.atMs, mouthOpen: event.mouthOpen, speaking: event.speaking, ...(event.viseme === undefined ? {} : { viseme: event.viseme }) };
      return applied(state, { lastPlaybackAtMs: event.atMs }, [{ type: 'MOUTH_SAMPLE', job, sample }]);
    }
    case 'PLAYBACK_ENDED': return state.phase === 'PLAYING' ? end(state, 'IDLE') : ignored(state);
    case 'FAILED':
      // A previous stage's late errors cannot terminate a later stage.
      // The selected provider is never retried through another provider.
      return event.phase === state.phase ? end(state, 'ERROR', { error: event.code }) : ignored(state);
  }
}

export function reduceVoiceRequest(state: VoiceSessionState, input: unknown): VoiceTransition {
  const parsed = voiceRequestSchema.safeParse(input);
  if (!parsed.success) return invalid(state);
  // Retire the generation space rather than wrap or allow an ambiguous job.
  if (state.generation >= Number.MAX_SAFE_INTEGER) return invalid(state);
  return requestTransition(state, parsed.data);
}

export function reduceVoiceEvent(state: VoiceSessionState, input: unknown): VoiceTransition {
  const parsed = voiceEventSchema.safeParse(input);
  if (!parsed.success || state.generation >= Number.MAX_SAFE_INTEGER) return invalid(state);
  return eventTransition(state, parsed.data);
}

/** In-memory, side-effect-free reference coordinator. It records the next
 * state before returning any effect. Production app-service must be the sole
 * owner of this state; renderer use is currently only pure tests/adaptation. */
export class VoiceSessionCoordinator {
  private current = initialVoiceSession();
  get state(): VoiceSessionState { return this.current; }
  request(input: unknown): VoiceTransition { return this.commit(reduceVoiceRequest(this.current, input)); }
  event(input: unknown): VoiceTransition { return this.commit(reduceVoiceEvent(this.current, input)); }
  private commit(transition: VoiceTransition): VoiceTransition {
    this.current = transition.state;
    return transition;
  }
}
