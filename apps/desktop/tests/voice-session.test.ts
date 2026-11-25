import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG } from '../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceJob, VoiceSessionConfig } from '../../../packages/contracts/src/voice.js';
import { initialVoiceSession, reduceVoiceRequest, VoiceSessionCoordinator } from '../src/renderer/voice/voice-session';
import type { VoiceTransition } from '../src/renderer/voice/voice-session';
import { PlaybackMouthSampler, toRendererMouthSample, waveformRms } from '../src/renderer/voice/mouth-rms';
import { MouthTimeline } from '../src/renderer/rendering/mouth-timeline';

function wav(sampleRate = 16_000, channels = 1, frames = sampleRate): VoiceAudio {
  const bytes = new Uint8Array(44 + frames * channels * 2), view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return { codec: 'wav', bytes, sampleRate, channels };
}
const withTts: VoiceSessionConfig = { ...DEFAULT_LOCAL_VOICE_CONFIG,
  tts: { mode: 'LOCAL', voice: { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: 'enumerated-voice-1', locale: 'zh-CN' } } };
const beginRequest = (turn = 1, pet = 'pet-a', config: VoiceSessionConfig = withTts) => ({
  type: 'START_PTT' as const, petId: pet, conversationId: `conv-${pet}`, turnId: `voice-${turn}`, requestId: `chat-req-${turn}`, config,
});
const types = (transition: VoiceTransition) => transition.effects.map(effect => effect.type);
const clearTypes = ['STOP_PLAYBACK', 'CLEAR_MOUTH', 'RELEASE_CAPTURE'];

function begin(session: VoiceSessionCoordinator, turn = 1, pet = 'pet-a', config: VoiceSessionConfig = withTts): VoiceJob {
  const transition = session.request(beginRequest(turn, pet, config));
  expect(transition.outcome).toBe('APPLIED');
  expect(session.state.phase).toBe('RECORDING');
  return session.state.job!;
}
function reachTranscribing(session: VoiceSessionCoordinator, config: VoiceSessionConfig = withTts): VoiceJob {
  const job = begin(session, 1, 'pet-a', config);
  expect(session.event({ type: 'CAPTURE_STARTED', job }).outcome).toBe('APPLIED');
  expect(types(session.request({ type: 'STOP_PTT', job }))).toEqual(['STOP_CAPTURE', 'RELEASE_CAPTURE']);
  expect(types(session.event({ type: 'RECORDING_DONE', job, audio: wav() }))).toEqual(['START_STT']);
  return job;
}
function reachChat(session: VoiceSessionCoordinator, config: VoiceSessionConfig = withTts): VoiceJob {
  const job = reachTranscribing(session, config);
  expect(types(session.event({ type: 'STT_DONE', job, text: ' 你好 ' }))).toEqual(['SUBMIT_CHAT']);
  return job;
}
function reachTts(session: VoiceSessionCoordinator): VoiceJob {
  const job = reachChat(session);
  expect(types(session.event({ type: 'CHAT_DONE', job, requestId: job.requestId, text: '你好，伙伴！' }))).toEqual(['START_TTS']);
  return job;
}
function preparePlayback(session: VoiceSessionCoordinator): VoiceJob {
  const job = reachTts(session);
  expect(types(session.event({ type: 'TTS_DONE', job, audio: wav(24_000), visemes: [{ offsetMs: 0, id: 'a' }] }))).toEqual(['PREPARE_PLAYBACK']);
  return job;
}
function reachPlaying(session: VoiceSessionCoordinator): VoiceJob {
  const job = preparePlayback(session);
  expect(types(session.event({ type: 'PLAYBACK_STARTED', job, durationMs: 1000 }))).toEqual(['BEGIN_MOUTH']);
  return job;
}

describe('Single-channel voice state machine', () => {
  it('runs recorded PTT through the complete ordered mock pipeline with actual playback gating', () => {
    const session = new VoiceSessionCoordinator();
    expect(session.state.phase).toBe('IDLE');
    const started = session.request(beginRequest());
    const job = session.state.job!;
    expect(started.effects).toEqual([{ type: 'START_CAPTURE', job, sampleRate: 16_000, channels: 1, codec: 'wav', maxDurationMs: 30_000 }]);
    expect(session.event({ type: 'CAPTURE_STARTED', job }).state.captureStarted).toBe(true);
    expect(types(session.request({ type: 'STOP_PTT', job }))).toEqual(['STOP_CAPTURE', 'RELEASE_CAPTURE']);
    expect(session.state.phase).toBe('TRANSCRIBING');
    const rec = session.event({ type: 'RECORDING_DONE', job, audio: wav() });
    expect(rec.effects[0]).toMatchObject({ type: 'START_STT', job, config: withTts.stt });
    expect(session.state.sttStarted).toBe(true);
    expect(session.event({ type: 'STT_DONE', job, text: '  早上好  ' }).effects).toEqual([{ type: 'SUBMIT_CHAT', job, requestId: job.requestId, text: '早上好' }]);
    expect(session.state.phase).toBe('CHAT_WAIT');
    expect(session.event({ type: 'CHAT_DONE', job, requestId: job.requestId, text: '早上好！' }).effects)
      .toEqual([{ type: 'START_TTS', job, config: withTts.tts, text: '早上好！' }]);
    expect(session.state.phase).toBe('TTS_PENDING');
    expect(types(session.event({ type: 'TTS_DONE', job, audio: wav(24_000) }))).toEqual(['PREPARE_PLAYBACK']);
    expect(session.state.phase).toBe('TTS_PENDING');
    expect(session.event({ type: 'PLAYBACK_SAMPLE', job, atMs: 0, mouthOpen: .5, speaking: true }).outcome).toBe('IGNORED');
    expect(session.event({ type: 'PLAYBACK_STARTED', job, durationMs: 1000 }).effects).toEqual([{ type: 'BEGIN_MOUTH', job, durationMs: 1000 }]);
    expect(session.state.phase).toBe('PLAYING');
    const lip = session.event({ type: 'PLAYBACK_SAMPLE', job, atMs: 33.5, mouthOpen: .7, speaking: true });
    expect(lip.effects).toEqual([{ type: 'MOUTH_SAMPLE', job, sample: { petId: job.petId, turnId: job.turnId, generation: job.generation, atMs: 33.5, mouthOpen: .7, speaking: true } }]);
    const ended = session.event({ type: 'PLAYBACK_ENDED', job });
    expect(types(ended)).toEqual(clearTypes);
    expect(session.state).toMatchObject({ phase: 'IDLE', generation: job.generation + 1, job: null, replyText: '早上好！', transcript: '早上好', playbackPrepared: false });
    expect(session.state).not.toHaveProperty('audio');
    expect(session.event({ type: 'PLAYBACK_SAMPLE', job, atMs: 40, mouthOpen: 1, speaking: true }).outcome).toBe('IGNORED');
  });

  it('stops and releases a granted recorder immediately on duration-limit event just like PTT release', () => {
    const session = new VoiceSessionCoordinator();
    const job = begin(session);
    session.event({ type: 'CAPTURE_STARTED', job });
    expect(types(session.event({ type: 'RECORDING_LIMIT_REACHED', job }))).toEqual(['STOP_CAPTURE', 'RELEASE_CAPTURE']);
    expect(session.state.phase).toBe('TRANSCRIBING');
    expect(session.request({ type: 'STOP_PTT', job }).outcome).toBe('IGNORED');
  });

  it('release before microphone permission completes never transcribes and explicitly releases the late granted track', () => {
    const session = new VoiceSessionCoordinator();
    const job = begin(session);
    expect(types(session.request({ type: 'STOP_PTT', job }))).toEqual(clearTypes);
    expect(session.state).toMatchObject({ phase: 'ERROR', error: 'no_speech', job: null });
    expect(session.event({ type: 'CAPTURE_STARTED', job })).toMatchObject({ outcome: 'IGNORED', effects: [{ type: 'RELEASE_CAPTURE', job }] });
    expect(session.event({ type: 'RECORDING_DONE', job, audio: wav() }).outcome).toBe('IGNORED');
  });

  it('requires each exact phase and suppresses duplicate completion before side effects', () => {
    const session = new VoiceSessionCoordinator(), job = begin(session);
    expect(session.event({ type: 'STT_DONE', job, text: 'premature' }).outcome).toBe('IGNORED');
    expect(session.event({ type: 'RECORDING_DONE', job, audio: wav() }).outcome).toBe('IGNORED');
    session.event({ type: 'CAPTURE_STARTED', job });
    expect(session.event({ type: 'CAPTURE_STARTED', job }).effects).toEqual([]);
    session.request({ type: 'STOP_PTT', job });
    session.event({ type: 'RECORDING_DONE', job, audio: wav() });
    expect(session.event({ type: 'RECORDING_DONE', job, audio: wav() }).outcome).toBe('IGNORED');
    session.event({ type: 'STT_DONE', job, text: 'text' });
    expect(session.event({ type: 'STT_DONE', job, text: 'duplicate' }).outcome).toBe('IGNORED');
    session.event({ type: 'CHAT_DONE', job, requestId: job.requestId, text: 'reply' });
    expect(session.event({ type: 'PLAYBACK_STARTED', job, durationMs: 1000 }).outcome).toBe('IGNORED');
    session.event({ type: 'TTS_DONE', job, audio: wav() });
    expect(session.event({ type: 'TTS_DONE', job, audio: wav() }).outcome).toBe('IGNORED');
  });

  it('rejects invalid request and event shapes without mutating the active job', () => {
    const session = new VoiceSessionCoordinator();
    expect(session.request({ ...beginRequest(), generation: 123 }).outcome).toBe('INVALID');
    const job = reachTranscribing(session);
    const state = session.state;
    expect(session.event({ type: 'STT_DONE', job, text: 'text', audioPath: 'tmp.wav' }).outcome).toBe('INVALID');
    expect(session.event({ type: 'STT_DONE', job: { ...job, generation: -1 }, text: 'text' }).outcome).toBe('INVALID');
    expect(session.state).toBe(state);
  });

  it('drops callbacks with different pet, conversation, turn, request or generation even if their phase matches', () => {
    const session = new VoiceSessionCoordinator(), job = reachTranscribing(session);
    for (const changes of [{ petId: 'pet-b' }, { conversationId: 'other' }, { turnId: 'other' }, { requestId: 'other' }, { generation: job.generation + 1 }]) {
      expect(session.event({ type: 'STT_DONE', job: { ...job, ...changes }, text: 'wrong' }).outcome).toBe('IGNORED');
    }
    expect(session.state.phase).toBe('TRANSCRIBING');
    expect(session.event({ type: 'STT_DONE', job, text: 'right' }).state.transcript).toBe('right');
  });

  it('rejects previous-phase failures, wrong chat response request and duplicate begin gestures', () => {
    const session = new VoiceSessionCoordinator(), job = reachChat(session);
    expect(session.request(beginRequest()).outcome).toBe('IGNORED');
    expect(session.event({ type: 'FAILED', job, phase: 'TRANSCRIBING', code: 'timeout' }).outcome).toBe('IGNORED');
    expect(session.event({ type: 'CHAT_DONE', job, requestId: 'other-chat', text: 'wrong' }).outcome).toBe('INVALID');
    expect(session.state.phase).toBe('CHAT_WAIT');
  });

  it('enforces the selected job recording duration even within the global WAV cap', () => {
    const session = new VoiceSessionCoordinator(), job = begin(session, 1, 'pet-a', { ...withTts, maxRecordingMs: 100 });
    session.event({ type: 'CAPTURE_STARTED', job }); session.request({ type: 'STOP_PTT', job });
    const result = session.event({ type: 'RECORDING_DONE', job, audio: wav(16_000, 1, 1601) });
    expect(result.state).toMatchObject({ phase: 'ERROR', error: 'invalid_audio', job: null });
    expect(types(result)).toEqual(clearTypes);
    expect(result.effects.some(effect => effect.type === 'START_STT')).toBe(false);
  });

  it('copies validated audio away from caller mutation and never retains audio in state', () => {
    const session = new VoiceSessionCoordinator(), job = begin(session);
    session.event({ type: 'CAPTURE_STARTED', job }); session.request({ type: 'STOP_PTT', job });
    const audio = wav();
    const effect = session.event({ type: 'RECORDING_DONE', job, audio }).effects[0];
    if (!effect || effect.type !== 'START_STT') throw new Error('Expected STT input');
    audio.bytes[0] = 0;
    expect(effect.audio.bytes[0]).toBe('R'.charCodeAt(0));
    expect(session.state).not.toHaveProperty('audio');
    expect(Object.isFrozen(session.state.config?.stt)).toBe(true);
  });
});

describe('Cancellation, local/cloud separation and text fallback', () => {
  it.each([
    ['capture permission', (session: VoiceSessionCoordinator) => begin(session), 'RECORDING', []],
    ['STT', reachTranscribing, 'TRANSCRIBING', ['CANCEL_STT']],
    ['chat', reachChat, 'CHAT_WAIT', ['CANCEL_CHAT']],
    ['TTS', reachTts, 'TTS_PENDING', ['CANCEL_TTS']],
    ['prepared playback', preparePlayback, 'TTS_PENDING', []],
    ['playing', reachPlaying, 'PLAYING', []],
  ] as const)('cancels %s, invalidates generation and clears old resources immediately', (_, prepare, phase, extra) => {
    const session = new VoiceSessionCoordinator(), job = prepare(session);
    expect(session.state.phase).toBe(phase);
    const stopped = session.request({ type: 'CANCEL', job, reason: 'USER' });
    expect(types(stopped)).toEqual([...clearTypes, ...extra]);
    expect(stopped.state).toMatchObject({ phase: 'CANCELLED', job: null, cancelReason: 'USER', generation: job.generation + 1 });
    if (phase === 'CHAT_WAIT') expect(stopped.effects.find(effect => effect.type === 'CANCEL_CHAT')).toEqual({ type: 'CANCEL_CHAT', job, requestId: job.requestId });
    expect(session.event({ type: 'FAILED', job, phase, code: 'timeout' }).outcome).toBe('IGNORED');
    expect(session.request({ type: 'CANCEL', job, reason: 'USER' }).effects).toEqual([]);
  });

  it('new PTT stops the old sound and mouth before opening a different pet capture', () => {
    const session = new VoiceSessionCoordinator(), old = reachPlaying(session);
    const replacement = session.request(beginRequest(2, 'pet-b'));
    const current = replacement.state.job!;
    expect(types(replacement)).toEqual([...clearTypes, 'START_CAPTURE']);
    expect(replacement.effects.slice(0, 3).every(effect => effect.job.generation === old.generation)).toBe(true);
    expect(replacement.effects[3]?.job).toBe(current);
    expect(current.petId).toBe('pet-b'); expect(current.generation).toBeGreaterThan(old.generation);
    expect(session.event({ type: 'PLAYBACK_STARTED', job: old, durationMs: 1000 }).outcome).toBe('IGNORED');
    expect(session.event({ type: 'CAPTURE_STARTED', job: old }).effects).toEqual([{ type: 'RELEASE_CAPTURE', job: old }]);
    expect(session.state.job).toBe(current);
  });

  it('switching active pet clears previous ephemeral text and cancels only the old owned chat', () => {
    const session = new VoiceSessionCoordinator(), old = reachChat(session);
    const switched = session.request({ type: 'SELECT_PET', petId: 'pet-b' });
    expect(switched.state).toMatchObject({ selectedPetId: 'pet-b', job: null, phase: 'CANCELLED', cancelReason: 'PET_SWITCH', transcript: null, replyText: null });
    expect(switched.effects.find(effect => effect.type === 'CANCEL_CHAT')).toEqual({ type: 'CANCEL_CHAT', job: old, requestId: old.requestId });
    expect(session.event({ type: 'CHAT_DONE', job: old, requestId: old.requestId, text: 'late' }).outcome).toBe('IGNORED');
  });

  it('mutes the current pet immediately, clears the old mouth and never resumes on unmute', () => {
    const session = new VoiceSessionCoordinator(), old = reachPlaying(session);
    expect(session.request({ type: 'SET_MUTED', petId: 'pet-b', muted: true }).outcome).toBe('IGNORED');
    const muted = session.request({ type: 'SET_MUTED', petId: old.petId, muted: true });
    expect(types(muted)).toEqual(clearTypes);
    expect(muted.state).toMatchObject({ muted: true, phase: 'CANCELLED', replyText: '你好，伙伴！', cancelReason: 'MUTED' });
    expect(session.request({ type: 'SET_MUTED', petId: old.petId, muted: false }).effects).toEqual([]);
    expect(session.event({ type: 'PLAYBACK_SAMPLE', job: old, atMs: 40, mouthOpen: 1, speaking: true }).outcome).toBe('IGNORED');
    expect(session.state.phase).toBe('CANCELLED');
  });

  it('empty STT returns text fallback cleanly and never submits a chat or synth request', () => {
    const session = new VoiceSessionCoordinator(), job = reachTranscribing(session);
    const failure = session.event({ type: 'STT_DONE', job, text: '   \n\t' });
    expect(failure.state).toMatchObject({ phase: 'ERROR', error: 'no_speech', transcript: null });
    expect(types(failure)).toEqual(clearTypes);
  });

  it('never falls back from local STT to a cloud provider when local recognition fails', () => {
    const session = new VoiceSessionCoordinator(), job = reachTranscribing(session);
    const failure = session.event({ type: 'FAILED', job, phase: 'TRANSCRIBING', code: 'unavailable' });
    expect(failure.state).toMatchObject({ phase: 'ERROR', error: 'unavailable' });
    expect(types(failure)).toEqual([...clearTypes, 'CANCEL_STT']);
    expect(failure.effects.some(effect => effect.type === 'START_STT' || effect.type === 'SUBMIT_CHAT')).toBe(false);
  });

  it('uses exactly the explicit STT cloud scope when selected, with no alternate provider retry', () => {
    const session = new VoiceSessionCoordinator();
    const cloud = { mode: 'CLOUD', providerId: 'AZURE_FAST_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'consent-ref-1' } } as const;
    const job = begin(session, 1, 'pet-a', { ...withTts, stt: cloud });
    session.event({ type: 'CAPTURE_STARTED', job }); session.request({ type: 'STOP_PTT', job });
    expect(session.event({ type: 'RECORDING_DONE', job, audio: wav() }).effects[0]).toMatchObject({ type: 'START_STT', config: cloud });
    expect(types(session.event({ type: 'FAILED', job, phase: 'TRANSCRIBING', code: 'network' }))).toEqual([...clearTypes, 'CANCEL_STT']);
  });

  it.each([
    DEFAULT_LOCAL_VOICE_CONFIG, { ...withTts, muted: true }, { ...withTts, volume: 0 },
  ] as const)('keeps the full text when TTS is disabled, muted or inaudible', (config) => {
    const session = new VoiceSessionCoordinator(), job = reachChat(session, config);
    const result = session.event({ type: 'CHAT_DONE', job, requestId: job.requestId, text: '仍可文字聊天' });
    expect(result.state).toMatchObject({ phase: 'IDLE', transcript: '你好', replyText: '仍可文字聊天' });
    expect(types(result)).toEqual(clearTypes);
  });

  it('TTS voice missing preserves completed text and never resubmits the chat or previous WAV', () => {
    const session = new VoiceSessionCoordinator(), job = reachTts(session);
    const result = session.event({ type: 'FAILED', job, phase: 'TTS_PENDING', code: 'voice_missing' });
    expect(result.state).toMatchObject({ phase: 'ERROR', error: 'voice_missing', replyText: '你好，伙伴！', transcript: '你好' });
    expect(types(result)).toEqual([...clearTypes, 'CANCEL_TTS']);
    expect(session.event({ type: 'TTS_DONE', job, audio: wav() }).outcome).toBe('IGNORED');
  });

  it('playback duration must match the prepared verified PCM and invalid playback cannot open a mouth', () => {
    const session = new VoiceSessionCoordinator(), job = preparePlayback(session);
    const result = session.event({ type: 'PLAYBACK_STARTED', job, durationMs: 2000 });
    expect(result.state).toMatchObject({ phase: 'ERROR', error: 'playback_failed', replyText: '你好，伙伴！' });
    expect(types(result)).toEqual(clearTypes);
  });

  it('rejects duplicate, backwards or outside actual playback positions and accepts an immediate closed sample', () => {
    const session = new VoiceSessionCoordinator(), job = reachPlaying(session);
    const sample = { type: 'PLAYBACK_SAMPLE', job, atMs: 55, mouthOpen: .45, speaking: true };
    expect(session.event(sample).outcome).toBe('APPLIED');
    expect(session.event(sample).outcome).toBe('IGNORED');
    expect(session.event({ ...sample, atMs: 54 }).outcome).toBe('IGNORED');
    expect(session.event({ ...sample, atMs: 1001 }).outcome).toBe('IGNORED');
    expect(session.event({ ...sample, atMs: 60, speaking: false, mouthOpen: 0 }).effects[0]).toMatchObject({ type: 'MOUTH_SAMPLE', sample: { mouthOpen: 0, speaking: false } });
  });

  it('handles 100 interleaved selections/interruptions across three pets without old callbacks changing the active channel', () => {
    const session = new VoiceSessionCoordinator();
    let previous: VoiceJob | null = null;
    for (let i = 1; i <= 100; i++) {
      const pet = `pet-${i % 3}`;
      session.request({ type: 'SELECT_PET', petId: pet });
      const job = begin(session, i, pet);
      if (previous) {
        const result = session.event({ type: 'CAPTURE_STARTED', job: previous });
        expect(result.outcome).toBe('IGNORED');
        expect(result.effects).toEqual([{ type: 'RELEASE_CAPTURE', job: previous }]);
      }
      session.event({ type: 'CAPTURE_STARTED', job });
      expect(session.state.job?.petId).toBe(pet);
      expect(session.state.generation).toBe(job.generation);
      previous = job;
    }
  });

  it('reserves a generation for terminal cleanup, and RESET cannot silently kill an active job', () => {
    const almostExhausted = { ...initialVoiceSession(), generation: Number.MAX_SAFE_INTEGER - 1 };
    expect(reduceVoiceRequest(almostExhausted, beginRequest()).outcome).toBe('INVALID');
    const session = new VoiceSessionCoordinator(), job = begin(session);
    expect(session.request({ type: 'RESET' }).outcome).toBe('IGNORED');
    session.request({ type: 'CANCEL', job, reason: 'USER' });
    expect(session.request({ type: 'RESET' }).state.phase).toBe('IDLE');
    expect(session.request(beginRequest()).outcome).toBe('IGNORED'); // duplicate old turn
  });
});

describe('Actual-audio-clock RMS and mouth adapter compatibility', () => {
  const job: VoiceJob = { petId: 'pet-a', conversationId: 'conv-a', turnId: 'voice-1', requestId: 'chat-1', generation: 5 };
  it('calculates finite bounded RMS and refuses malformed or oversized analyser samples', () => {
    expect(waveformRms(new Float32Array([1, -1, 0, 0]))).toBeCloseTo(Math.sqrt(.5));
    expect(waveformRms(new Float32Array([2, -2]))).toBe(1);
    expect(waveformRms(new Float32Array([NaN]))).toBeNull();
    expect(waveformRms(new Float32Array(0))).toBeNull();
    expect(waveformRms(new Float32Array(8193))).toBeNull();
  });

  it('uses the actual monotonic playback position, normalized openness and bounded sample cadence', () => {
    const sampler = new PlaybackMouthSampler({ attackMs: 0, releaseMs: 0 });
    expect(sampler.sample(job, 0, new Float32Array([1]))).toBeNull();
    expect(sampler.begin(job, 1000)).toBe(true);
    const initial = sampler.sample(job, 10, new Float32Array([1, -1]));
    expect(initial).toMatchObject({ generation: 5, petId: 'pet-a', turnId: 'voice-1', atMs: 10, mouthOpen: 1, speaking: true });
    expect(sampler.sample(job, 10, new Float32Array([1]))).toBeNull();
    expect(sampler.sample(job, 9, new Float32Array([1]))).toBeNull();
    expect(sampler.sample(job, 20, new Float32Array([1]))).toBeNull();
    expect(sampler.sample(job, 1100, new Float32Array([1]))).toBeNull();
    expect(sampler.sample(job, 45, new Float32Array([0]))).toMatchObject({ mouthOpen: 0, speaking: false, atMs: 45 });
  });

  it('smooths attack and release, suppresses noise and eventually closes during actual silence', () => {
    const sampler = new PlaybackMouthSampler({ noiseFloor: .02, gain: 10, attackMs: 40, releaseMs: 80 });
    sampler.begin(job, 2000);
    expect(sampler.sample(job, 0, new Float32Array([.01]))).toMatchObject({ mouthOpen: 0, speaking: false });
    const a = sampler.sample(job, 40, new Float32Array([1]))!.mouthOpen;
    const b = sampler.sample(job, 80, new Float32Array([1]))!.mouthOpen;
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(b).toBeLessThanOrEqual(1);
    const c = sampler.sample(job, 120, new Float32Array([0]))!.mouthOpen;
    expect(c).toBeLessThan(b); expect(c).toBeGreaterThan(0);
    expect(sampler.sample(job, 1000, new Float32Array([0]))).toMatchObject({ mouthOpen: 0, speaking: false });
  });

  it('does not consume future visemes early and drops stale ones according to actual playback time', () => {
    const sampler = new PlaybackMouthSampler({ attackMs: 0, releaseMs: 0 });
    expect(sampler.begin(job, 1000, [{ offsetMs: 100, id: 'a' }, { offsetMs: 200, id: 'i' }])).toBe(true);
    expect(sampler.sample(job, 0, new Float32Array([1]))?.viseme).toBeUndefined();
    expect(sampler.sample(job, 120, new Float32Array([1]))?.viseme).toBe('a');
    expect(sampler.sample(job, 220, new Float32Array([1]))?.viseme).toBe('i');
    expect(sampler.sample(job, 600, new Float32Array([1]))?.viseme).toBeUndefined();
    expect(sampler.sample(job, 650, new Float32Array([0]))?.viseme).toBeUndefined();
  });

  it('cancellation closes immediately, forbids same generation restart and projects only compatible MouthSample', () => {
    const sampler = new PlaybackMouthSampler({ attackMs: 0 });
    const timeline = new MouthTimeline({ smoothingMs: 0 });
    sampler.begin(job, 1000); timeline.begin(job.generation);
    const raw = sampler.sample(job, 0, new Float32Array([1]))!;
    const projected = toRendererMouthSample(raw);
    expect(projected).toEqual({ generation: 5, open: 1, atMs: 0 });
    expect(timeline.push(projected)).toBe(true);
    expect(timeline.sampleAt(0).open).toBe(1);
    expect(sampler.cancel(job)).toBe(true); timeline.cancel();
    expect(sampler.currentOpen).toBe(0); expect(timeline.current.open).toBe(0);
    expect(sampler.sample(job, 100, new Float32Array([1]))).toBeNull();
    expect(sampler.begin(job, 1000)).toBe(false);
    const next = { ...job, petId: 'pet-b', generation: 6, turnId: 'next' };
    expect(sampler.begin(next, 1000)).toBe(true);
    expect(sampler.sample(job, 100, new Float32Array([1]))).toBeNull();
    expect(sampler.cancel(job)).toBe(false);
    expect(sampler.sample(next, 0, new Float32Array([1]))).toMatchObject({ petId: 'pet-b', generation: 6, mouthOpen: 1 });
  });
});
