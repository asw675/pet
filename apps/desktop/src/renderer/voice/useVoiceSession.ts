import { computed, getCurrentScope, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import type { AiCancelReason, AiErrorCode, ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { VoiceCancelReason, VoiceErrorCode, VoiceEvent, VoiceJob } from '../../../../../packages/contracts/src/voice.js';
import { sameVoiceJob, sameVoiceScope, voiceChatPushSchema, voiceChatStartResultSchema, voiceChatStartSchema, voiceMicGrantSchema,
  voiceMouthNotificationSchema, voiceOwnedJobSchema, voiceResultMatchesRequest, voiceScopeSchema, voiceServiceResultSchema } from '../../shared/voice-ipc';
import type { VoiceChatIdentity, VoiceMouthNotification, VoiceOwnedJob, VoiceScope, VoiceServiceRequest,
  VoiceServiceResult, VoiceSessionBridgePort, VoiceStatusProjection } from '../../shared/voice-ipc';
import { WebAudioVoiceAdapter } from './audio-adapter';
import type { VoiceAudioAdapterOptions, VoiceAudioDependencies, VoiceMicrophoneGrant } from './audio-adapter';
import { initialVoiceSession, reduceVoiceEvent, reduceVoiceRequest } from './voice-session';
import type { VoiceEffect, VoiceSessionState, VoiceTransition } from './voice-session';

type Adapter = Pick<WebAudioVoiceAdapter, 'beginCapture' | 'primePlaybackFromGesture' | 'stopCapture' | 'releaseCapture' | 'preparePlayback' | 'stopPlayback' | 'dispose'>;
export interface VoiceLifecyclePort {
  /** Register focus loss/page exit/visibility cancellation, return cleanup. */
  subscribeBlur(listener: () => void): () => void;
}
export interface UseVoiceSessionOptions {
  readonly bridge: VoiceSessionBridgePort;
  readonly scope: Readonly<Ref<VoiceScope | null>>;
  readonly createId?: () => string;
  readonly audioDependencies?: Partial<VoiceAudioDependencies>;
  readonly createAudioAdapter?: (options: VoiceAudioAdapterOptions) => Adapter;
  readonly lifecycle?: VoiceLifecyclePort;
}
interface ActivePlan { job: VoiceOwnedJob; configRevision: number }
interface ChatFlow { job: VoiceOwnedJob; sequence: number; terminal: boolean; cancellation: AiCancelReason | null }
function chatIdentity(job: VoiceOwnedJob): VoiceChatIdentity { return { petId: job.petId, conversationId: job.conversationId, requestId: job.requestId }; }
function sameChat(job: VoiceOwnedJob, identity: VoiceChatIdentity): boolean { return sameVoiceScope(job, identity) && job.requestId === identity.requestId; }
function aiReason(reason: VoiceCancelReason): AiCancelReason {
  return reason === 'REPLACED' ? 'SUPERSEDED' : reason === 'PET_SWITCH' ? 'PET_SWITCH' : 'USER';
}
function aiError(code: AiErrorCode): VoiceErrorCode { return code === 'TIMEOUT' ? 'timeout' : code === 'NETWORK' ? 'network' : 'unavailable'; }
const defaultLifecycle: VoiceLifecyclePort = {
  subscribeBlur(listener) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
    const visibility = () => { if (document.visibilityState === 'hidden') listener(); };
    window.addEventListener('blur', listener); window.addEventListener('pagehide', listener);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('blur', listener); window.removeEventListener('pagehide', listener); document.removeEventListener('visibilitychange', visibility); };
  },
};

/** Controller for the single control-center PTT slot. The existing pure
 * coordinator reducers are its only phase transitions. Utility configuration,
 * provider work and committed chat replies remain authoritative elsewhere. */
export function useVoiceSession(options: UseVoiceSessionOptions) {
  const { bridge } = options;
  const state = shallowRef<VoiceSessionState>(initialVoiceSession());
  const status = shallowRef<VoiceStatusProjection | null>(null);
  const statusLoading = ref(false), statusError = ref<VoiceErrorCode | null>(null);
  const disposed = ref(false);
  let scope: VoiceScope | null = null;
  let scopeEpoch = 0;
  let plan: ActivePlan | null = null;
  let chat: ChatFlow | null = null;
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const canStart = computed(() => !disposed.value && !statusLoading.value && status.value?.canBegin === true
    && state.value.generation < Number.MAX_SAFE_INTEGER - 1);

  function current(job: VoiceOwnedJob) { return state.value.job !== null && sameVoiceJob(state.value.job, job); }
  function phase(job: VoiceOwnedJob, expected: VoiceSessionState['phase']) { return current(job) && state.value.phase === expected; }
  async function invoke(request: VoiceServiceRequest): Promise<VoiceServiceResult> {
    try {
      const result = voiceServiceResultSchema.safeParse(await bridge.voiceRequest(request));
      if (result.success && voiceResultMatchesRequest(request, result.data)) return result.data;
    } catch { /* no raw host error or stale result reaches UI */ }
    return { ok: false, kind: 'error', code: 'unavailable', ...(request.kind === 'status' ? {} : { job: request.job }) };
  }
  function fail(job: VoiceOwnedJob, at: Extract<VoiceEvent, { type: 'FAILED' }>['phase'], code: VoiceErrorCode) {
    if (phase(job, at)) applyEvent({ type: 'FAILED', job, phase: at, code });
  }
  async function closeService(job: VoiceOwnedJob, complete: boolean, reason: VoiceCancelReason) {
    await invoke(complete ? { kind: 'finish', job } : { kind: 'cancel', job, reason });
  }
  async function revoke(grant: VoiceMicrophoneGrant) {
    const parsed = voiceMicGrantSchema.safeParse(grant);
    if (parsed.success) { try { await bridge.revokeMic(parsed.data); } catch { /* host must expire grant */ } }
  }
  const audio = (options.createAudioAdapter ?? (config => new WebAudioVoiceAdapter(config)))({
    ...(options.audioDependencies === undefined ? {} : { dependencies: options.audioDependencies }),
    emit: applyEvent,
    broker: {
      async request(rawJob: Readonly<VoiceJob>) {
        const parsed = voiceOwnedJobSchema.safeParse(rawJob);
        if (!parsed.success) return null;
        const job = parsed.data, active = plan;
        if (!active || !sameVoiceJob(active.job, job) || !phase(job, 'RECORDING')) return null;
        const result = await invoke({ kind: 'begin', job, expectedConfigRevision: active.configRevision });
        // Cancellation may run before an asynchronous begin reaches the
        // utility process. Re-close that exact late reservation, not a new job.
        if (!phase(job, 'RECORDING')) { if (result.kind === 'begun') void closeService(job, false, 'REPLACED'); return null; }
        if (result.kind !== 'begun') { fail(job, 'RECORDING', result.kind === 'error' ? result.code : 'unavailable'); return null; }
        let rawGrant: unknown = null;
        try { rawGrant = await bridge.requestMic(job); } catch { /* denial */ }
        const grant = voiceMicGrantSchema.safeParse(rawGrant);
        if (!phase(job, 'RECORDING')) {
          if (grant.success && sameVoiceJob(grant.data.job, job)) void revoke(grant.data);
          void closeService(job, false, 'REPLACED'); return null;
        }
        if (!grant.success || !sameVoiceJob(grant.data.job, job)) { fail(job, 'RECORDING', 'permission_denied'); return null; }
        return grant.data;
      },
      revoke,
    },
  });

  async function transcribe(effect: Extract<VoiceEffect, { type: 'START_STT' }>) {
    const bytes = Uint8Array.from(effect.audio.bytes);
    let result: VoiceServiceResult;
    try { result = await invoke({ kind: 'transcribe', job: effect.job, audio: { ...effect.audio, bytes } }); }
    finally { bytes.fill(0); effect.audio.bytes.fill(0); }
    if (!phase(effect.job, 'TRANSCRIBING')) return;
    if (result.kind === 'transcribed') applyEvent({ type: 'STT_DONE', job: effect.job, text: result.text });
    else fail(effect.job, 'TRANSCRIBING', result.kind === 'error' ? result.code : 'unavailable');
  }
  async function synthesize(effect: Extract<VoiceEffect, { type: 'START_TTS' }>) {
    // Never send or trust renderer-selected reply text or voice overrides.
    const result = await invoke({ kind: 'synthesize', job: effect.job });
    if (!phase(effect.job, 'TTS_PENDING')) return;
    if (result.kind === 'synthesized') applyEvent({ type: 'TTS_DONE', job: effect.job, audio: result.audio,
      ...(result.visemes === undefined ? {} : { visemes: result.visemes }) });
    else fail(effect.job, 'TTS_PENDING', result.kind === 'error' ? result.code : 'unavailable');
  }
  async function cancelChat(job: VoiceOwnedJob, reason: AiCancelReason) {
    try { await bridge.cancelChat(chatIdentity(job), reason); } catch { /* exact best effort */ }
  }
  async function submitChat(effect: Extract<VoiceEffect, { type: 'SUBMIT_CHAT' }>) {
    const job = effect.job;
    const intent = voiceChatStartSchema.safeParse({ ...chatIdentity(job), trigger: 'USER', userText: effect.text });
    if (!intent.success) { fail(job, 'CHAT_WAIT', 'invalid_text'); return; }
    const flow: ChatFlow = { job, sequence: -1, terminal: false, cancellation: null };
    chat = flow; // subscribe before asking start: a final push can race its ack
    try {
      const result = voiceChatStartResultSchema.safeParse(await bridge.startChat(intent.data));
      if (result.success && result.data.accepted && sameChat(job, result.data)) {
        if (flow.cancellation && !flow.terminal) void cancelChat(job, flow.cancellation);
        return;
      }
      if (!flow.terminal) fail(job, 'CHAT_WAIT', result.success && !result.data.accepted ? aiError(result.data.error.code) : 'unavailable');
    } catch { if (!flow.terminal) fail(job, 'CHAT_WAIT', 'unavailable'); }
  }
  function onChat(raw: ChatStreamEvent) {
    const flow = chat, parsed = voiceChatPushSchema.safeParse(raw);
    if (!flow || !parsed.success || flow.terminal || flow.cancellation || !phase(flow.job, 'CHAT_WAIT')) return;
    const event = parsed.data;
    if (!sameChat(flow.job, event) || event.sequence <= flow.sequence) return;
    flow.sequence = event.sequence;
    if (event.kind === 'textDelta') return; // chat alone owns incremental display
    flow.terminal = true;
    if (event.kind === 'final') applyEvent({ type: 'CHAT_DONE', job: flow.job, requestId: flow.job.requestId, text: event.reply.text });
    else fail(flow.job, 'CHAT_WAIT', event.kind === 'error' ? aiError(event.error.code) : 'canceled');
  }
  function mouth(event: VoiceMouthNotification) {
    const parsed = voiceMouthNotificationSchema.safeParse(event);
    if (parsed.success) { try { void Promise.resolve(bridge.publishMouth?.(parsed.data)).catch(() => {}); } catch { /* visual-only */ } }
  }

  function commit(transition: VoiceTransition, gesture?: Event, newConfigRevision?: number) {
    const previous = state.value;
    const old = previous.job, next = transition.state.job;
    const retired = old !== null && (next === null || !sameVoiceJob(old, next));
    const reason = transition.state.cancelReason ?? (next ? 'REPLACED' : 'USER');
    state.value = transition.state; // invalidate authority locally before side effects
    if (next && newConfigRevision !== undefined) plan = { job: next, configRevision: newConfigRevision };
    else if (retired) plan = null;
    for (const effect of transition.effects) {
      switch (effect.type) {
        case 'START_CAPTURE': {
          if (!gesture) { fail(effect.job, 'RECORDING', 'permission_denied'); break; }
          const config = state.value.config;
          if (config && !config.muted && config.volume > 0 && config.tts.mode !== 'DISABLED') audio.primePlaybackFromGesture(effect.job, gesture);
          if (!audio.beginCapture(effect, gesture)) fail(effect.job, 'RECORDING', 'permission_denied');
          break;
        }
        case 'STOP_CAPTURE': if (!audio.stopCapture(effect.job)) fail(effect.job, 'TRANSCRIBING', 'device_lost'); break;
        case 'RELEASE_CAPTURE': audio.releaseCapture(effect.job); break;
        case 'STOP_PLAYBACK':
          audio.stopPlayback(effect.job);
          // Retired jobs are closed even when no provider was started yet.
          // The broker also handles late reservations without touching new jobs.
          if (retired) void closeService(effect.job, next === null && transition.state.phase === 'IDLE', reason);
          break;
        case 'START_STT': void transcribe(effect); break;
        case 'START_TTS': void synthesize(effect); break;
        case 'CANCEL_STT': case 'CANCEL_TTS': break; // exact utility cancel above
        case 'SUBMIT_CHAT': void submitChat(effect); break;
        case 'CANCEL_CHAT': {
          if (chat && sameVoiceJob(chat.job, effect.job)) {
            if (chat.terminal) break;
            chat.cancellation = aiReason(reason);
          }
          void cancelChat(effect.job, aiReason(reason)); break;
        }
        case 'PREPARE_PLAYBACK': if (!audio.preparePlayback(effect)) fail(effect.job, 'TTS_PENDING', 'playback_failed'); break;
        case 'BEGIN_MOUTH': mouth({ kind: 'begin', job: effect.job, durationMs: effect.durationMs }); break;
        case 'MOUTH_SAMPLE': mouth({ kind: 'sample', job: effect.job, sample: effect.sample }); break;
        case 'CLEAR_MOUTH': mouth({ kind: 'clear', job: effect.job }); break;
      }
    }
    if (retired && chat && sameVoiceJob(chat.job, old)) chat = null;
    return transition.outcome === 'APPLIED';
  }
  function applyEvent(event: VoiceEvent) {
    // Stale capture grants still require the reducer's explicit release effect.
    commit(reduceVoiceEvent(state.value, event));
  }
  function cancel(reason: VoiceCancelReason = 'USER') {
    const job = state.value.job;
    return job !== null && commit(reduceVoiceRequest(state.value, { type: 'CANCEL', job, reason }));
  }
  function setMuted(muted: boolean) {
    return scope !== null && commit(reduceVoiceRequest(state.value, { type: 'SET_MUTED', petId: scope.petId, muted }));
  }
  async function refreshStatus(probe = true) {
    const requested = scope, epoch = ++scopeEpoch;
    if (!requested || disposed.value) return;
    statusLoading.value = true; statusError.value = null;
    const result = await invoke({ kind: 'status', scope: requested, probe });
    if (disposed.value || epoch !== scopeEpoch) return;
    statusLoading.value = false;
    if (result.kind !== 'status') { status.value = null; statusError.value = result.kind === 'error' ? result.code : 'unavailable'; return; }
    status.value = result.status;
    if (state.value.job && (result.status.latestGeneration > state.value.job.generation
      || plan?.configRevision !== result.status.configRevision)) cancel('REPLACED');
    if (!state.value.job && result.status.latestGeneration > state.value.generation) {
      state.value = Object.freeze({ ...state.value, generation: result.status.latestGeneration });
    }
    if (result.status.config.muted) setMuted(true);
  }
  function beginPtt(gesture: Event) {
    const selected = scope, projection = status.value;
    if (!canStart.value || !selected || !projection || !sameVoiceScope(selected, projection.scope)) return false;
    let turnId: string, requestId: string;
    try { turnId = createId(); requestId = createId(); } catch { return false; }
    return commit(reduceVoiceRequest(state.value, { type: 'START_PTT', ...selected, turnId, requestId, config: projection.config }), gesture, projection.configRevision);
  }
  function stopPtt() {
    const job = state.value.job;
    return job !== null && commit(reduceVoiceRequest(state.value, { type: 'STOP_PTT', job }));
  }
  const unsubChat = bridge.subscribeChat(onChat);
  const unsubSuspend = bridge.subscribeSuspend?.(() => cancel('SUSPEND'));
  const unsubBlur = (options.lifecycle ?? defaultLifecycle).subscribeBlur(() => cancel('FOCUS_LOST'));
  const unwatch = watch(options.scope, raw => {
    const validated = voiceScopeSchema.safeParse(raw), selected = validated.success ? validated.data : null;
    if ((!scope && !selected) || (scope && selected && sameVoiceScope(scope, selected))) return;
    cancel('PET_SWITCH');
    commit(reduceVoiceRequest(state.value, { type: 'SELECT_PET', petId: selected?.petId ?? null }));
    commit(reduceVoiceRequest(state.value, { type: 'RESET' }));
    scope = selected; ++scopeEpoch; status.value = null; statusError.value = null; statusLoading.value = false;
    if (scope) void refreshStatus();
  }, { immediate: true, flush: 'sync' });
  function dispose() {
    if (disposed.value) return;
    disposed.value = true; ++scopeEpoch;
    cancel('FOCUS_LOST'); audio.dispose(); unwatch(); unsubChat(); unsubBlur(); unsubSuspend?.();
    status.value = null; statusLoading.value = false;
  }
  if (getCurrentScope()) onScopeDispose(dispose);
  return { state: readonly(state), status: readonly(status), statusLoading: readonly(statusLoading), statusError: readonly(statusError),
    canStart, refreshStatus, beginPtt, stopPtt, cancel, setMuted, dispose };
}
