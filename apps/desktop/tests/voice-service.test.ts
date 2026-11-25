import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceProviderStatus, VoiceSessionConfig } from '../../../packages/contracts/src/voice.js';
import { VoiceService } from '../src/app-service/voice/voice-service';
import type { CompletedVoiceReply, VoiceLocalProviderPort } from '../src/app-service/voice/voice-service';
import { voiceResultMatchesRequest, voiceServiceRequestSchema, voiceServiceResultSchema } from '../src/shared/voice-ipc';
import type { VoiceAuthorityConfig, VoiceOwnedJob } from '../src/shared/voice-ipc';

const scope = { petId: 'pet-a', conversationId: 'conv-a' };
const job = (generation = 1, pet = 'pet-a', conversation = 'conv-a'): VoiceOwnedJob => ({ petId: pet, conversationId: conversation,
  generation, turnId: `turn-${generation}`, requestId: `request-${generation}` });
const voice = { providerId: 'WINDOWS_SYSTEM_SPEECH' as const, voiceId: 'installed-voice', locale: 'zh-CN' };
const config: VoiceSessionConfig = { ...DEFAULT_LOCAL_VOICE_CONFIG, tts: { mode: 'LOCAL', voice } };
export function fixtureVoiceWav(ms = 200): VoiceAudio {
  const frames = 16 * ms, bytes = new Uint8Array(44 + frames * 2), view = new DataView(bytes.buffer);
  const tag = (o: number, s: string) => [...s].forEach((v, i) => { bytes[o + i] = v.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, frames * 2, true);
  view.setInt16(44, 2000, true);
  return { codec: 'wav', bytes, sampleRate: 16000, channels: 1 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function harness(initial = config, providerTimeoutMs = 500) {
  let authority: VoiceAuthorityConfig | null = { configRevision: 2, config: initial }, completed: CompletedVoiceReply | null = null, ready = false;
  const status = vi.fn((providerId: 'WHISPER_CPP' | 'WINDOWS_SYSTEM_SPEECH'): VoiceProviderStatus => ({ providerId, requiresNetwork: false,
    health: providerId === 'WINDOWS_SYSTEM_SPEECH' || ready ? 'READY' : 'UNCONFIGURED', capabilities: [providerId === 'WHISPER_CPP' ? 'STT' : 'TTS'] }));
  const probeWhisper = vi.fn<VoiceLocalProviderPort['probeWhisper']>(async () => { ready = true; return status('WHISPER_CPP'); });
  const transcribe = vi.fn<VoiceLocalProviderPort['transcribe']>(async () => ({ text: '  你好  ' }));
  const synthesize = vi.fn<VoiceLocalProviderPort['synthesize']>(async () => ({ audio: fixtureVoiceWav() }));
  const dispose = vi.fn();
  const readConfig = vi.fn((selected: { petId: string; conversationId: string }) => selected.petId === scope.petId && selected.conversationId === scope.conversationId ? authority : null);
  const completedAssistantText = vi.fn(() => completed);
  const service = new VoiceService({ authority: { readConfig, completedAssistantText }, providers: { isBusy: false, status, probeWhisper, transcribe, synthesize, dispose }, providerTimeoutMs });
  const update = (next: VoiceAuthorityConfig | null) => { authority = next; };
  const reply = (turn: VoiceOwnedJob, text = '真正已经提交的回复') => { completed = { petId: turn.petId, conversationId: turn.conversationId, requestId: turn.requestId, text }; };
  const probe = () => service.handle({ kind: 'status', scope, probe: true });
  const begin = (turn = job(), revision = 2) => service.handle({ kind: 'begin', job: turn, expectedConfigRevision: revision });
  const record = (turn = job(), audio = fixtureVoiceWav()) => service.handle({ kind: 'transcribe', job: turn, audio });
  const speak = (turn = job()) => service.handle({ kind: 'synthesize', job: turn });
  const cancel = (turn = job()) => service.handle({ kind: 'cancel', job: turn, reason: 'USER' });
  return { service, status, probeWhisper, transcribe, synthesize, dispose, completedAssistantText, update, reply, probe, begin, record, speak, cancel };
}
afterEach(() => vi.useRealTimers());

describe('Voice utility authority, local providers and exact single channel', () => {
  it('requires explicit model probe and exact configuration revision before authorizing a microphone turn', async () => {
    const h = harness();
    await expect(h.service.handle({ kind: 'status', scope, probe: false })).resolves.toMatchObject({ status: { canBegin: false, latestGeneration: 0 } });
    await expect(h.begin()).resolves.toMatchObject({ code: 'unavailable' });
    await expect(h.probe()).resolves.toMatchObject({ status: { canBegin: true, configRevision: 2 } });
    await expect(h.begin(job(), 1)).resolves.toMatchObject({ code: 'unavailable' });
    await expect(h.begin()).resolves.toMatchObject({ kind: 'begun', configRevision: 2, job: job() });
    await expect(h.service.handle({ kind: 'status', scope, probe: false })).resolves.toMatchObject({ status: { latestGeneration: 1, busy: true } });
    expect(h.probeWhisper).toHaveBeenCalledTimes(1);
  });
  it('does not accept a probe of a different model or a stale settings revision', async () => {
    const h = harness(); await h.probe();
    h.update({ configRevision: 3, config: { ...config, stt: { mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'MULTILINGUAL_SMALL' } } });
    await expect(h.begin(job(), 3)).resolves.toMatchObject({ code: 'unavailable' });
    await expect(h.probe()).resolves.toMatchObject({ status: { canBegin: true, configRevision: 3 } });
    expect(h.probeWhisper).toHaveBeenLastCalledWith('MULTILINGUAL_SMALL', expect.any(AbortSignal));
  });
  it('never invokes model/network fallback for explicit cloud configuration', async () => {
    const h = harness({ ...config, stt: { mode: 'CLOUD', providerId: 'OPENAI_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'consent' } },
      tts: { mode: 'CLOUD', voice: { providerId: 'AZURE_NEURAL_TTS', voiceId: 'cloud-voice', locale: 'zh-CN' }, consent: { scope: 'TTS_TEXT', authorizationId: 'text-consent' } } });
    await expect(h.probe()).resolves.toMatchObject({ status: { canBegin: false, stt: { health: 'UNAVAILABLE', requiresNetwork: true }, tts: { health: 'UNAVAILABLE' } } });
    await expect(h.begin()).resolves.toMatchObject({ code: 'unavailable' });
    expect(h.probeWhisper).not.toHaveBeenCalled(); expect(h.transcribe).not.toHaveBeenCalled(); expect(h.synthesize).not.toHaveBeenCalled();
  });
  it('enforces authority ownership before superseding a reserved turn', async () => {
    const h = harness(); await h.probe(); await h.begin();
    await expect(h.begin(job(2, 'bad-pet'))).resolves.toMatchObject({ code: 'unavailable' });
    await expect(h.begin(job(2, scope.petId, 'another-conversation'))).resolves.toMatchObject({ code: 'unavailable' });
    await expect(h.record()).resolves.toMatchObject({ kind: 'transcribed', text: '你好' });
  });
  it('accepts a bounded recording only in the reserved phase and synthesizes only the committed exact reply', async () => {
    const h = harness(); await h.probe(); await h.begin();
    await expect(h.speak()).resolves.toMatchObject({ code: 'canceled' });
    const audio = fixtureVoiceWav(); await expect(h.record(job(), audio)).resolves.toMatchObject({ kind: 'transcribed', text: '你好' });
    expect(h.transcribe).toHaveBeenCalledWith(config.stt, expect.objectContaining({ codec: 'wav' }), expect.any(AbortSignal));
    expect(audio.bytes[44]).not.toBe(0); expect(h.transcribe.mock.calls[0]?.[1].bytes.every(v => v === 0)).toBe(true);
    await expect(h.record()).resolves.toMatchObject({ code: 'canceled' });
    h.reply(job()); await expect(h.speak()).resolves.toMatchObject({ kind: 'synthesized', job: job() });
    expect(h.synthesize).toHaveBeenCalledExactlyOnceWith('真正已经提交的回复', voice, expect.any(AbortSignal));
    await expect(h.speak()).resolves.toMatchObject({ code: 'canceled' });
    await expect(h.service.handle({ kind: 'finish', job: job() })).resolves.toMatchObject({ kind: 'closed', changed: true });
    await expect(h.service.handle({ kind: 'finish', job: job() })).resolves.toMatchObject({ kind: 'closed', changed: false });
  });
  it('rejects malformed WAV and recording above configured maximum, no provider work', async () => {
    const h = harness({ ...config, maxRecordingMs: 100 }); await h.probe(); await h.begin();
    const corrupt = fixtureVoiceWav(100); corrupt.bytes[0] = 0;
    await expect(h.record(job(), corrupt)).resolves.toMatchObject({ code: 'invalid_audio', job: job() });
    await expect(h.record(job(), fixtureVoiceWav(101))).resolves.toMatchObject({ code: 'invalid_audio' });
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it('rejects a renderer text override and absent/mismatched committed assistant reply', async () => {
    const h = harness(); await h.probe(); await h.begin(); await h.record();
    await expect(h.service.handle({ kind: 'synthesize', job: job(), text: 'client text' })).resolves.toMatchObject({ code: 'unavailable' });
    h.reply(job(2)); await expect(h.speak()).resolves.toMatchObject({ code: 'invalid_text' });
    expect(h.synthesize).not.toHaveBeenCalled();
  });
  it('prevents replay of completed reply with fresh generation', async () => {
    const h = harness(); await h.probe(); h.reply(job());
    await expect(h.begin({ ...job(), generation: 9 })).resolves.toMatchObject({ code: 'canceled' });
  });
  it('checks changed settings before the provider and during asynchronous processing', async () => {
    const h = harness(); await h.probe(); await h.begin();
    h.update({ configRevision: 3, config }); await expect(h.record()).resolves.toMatchObject({ code: 'unavailable' });
    expect(h.transcribe).not.toHaveBeenCalled();
    await h.begin(job(2), 3);
    const late = deferred<{ text: string }>(); h.transcribe.mockImplementationOnce(() => late.promise);
    const work = h.record(job(2)); await settle(); h.update(null); late.resolve({ text: '不应展示' });
    await expect(work).resolves.toMatchObject({ code: 'unavailable' });
  });
  it('does not start another provider while canceled work ignores cancellation; stale job cannot cancel newer turn', async () => {
    const h = harness(); await h.probe(); await h.begin();
    const late = deferred<{ text: string }>(); h.transcribe.mockImplementationOnce(() => late.promise);
    const work = h.record(); await settle();
    const signal = h.transcribe.mock.calls[0]?.[2]; await h.begin(job(2)); expect(signal?.aborted).toBe(true);
    await expect(work).resolves.toMatchObject({ code: 'canceled' });
    await expect(h.cancel()).resolves.toMatchObject({ changed: false });
    await expect(h.record(job(2))).resolves.toMatchObject({ code: 'unavailable' });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    late.resolve({ text: 'old' }); await settle();
    await h.begin(job(3)); await expect(h.record(job(3))).resolves.toMatchObject({ text: '你好' });
  });
  it('enforces provider timeout without releasing the ignored-abort gate prematurely', async () => {
    vi.useFakeTimers(); const h = harness(config, 100); await h.probe(); await h.begin();
    const late = deferred<{ text: string }>(); h.transcribe.mockImplementationOnce(() => late.promise);
    const work = h.record(); await vi.advanceTimersByTimeAsync(100);
    await expect(work).resolves.toMatchObject({ code: 'timeout' });
    expect(h.transcribe.mock.calls[0]?.[2].aborted).toBe(true);
    await expect(h.probe()).resolves.toMatchObject({ status: { busy: true } });
    late.resolve({ text: 'old' }); await settle();
    await expect(h.probe()).resolves.toMatchObject({ status: { busy: false } });
  });
  it('does not synthesize if muted, zero-volume or disabled', async () => {
    for (const settings of [{ ...config, muted: true }, { ...config, volume: 0 }, { ...config, tts: { mode: 'DISABLED' as const } }]) {
      const h = harness(settings); await h.probe(); await h.begin(); await h.record(); h.reply(job());
      await expect(h.speak()).resolves.toMatchObject({ code: 'unavailable' }); expect(h.synthesize).not.toHaveBeenCalled();
    }
  });
  it('rejects malformed synthesis buffers and does not retain a playing turn', async () => {
    const h = harness(); await h.probe(); await h.begin(); await h.record(); h.reply(job());
    const corrupt = fixtureVoiceWav(); corrupt.bytes[0] = 0; h.synthesize.mockResolvedValueOnce({ audio: corrupt });
    await expect(h.speak()).resolves.toMatchObject({ code: 'invalid_audio' });
    await expect(h.service.handle({ kind: 'finish', job: job() })).resolves.toMatchObject({ changed: false });
  });
  it('re-reads the exact committed assistant after synthesis and suppresses audio if the reply was redacted during provider work', async () => {
    const h = harness(); await h.probe(); await h.begin(); await h.record(); h.reply(job());
    const late = deferred<{ audio: VoiceAudio }>(); h.synthesize.mockImplementationOnce(() => late.promise);
    const pending = h.speak(); await settle();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    h.completedAssistantText.mockReturnValue(null);
    const audio = fixtureVoiceWav(); late.resolve({ audio });
    await expect(pending).resolves.toMatchObject({ code: 'invalid_text' });
    expect(audio.bytes.every(value => value === 0)).toBe(true);
    await expect(h.service.handle({ kind: 'finish', job: job() })).resolves.toMatchObject({ changed: false });
  });
  it('rejects stale generation, empty transcript, and operations after dispose', async () => {
    const h = harness(); await h.probe(); await h.begin(job(2));
    await expect(h.begin(job(1))).resolves.toMatchObject({ code: 'canceled' });
    h.transcribe.mockResolvedValueOnce({ text: '  ' }); await expect(h.record(job(2))).resolves.toMatchObject({ code: 'no_speech' });
    h.service.dispose(); h.service.dispose(); expect(h.dispose).toHaveBeenCalledTimes(1);
    await expect(h.probe()).resolves.toMatchObject({ code: 'unavailable' });
  });
  it('strictly correlates service replies and refuses arbitrary input properties', () => {
    const request = voiceServiceRequestSchema.parse({ kind: 'begin', job: job(), expectedConfigRevision: 2 });
    expect(voiceResultMatchesRequest(request, voiceServiceResultSchema.parse({ ok: true, kind: 'begun', job: job(2), configRevision: 2 }))).toBe(false);
    expect(voiceResultMatchesRequest(request, voiceServiceResultSchema.parse({ ok: true, kind: 'begun', job: job(), configRevision: 3 }))).toBe(false);
    expect(voiceServiceRequestSchema.safeParse({ kind: 'synthesize', job: job(), modelPath: 'path' }).success).toBe(false);
  });
});
