import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_VOICE_CONFIG, inspectVoiceAudio, MAX_VOICE_AUDIO_BYTES, MAX_VOICE_TEXT_LENGTH,
  voiceAudioSchema, voiceEventSchema, voiceJobSchema, voiceMouthSampleSchema, voiceProviderStatusSchema,
  voiceRecordingAudioSchema, voiceRefSchema, voiceRequestSchema, voiceSessionConfigSchema,
  voiceSttConfigSchema, voiceTtsConfigSchema } from '../src/voice.js';
import type { VoiceAudio, VoiceJob } from '../src/voice.js';

function writeTag(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}
function wav(sampleRate = 16_000, channels = 1, frames = 160): VoiceAudio {
  const size = frames * channels * 2;
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  writeTag(bytes, 0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); writeTag(bytes, 8, 'WAVE');
  writeTag(bytes, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  writeTag(bytes, 36, 'data'); view.setUint32(40, size, true);
  return { bytes, codec: 'wav', sampleRate, channels };
}
const raw = (sampleRate = 24_000, channels = 2, frames = 240): VoiceAudio => ({
  bytes: new Uint8Array(frames * channels * 2), codec: 'pcm_s16le', sampleRate, channels,
});
const job: VoiceJob = { petId: 'pet-1', conversationId: 'conv-1', turnId: 'voice-turn-1', generation: 4, requestId: 'chat-req-1' };
const cloudSTT = { mode: 'CLOUD', providerId: 'AZURE_FAST_TRANSCRIPTION', consent: { scope: 'STT_AUDIO', authorizationId: 'accepted-stt-1' } };
const cloudTTS = { mode: 'CLOUD', voice: { providerId: 'AZURE_NEURAL_TTS', voiceId: 'zh-CN-standard-1', locale: 'zh-CN' },
  consent: { scope: 'TTS_TEXT', authorizationId: 'accepted-tts-1' } };

describe('Closed standalone voice scope and task identity contracts', () => {
  it('defaults to explicit local multilingual STT and no fabricated installed voice or cloud setting', () => {
    expect(voiceSessionConfigSchema.safeParse(DEFAULT_LOCAL_VOICE_CONFIG).success).toBe(true);
    expect(DEFAULT_LOCAL_VOICE_CONFIG.stt).toMatchObject({ mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'MULTILINGUAL_BASE' });
    expect(DEFAULT_LOCAL_VOICE_CONFIG.tts).toEqual({ mode: 'DISABLED' });
    expect(DEFAULT_LOCAL_VOICE_CONFIG.maxRecordingMs).toBe(30_000);
  });

  it('requires separate, explicit, correctly scoped cloud STT and TTS consent references', () => {
    expect(voiceSttConfigSchema.safeParse(cloudSTT).success).toBe(true);
    expect(voiceTtsConfigSchema.safeParse(cloudTTS).success).toBe(true);
    expect(voiceSessionConfigSchema.safeParse({ ...DEFAULT_LOCAL_VOICE_CONFIG, stt: cloudSTT, tts: cloudTTS }).success).toBe(true);
    expect(voiceSttConfigSchema.safeParse({ ...cloudSTT, consent: undefined }).success).toBe(false);
    expect(voiceTtsConfigSchema.safeParse({ ...cloudTTS, consent: undefined }).success).toBe(false);
    expect(voiceSttConfigSchema.safeParse({ ...cloudSTT, consent: cloudTTS.consent }).success).toBe(false);
    expect(voiceTtsConfigSchema.safeParse({ ...cloudTTS, consent: cloudSTT.consent }).success).toBe(false);
  });

  it('rejects provider credentials, endpoints, arbitrary binaries or model paths, and implicit fallback routing', () => {
    for (const extra of [{ apiKey: 'secret' }, { endpoint: 'https://example.invalid' }, { modelPath: '/tmp/arbitrary' }, { exe: 'x.exe' }, { fallback: cloudSTT }]) {
      expect(voiceSttConfigSchema.safeParse({ ...DEFAULT_LOCAL_VOICE_CONFIG.stt, ...extra }).success).toBe(false);
    }
    expect(voiceSttConfigSchema.safeParse({ mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'CUSTOM_PATH' }).success).toBe(false);
    expect(voiceSttConfigSchema.safeParse({ ...cloudSTT, providerId: 'WHISPER_CPP' }).success).toBe(false);
    expect(voiceTtsConfigSchema.safeParse({ ...cloudTTS, voice: { ...cloudTTS.voice, providerId: 'WINDOWS_SYSTEM_SPEECH' } }).success).toBe(false);
    expect(voiceSessionConfigSchema.safeParse({ ...DEFAULT_LOCAL_VOICE_CONFIG, authorizationId: 'generic' }).success).toBe(false);
  });

  it('limits a voice reference to a bounded enumerated opaque ID, supported locale and playback rate', () => {
    const voice = { providerId: 'WINDOWS_SYSTEM_SPEECH', voiceId: 'installed-enum-id', locale: 'zh-CN', rate: 1.2 };
    expect(voiceRefSchema.safeParse(voice).success).toBe(true);
    for (const patch of [{ locale: 'https://foo' }, { voiceId: '../arbitrary' }, { voiceId: 'C:\\voice' }, { rate: 0 }, { rate: 3 }, { key: 'secret' }]) {
      expect(voiceRefSchema.safeParse({ ...voice, ...patch }).success).toBe(false);
    }
    expect(voiceSessionConfigSchema.safeParse({ ...DEFAULT_LOCAL_VOICE_CONFIG, volume: -1 }).success).toBe(false);
    expect(voiceSessionConfigSchema.safeParse({ ...DEFAULT_LOCAL_VOICE_CONFIG, maxRecordingMs: 31_000 }).success).toBe(false);
  });

  it('rejects locality/capability contradictions in provider health projections', () => {
    const local = { providerId: 'WHISPER_CPP', requiresNetwork: false, health: 'READY', capabilities: ['STT'] };
    expect(voiceProviderStatusSchema.safeParse(local).success).toBe(true);
    expect(voiceProviderStatusSchema.safeParse({ providerId: 'AZURE_NEURAL_TTS', requiresNetwork: true, health: 'READY', capabilities: ['TTS', 'VISEME'] }).success).toBe(true);
    for (const patch of [{ requiresNetwork: true }, { capabilities: ['STT', 'TTS'] }, { capabilities: ['STT', 'STT'] }, { health: 'secret-exception' }]) {
      expect(voiceProviderStatusSchema.safeParse({ ...local, ...patch }).success).toBe(false);
    }
  });

  it('requires exact job identities; START_PTT cannot set its own next generation', () => {
    const start = { type: 'START_PTT', petId: job.petId, conversationId: job.conversationId, turnId: job.turnId, requestId: job.requestId, config: DEFAULT_LOCAL_VOICE_CONFIG };
    expect(voiceRequestSchema.safeParse(start).success).toBe(true);
    expect(voiceRequestSchema.safeParse({ ...start, generation: 100 }).success).toBe(false);
    expect(voiceJobSchema.safeParse({ ...job, generation: -1 }).success).toBe(false);
    expect(voiceJobSchema.safeParse({ ...job, generation: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(voiceJobSchema.safeParse({ ...job, conversationId: '../other' }).success).toBe(false);
    expect(voiceRequestSchema.safeParse({ type: 'CANCEL', job, reason: 'USER' }).success).toBe(true);
    expect(voiceRequestSchema.safeParse({ type: 'CANCEL', job, reason: 'kill-all' }).success).toBe(false);
  });
});

describe('Bounded structured PCM/WAV validation', () => {
  it('probes exact RIFF PCM16 frames, offsets, channel and sample metadata', () => {
    expect(inspectVoiceAudio(wav())).toEqual({ frames: 160, durationMs: 10, pcmOffset: 44, pcmBytes: 320, sampleRate: 16_000, channels: 1 });
    expect(voiceAudioSchema.safeParse(wav(24_000, 2, 240)).success).toBe(true);
    expect(inspectVoiceAudio(raw())).toEqual({ frames: 240, durationMs: 10, pcmOffset: 0, pcmBytes: 960, sampleRate: 24_000, channels: 2 });
  });

  it('allows bounded padded metadata before PCM data without mislocating the frames', () => {
    const original = wav();
    const bytes = new Uint8Array(original.bytes.length + 10);
    bytes.set(original.bytes.subarray(0, 12)); bytes.set(original.bytes.subarray(12), 22);
    writeTag(bytes, 12, 'JUNK'); const view = new DataView(bytes.buffer); view.setUint32(16, 1, true); bytes[20] = 42;
    view.setUint32(4, bytes.length - 8, true);
    expect(inspectVoiceAudio({ ...original, bytes })).toMatchObject({ pcmOffset: 54, frames: 160, durationMs: 10 });
    expect(voiceAudioSchema.safeParse({ ...original, bytes }).success).toBe(true);
  });

  it('rejects malformed RIFF header, length, truncated chunk, wrong tags and trailing partial bytes', () => {
    const original = wav();
    for (const mutate of [
      (bytes: Uint8Array) => { bytes[0] = 0; },
      (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(4, 1, true); },
      (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(40, 10_000_000, true); },
      (bytes: Uint8Array) => { writeTag(bytes, 12, 'junk'); },
      (bytes: Uint8Array) => { writeTag(bytes, 36, 'junk'); },
    ]) {
      const bytes = original.bytes.slice(); mutate(bytes);
      expect(voiceAudioSchema.safeParse({ ...original, bytes }).success).toBe(false);
    }
    expect(voiceAudioSchema.safeParse({ ...original, bytes: original.bytes.slice(0, -1) }).success).toBe(false);
  });

  it('rejects compressed/floating point formats, wrong PCM frame alignment and metadata mismatch', () => {
    const original = wav();
    for (const [offset, value] of [[20, 3], [22, 2], [32, 4], [34, 8]] as const) {
      const bytes = original.bytes.slice(); new DataView(bytes.buffer).setUint16(offset, value, true);
      expect(voiceAudioSchema.safeParse({ ...original, bytes }).success).toBe(false);
    }
    const bytes = original.bytes.slice(); new DataView(bytes.buffer).setUint32(28, 1, true);
    expect(voiceAudioSchema.safeParse({ ...original, bytes }).success).toBe(false);
    expect(voiceAudioSchema.safeParse({ ...original, sampleRate: 24_000 }).success).toBe(false);
    expect(voiceAudioSchema.safeParse({ ...raw(), bytes: new Uint8Array(3) }).success).toBe(false);
  });

  it('rejects nonbinary/base64, shared mutable buffers, unsupported rates/channels and byte/duration overflow', () => {
    for (const bytes of [[1, 2], 'AQI=', new ArrayBuffer(2), new Uint8Array(new SharedArrayBuffer(2)), new Uint8Array(0)]) {
      expect(voiceAudioSchema.safeParse({ ...raw(), bytes }).success).toBe(false);
    }
    expect(voiceAudioSchema.safeParse({ ...raw(), bytes: new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1) }).success).toBe(false);
    expect(voiceAudioSchema.safeParse(raw(8_000, 1, 8_000 * 61)).success).toBe(false);
    for (const sampleRate of [1, 16_000.5, 192_000]) expect(voiceAudioSchema.safeParse({ ...raw(), sampleRate }).success).toBe(false);
    expect(voiceAudioSchema.safeParse({ ...raw(), channels: 3 }).success).toBe(false);
  });

  it('limits recorded PTT input to at most 30 seconds of mono 16 kHz WAV PCM16', () => {
    expect(voiceRecordingAudioSchema.safeParse(wav(16_000, 1, 16_000 * 30)).success).toBe(true);
    for (const bad of [wav(16_000, 1, 16_000 * 30 + 1), wav(24_000, 1), wav(16_000, 2), raw(16_000, 1)]) {
      expect(voiceRecordingAudioSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('Voice adapter events and narrow mouth stream', () => {
  it('binds the final chat response to the exact voice-owned request ID only', () => {
    expect(voiceEventSchema.safeParse({ type: 'CHAT_DONE', job, requestId: job.requestId, text: '回复' }).success).toBe(true);
    expect(voiceEventSchema.safeParse({ type: 'CHAT_DONE', job, requestId: 'another-text-chat', text: '回复' }).success).toBe(false);
    expect(voiceEventSchema.safeParse({ type: 'STT_DONE', job, text: ' ' }).success).toBe(true); // reducer handles no speech
    expect(voiceEventSchema.safeParse({ type: 'STT_DONE', job, text: 'a'.repeat(MAX_VOICE_TEXT_LENGTH + 1) }).success).toBe(false);
  });

  it('bounds ordered visemes by the actual validated WAV playback duration', () => {
    const audio = wav(24_000, 1, 24_000);
    const event = { type: 'TTS_DONE', job, audio, visemes: [{ offsetMs: 0, id: 'a' }, { offsetMs: 500.5, id: 'i' }] };
    expect(voiceEventSchema.safeParse(event).success).toBe(true);
    for (const visemes of [[{ offsetMs: 0, id: 'a' }, { offsetMs: 0, id: 'i' }], [{ offsetMs: 1001, id: 'a' }], [{ offsetMs: -1, id: 'a' }], [{ offsetMs: 0, id: '../x' }]]) {
      expect(voiceEventSchema.safeParse({ ...event, visemes }).success).toBe(false);
    }
  });

  it('validates finite normalized actual-clock scalar samples and closes non-speaking mouths', () => {
    const sample = { petId: job.petId, turnId: job.turnId, generation: job.generation, atMs: 103.5, mouthOpen: .5, speaking: true };
    expect(voiceMouthSampleSchema.safeParse(sample).success).toBe(true);
    expect(voiceMouthSampleSchema.safeParse({ ...sample, speaking: false, mouthOpen: 0 }).success).toBe(true);
    for (const patch of [{ atMs: Infinity }, { atMs: -1 }, { mouthOpen: 1.1 }, { mouthOpen: NaN }, { speaking: false }, { audio: wav() }, { text: 'private' }]) {
      expect(voiceMouthSampleSchema.safeParse({ ...sample, ...patch }).success).toBe(false);
    }
    expect(voiceMouthSampleSchema.safeParse({ ...sample, speaking: false, mouthOpen: 0, viseme: 'a' }).success).toBe(false);
  });

  it('requires closed provider failure and playback event shapes without raw exception/capture paths', () => {
    const failure = { type: 'FAILED', job, phase: 'TRANSCRIBING', code: 'network' };
    expect(voiceEventSchema.safeParse(failure).success).toBe(true);
    expect(voiceEventSchema.safeParse({ ...failure, stack: 'private stack' }).success).toBe(false);
    expect(voiceEventSchema.safeParse({ ...failure, code: 'server said raw exception' }).success).toBe(false);
    expect(voiceEventSchema.safeParse({ ...failure, phase: 'IDLE' }).success).toBe(false);
    expect(voiceEventSchema.safeParse({ type: 'PLAYBACK_STARTED', job, durationMs: 0 }).success).toBe(false);
    expect(voiceEventSchema.safeParse({ type: 'RECORDING_DONE', job, path: 'temp.wav' }).success).toBe(false);
  });
});
