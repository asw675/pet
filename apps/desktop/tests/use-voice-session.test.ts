import { effectScope, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceSessionConfig } from '../../../packages/contracts/src/voice.js';
import type { ChatStreamEvent } from '@pet-desktop/contracts/ai';
import type { VoiceChatStart, VoiceChatStartResult, VoiceMicGrant, VoiceOwnedJob, VoiceScope, VoiceServiceRequest, VoiceServiceResult,
  VoiceSessionBridgePort, VoiceStatusProjection } from '../src/shared/voice-ipc';
import { useVoiceSession } from '../src/renderer/voice/useVoiceSession';
import type { VoiceAudioAdapterOptions } from '../src/renderer/voice/audio-adapter';
import type { VoiceEffect } from '../src/renderer/voice/voice-session';

const scopeA: VoiceScope = { petId: 'pet-a', conversationId: 'conv-a' };
const scopeB: VoiceScope = { petId: 'pet-b', conversationId: 'conv-b' };
const config: VoiceSessionConfig = { ...DEFAULT_LOCAL_VOICE_CONFIG, tts: { mode: 'LOCAL', voice: { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: 'sapi-voice', locale: 'zh-CN' } } };
const gesture = new Event('pointerdown'); // injected fake only; real adapter requires trusted activation
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 45; i++) await Promise.resolve(); }
function wav(): VoiceAudio & { bytes: Uint8Array<ArrayBuffer> } {
  const bytes = new Uint8Array(44 + 3200 * 2), view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  view.setInt16(44, 2000, true); return { codec: 'wav', bytes, sampleRate: 16000, channels: 1 };
}
function projection(scope: VoiceScope, settings = config): VoiceStatusProjection {
  return { scope, config: settings, configRevision: 7, latestGeneration: 20, canBegin: true, busy: false,
    stt: { providerId: 'WHISPER_CPP', requiresNetwork: false, capabilities: ['STT'], health: 'READY' },
    tts: settings.tts.mode === 'DISABLED' ? null : { providerId: 'WINDOWS_SYSTEM_SPEECH', requiresNetwork: false, capabilities: ['TTS'], health: 'READY' } };
}
function final(job: VoiceOwnedJob, sequence = 2): ChatStreamEvent {
  const { petId, conversationId, requestId } = job;
  return { kind: 'final', petId, conversationId, requestId, sequence,
    reply: { text: '你好，伙伴', emotion: 'happy', motionIntent: null, actionProposals: [], memoryCandidates: [] }, usage: null };
}
class FakeAudio {
  grant: VoiceMicGrant | null = null;
  readonly beginCapture = vi.fn((effect: Extract<VoiceEffect, { type: 'START_CAPTURE' }>, _gesture: Event) => {
    void this.options.broker.request(effect.job).then(raw => {
      if (!raw) return;
      this.grant = raw as VoiceMicGrant;
      this.options.emit({ type: 'CAPTURE_STARTED', job: effect.job });
    });
    return true;
  });
  readonly primePlaybackFromGesture = vi.fn(() => true);
  readonly stopCapture = vi.fn((job: VoiceOwnedJob) => {
    this.releaseCapture(job); this.options.emit({ type: 'RECORDING_DONE', job, audio: wav() }); return true;
  });
  readonly releaseCapture = vi.fn((job: { turnId: string }) => {
    if (this.grant?.job.turnId === job.turnId) { void this.options.broker.revoke(this.grant); this.grant = null; }
  });
  readonly preparePlayback = vi.fn(() => true);
  readonly stopPlayback = vi.fn((job: VoiceOwnedJob) => this.releaseCapture(job));
  readonly dispose = vi.fn();
  constructor(readonly options: VoiceAudioAdapterOptions) {}
}
function harness(settings = config) {
  const vueScope = effectScope(), scope = ref<VoiceScope | null>(scopeA);
  let id = 0, chatPush: ((event: ChatStreamEvent) => void) | null = null, blur = () => {}, suspend = () => {};
  const defaultVoice = async (request: VoiceServiceRequest): Promise<VoiceServiceResult> => {
    switch (request.kind) {
      case 'status': return { ok: true, kind: 'status', status: projection(request.scope, settings) };
      case 'begin': return { ok: true, kind: 'begun', job: request.job, configRevision: request.expectedConfigRevision };
      case 'transcribe': return { ok: true, kind: 'transcribed', job: request.job, text: '语音识别结果' };
      case 'synthesize': return { ok: true, kind: 'synthesized', job: request.job, audio: wav() };
      case 'cancel': case 'finish': return { ok: true, kind: 'closed', job: request.job, changed: true };
    }
  };
  const voiceRequest = vi.fn(defaultVoice);
  const requestMic = vi.fn(async (job: VoiceOwnedJob): Promise<VoiceMicGrant | null> => ({ grantId: `grant-${job.turnId}`, job }));
  const revokeMic = vi.fn(async (_grant: VoiceMicGrant) => {});
  const startChat = vi.fn(async (intent: VoiceChatStart): Promise<VoiceChatStartResult> => ({ accepted: true, petId: intent.petId, conversationId: intent.conversationId, requestId: intent.requestId }));
  const cancelChat = vi.fn<VoiceSessionBridgePort['cancelChat']>(async () => true);
  const publishMouth = vi.fn<NonNullable<VoiceSessionBridgePort['publishMouth']>>();
  const unsubChat = vi.fn(() => { chatPush = null; });
  const unsubSuspend = vi.fn(), unsubBlur = vi.fn();
  const bridge: VoiceSessionBridgePort = { voiceRequest, requestMic, revokeMic, startChat, cancelChat, publishMouth,
    subscribeChat(listener) { chatPush = listener; return unsubChat; }, subscribeSuspend(listener) { suspend = listener; return unsubSuspend; } };
  let audio!: FakeAudio;
  const controller = vueScope.run(() => useVoiceSession({ bridge, scope, createId: () => `id-${++id}`,
    lifecycle: { subscribeBlur(listener) { blur = listener; return unsubBlur; } }, createAudioAdapter(options) { audio = new FakeAudio(options); return audio; } }))!;
  return { controller, scope, audio, voiceRequest, defaultVoice, requestMic, revokeMic, startChat, cancelChat, publishMouth,
    unsubChat, unsubBlur, unsubSuspend, push: (event: ChatStreamEvent) => chatPush?.(event), blur: () => blur(), suspend: () => suspend(), dispose: () => vueScope.stop() };
}
type Harness = ReturnType<typeof harness>;
async function begin(h: Harness) {
  await settle(); expect(h.controller.canStart.value).toBe(true); expect(h.controller.beginPtt(gesture)).toBe(true);
  const job = h.controller.state.value.job!; await settle(); expect(h.controller.state.value.captureStarted).toBe(true); return job;
}
async function chat(h: Harness) { const job = await begin(h); h.controller.stopPtt(); await settle(); expect(h.controller.state.value.phase).toBe('CHAT_WAIT'); return job; }

describe('Control-center voice controller with fake audio and bridge', () => {
  it('seeds the coordinator from utility generation and runs actual PTT orchestration to playback and release', async () => {
    const h = harness(); const job = await begin(h);
    expect(job.generation).toBe(21); expect(h.audio.primePlaybackFromGesture).toHaveBeenCalledExactlyOnceWith(job, gesture);
    expect(h.audio.beginCapture).toHaveBeenCalledWith(expect.objectContaining({ job }), gesture);
    expect(h.voiceRequest).toHaveBeenCalledWith({ kind: 'begin', job, expectedConfigRevision: 7 });
    expect(h.requestMic).toHaveBeenCalledExactlyOnceWith(job);
    expect(h.controller.stopPtt()).toBe(true); await settle();
    expect(h.revokeMic).toHaveBeenCalledTimes(1);
    expect(h.controller.state.value.transcript).toBe('语音识别结果');
    expect(h.startChat).toHaveBeenCalledExactlyOnceWith({ petId: job.petId, conversationId: job.conversationId, requestId: job.requestId, trigger: 'USER', userText: '语音识别结果' });
    h.push(final(job)); await settle();
    expect(h.voiceRequest).toHaveBeenCalledWith({ kind: 'synthesize', job });
    expect(h.controller.state.value.phase).toBe('TTS_PENDING'); expect(h.audio.preparePlayback).toHaveBeenCalledTimes(1);
    h.audio.options.emit({ type: 'PLAYBACK_STARTED', job, durationMs: 200 });
    h.audio.options.emit({ type: 'PLAYBACK_SAMPLE', job, atMs: 34, mouthOpen: .3, speaking: true });
    expect(h.controller.state.value.phase).toBe('PLAYING');
    expect(h.publishMouth).toHaveBeenCalledWith({ kind: 'begin', job, durationMs: 200 });
    expect(h.publishMouth).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sample', job }));
    h.audio.options.emit({ type: 'PLAYBACK_ENDED', job }); await settle();
    expect(h.controller.state.value.phase).toBe('IDLE'); expect(h.controller.state.value.replyText).toBe('你好，伙伴');
    expect(h.voiceRequest).toHaveBeenCalledWith({ kind: 'finish', job }); expect(h.publishMouth).toHaveBeenCalledWith({ kind: 'clear', job });
    h.dispose(); expect(h.audio.dispose).toHaveBeenCalledTimes(1); expect(h.unsubChat).toHaveBeenCalledTimes(1);
  });
  it('never requests a microphone before an authorized reservation; late reservation after release is closed', async () => {
    const h = harness(); await settle(); const late = deferred<VoiceServiceResult>();
    h.voiceRequest.mockImplementationOnce(() => late.promise); h.controller.beginPtt(gesture); const job = h.controller.state.value.job!;
    expect(h.requestMic).not.toHaveBeenCalled(); h.controller.stopPtt(); expect(h.controller.state.value.error).toBe('no_speech');
    late.resolve({ ok: true, kind: 'begun', job, configRevision: 7 }); await settle();
    expect(h.requestMic).not.toHaveBeenCalled();
    expect(h.voiceRequest.mock.calls.filter(([r]) => r.kind === 'cancel')).toHaveLength(2);
    expect(h.startChat).not.toHaveBeenCalled(); h.dispose();
  });
  it('revokes a late grant on pet switch, never switches scope back or starts stale capture', async () => {
    const h = harness(); await settle(); const late = deferred<VoiceMicGrant>(); h.requestMic.mockReturnValueOnce(late.promise);
    h.controller.beginPtt(gesture); const job = h.controller.state.value.job!; await settle();
    h.scope.value = scopeB; await settle();
    late.resolve({ grantId: 'late', job }); await settle();
    expect(h.revokeMic).toHaveBeenCalledWith({ grantId: 'late', job }); expect(h.controller.state.value.selectedPetId).toBe(scopeB.petId);
    expect(h.controller.state.value.job).toBeNull(); expect(h.controller.state.value.captureStarted).toBe(false); h.dispose();
  });
  it('ignores a late status query from previous conversation and denies stale config reservation', async () => {
    const h = harness(); await settle(); const late = deferred<VoiceServiceResult>(); h.voiceRequest.mockReturnValueOnce(late.promise);
    const old = h.controller.refreshStatus(); h.scope.value = scopeB; await settle();
    late.resolve({ ok: true, kind: 'status', status: projection(scopeA) }); await old;
    expect(h.controller.status.value?.scope).toEqual(scopeB);
    h.voiceRequest.mockImplementationOnce(async request => ({ ok: false, kind: 'error', code: 'unavailable', job: (request as { job: VoiceOwnedJob }).job }));
    h.controller.beginPtt(gesture); await settle(); expect(h.controller.state.value.error).toBe('unavailable'); expect(h.requestMic).not.toHaveBeenCalled(); h.dispose();
  });
  it('ignores stale STT completion after cancel and only accepts exact correlated results', async () => {
    const h = harness(); const old = await begin(h); const late = deferred<VoiceServiceResult>(); h.voiceRequest.mockReturnValueOnce(late.promise);
    h.controller.stopPtt(); h.controller.cancel(); late.resolve({ ok: true, kind: 'transcribed', job: old, text: '旧宠输入' }); await settle();
    expect(h.startChat).not.toHaveBeenCalled(); const current = await begin(h);
    h.voiceRequest.mockResolvedValueOnce({ ok: true, kind: 'transcribed', job: old, text: '错误作用域' });
    h.controller.stopPtt(); await settle(); expect(h.controller.state.value.error).toBe('unavailable');
    expect(current.generation).toBeGreaterThan(old.generation); expect(h.startChat).not.toHaveBeenCalled(); h.dispose();
  });
  it('cancels an accepted chat after late start acknowledgement without canceling unrelated or successful chat', async () => {
    const h = harness(); const late = deferred<VoiceChatStartResult>(); h.startChat.mockReturnValueOnce(late.promise);
    const job = await chat(h); h.blur(); await settle();
    late.resolve({ accepted: true, petId: job.petId, conversationId: job.conversationId, requestId: job.requestId }); await settle();
    expect(h.cancelChat).toHaveBeenCalledTimes(2); expect(h.cancelChat).toHaveBeenLastCalledWith({ petId: job.petId, conversationId: job.conversationId, requestId: job.requestId }, 'USER');
    expect(h.controller.state.value.cancelReason).toBe('FOCUS_LOST');
    h.push(final(job)); expect(h.controller.state.value.replyText).toBeNull(); h.dispose();
  });
  it('handles committed final push before start ack and retains text when TTS is unavailable', async () => {
    const h = harness(); const late = deferred<VoiceChatStartResult>(); h.startChat.mockReturnValueOnce(late.promise);
    const job = await chat(h);
    h.push(final({ ...job, requestId: 'wrong-request' })); expect(h.controller.state.value.phase).toBe('CHAT_WAIT');
    h.voiceRequest.mockResolvedValueOnce({ ok: false, kind: 'error', code: 'voice_missing', job });
    h.push(final(job)); await settle();
    expect(h.controller.state.value.error).toBe('voice_missing'); expect(h.controller.state.value.replyText).toBe('你好，伙伴');
    late.resolve({ accepted: true, petId: job.petId, conversationId: job.conversationId, requestId: job.requestId }); await settle();
    expect(h.cancelChat).not.toHaveBeenCalled(); expect(h.audio.preparePlayback).not.toHaveBeenCalled(); h.dispose();
  });
  it('mute and suspend invalidate pending audio; late synthesis cannot resume playback', async () => {
    const h = harness(); const job = await chat(h); const late = deferred<VoiceServiceResult>(); h.voiceRequest.mockReturnValueOnce(late.promise);
    h.push(final(job)); expect(h.controller.state.value.phase).toBe('TTS_PENDING');
    h.controller.setMuted(true); late.resolve({ ok: true, kind: 'synthesized', job, audio: wav() }); await settle();
    expect(h.controller.state.value.cancelReason).toBe('MUTED'); expect(h.audio.preparePlayback).not.toHaveBeenCalled();
    const next = await begin(h); expect(h.audio.primePlaybackFromGesture).toHaveBeenCalledTimes(1); h.suspend();
    expect(h.controller.state.value.cancelReason).toBe('SUSPEND'); expect(h.audio.stopPlayback).toHaveBeenCalledWith(next); h.dispose();
  });
  it('disabled TTS preserves final text and completes service with no synthesis or playback priming', async () => {
    const h = harness({ ...config, tts: { mode: 'DISABLED' } }); const job = await chat(h); h.push(final(job)); await settle();
    expect(h.controller.state.value.phase).toBe('IDLE'); expect(h.controller.state.value.replyText).toBe('你好，伙伴');
    expect(h.audio.primePlaybackFromGesture).not.toHaveBeenCalled(); expect(h.voiceRequest.mock.calls.some(([r]) => r.kind === 'synthesize')).toBe(false);
    expect(h.voiceRequest).toHaveBeenCalledWith({ kind: 'finish', job }); h.dispose();
  });
  it('scope disposal synchronously invalidates active generation and removes all handlers', async () => {
    const h = harness(); const job = await begin(h); h.dispose(); await settle();
    expect(h.controller.canStart.value).toBe(false); expect(h.audio.stopPlayback).toHaveBeenCalledWith(job);
    expect(h.unsubChat).toHaveBeenCalledTimes(1); expect(h.unsubBlur).toHaveBeenCalledTimes(1); expect(h.unsubSuspend).toHaveBeenCalledTimes(1);
    expect(h.voiceRequest).toHaveBeenCalledWith({ kind: 'cancel', job, reason: 'FOCUS_LOST' });
    h.audio.options.emit({ type: 'CAPTURE_STARTED', job }); expect(h.controller.state.value.job).toBeNull();
  });
});
