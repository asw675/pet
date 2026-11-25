import { z } from 'zod';

// Standalone voice DTOs: structured binary and stable identifiers only. No
// filesystem path, URL, credentials, free-form provider configuration or OS API.
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const providerVoiceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const locale = z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,5}$/u).max(48);
const safeNonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MAX_VOICE_RECORDING_MS = 30_000;
export const MAX_VOICE_AUDIO_MS = 60_000;
export const MAX_VOICE_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_VOICE_TEXT_LENGTH = 16_384;
const minSampleRate = 8_000;
const maxSampleRate = 48_000;
const audioTime = z.number().min(0).max(MAX_VOICE_AUDIO_MS);
const normalizedOpen = z.number().min(0).max(1);

export const voicePhaseSchema = z.enum(['IDLE', 'RECORDING', 'TRANSCRIBING', 'CHAT_WAIT', 'TTS_PENDING', 'PLAYING', 'CANCELLED', 'ERROR']);
export type VoicePhase = z.infer<typeof voicePhaseSchema>;
export const activeVoicePhaseSchema = z.enum(['RECORDING', 'TRANSCRIBING', 'CHAT_WAIT', 'TTS_PENDING', 'PLAYING']);
export const voiceErrorCodeSchema = z.enum([
  'permission_denied', 'unavailable', 'no_speech', 'timeout', 'network', 'voice_missing', 'canceled',
  'invalid_audio', 'invalid_text', 'device_lost', 'playback_failed',
]);
export type VoiceErrorCode = z.infer<typeof voiceErrorCodeSchema>;
export const voiceCancelReasonSchema = z.enum(['USER', 'FOCUS_LOST', 'DEVICE_LOST', 'SUSPEND', 'PET_SWITCH', 'REPLACED', 'MUTED']);
export type VoiceCancelReason = z.infer<typeof voiceCancelReasonSchema>;

export const voiceJobSchema = z.strictObject({
  petId: identity, conversationId: identity, turnId: identity, generation: safeNonnegative, requestId: identity.optional(),
});
export type VoiceJob = z.infer<typeof voiceJobSchema>;

export const sttProviderIdSchema = z.enum(['WHISPER_CPP', 'AZURE_FAST_TRANSCRIPTION', 'OPENAI_TRANSCRIPTION']);
export const ttsProviderIdSchema = z.enum(['WINDOWS_SYSTEM_SPEECH', 'AZURE_NEURAL_TTS']);
export const voiceProviderIdSchema = z.union([sttProviderIdSchema, ttsProviderIdSchema]);
export type VoiceProviderId = z.infer<typeof voiceProviderIdSchema>;

export const voiceRefSchema = z.strictObject({
  providerId: ttsProviderIdSchema, voiceId: providerVoiceId, locale, rate: z.number().min(0.5).max(2).optional(),
});
export type VoiceRef = z.infer<typeof voiceRefSchema>;

// These consent references are scope-qualified identities, not credentials
// or proof of permission. The eventual app-service must independently verify
// each reference against explicit persisted provider consent before networking.
export const sttConsentSchema = z.strictObject({ scope: z.literal('STT_AUDIO'), authorizationId: identity });
export const ttsConsentSchema = z.strictObject({ scope: z.literal('TTS_TEXT'), authorizationId: identity });
export const voiceSttConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('LOCAL'), providerId: z.literal('WHISPER_CPP'), modelId: z.enum(['MULTILINGUAL_BASE', 'MULTILINGUAL_SMALL']), locale: locale.optional() }),
  z.strictObject({ mode: z.literal('CLOUD'), providerId: z.enum(['AZURE_FAST_TRANSCRIPTION', 'OPENAI_TRANSCRIPTION']), consent: sttConsentSchema, locale: locale.optional() }),
]);
export type VoiceSttConfig = z.infer<typeof voiceSttConfigSchema>;

export const voiceTtsConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('DISABLED') }),
  z.strictObject({ mode: z.literal('LOCAL'), voice: voiceRefSchema.extend({ providerId: z.literal('WINDOWS_SYSTEM_SPEECH') }) }),
  z.strictObject({ mode: z.literal('CLOUD'), voice: voiceRefSchema.extend({ providerId: z.literal('AZURE_NEURAL_TTS') }), consent: ttsConsentSchema }),
]);
export type VoiceTtsConfig = z.infer<typeof voiceTtsConfigSchema>;
export const voiceSessionConfigSchema = z.strictObject({
  stt: voiceSttConfigSchema,
  tts: voiceTtsConfigSchema,
  muted: z.boolean(),
  volume: z.number().min(0).max(1),
  maxRecordingMs: z.number().int().min(100).max(MAX_VOICE_RECORDING_MS),
});
export type VoiceSessionConfig = z.infer<typeof voiceSessionConfigSchema>;

/** No fabricated installed Windows voice: local STT is the default and TTS
 * remains disabled until the user selects an actually enumerated voice. */
export const DEFAULT_LOCAL_VOICE_CONFIG: Readonly<VoiceSessionConfig> = Object.freeze({
  stt: Object.freeze({ mode: 'LOCAL', providerId: 'WHISPER_CPP', modelId: 'MULTILINGUAL_BASE' }),
  tts: Object.freeze({ mode: 'DISABLED' }),
  muted: false, volume: 1, maxRecordingMs: MAX_VOICE_RECORDING_MS,
});

export const voiceProviderStatusSchema = z.strictObject({
  providerId: voiceProviderIdSchema,
  requiresNetwork: z.boolean(),
  health: z.enum(['READY', 'UNCONFIGURED', 'UNAVAILABLE']),
  capabilities: z.array(z.enum(['STT', 'TTS', 'VISEME'])).min(1).max(3),
}).superRefine((status, ctx) => {
  const local = status.providerId === 'WHISPER_CPP' || status.providerId === 'WINDOWS_SYSTEM_SPEECH';
  const stt = status.providerId === 'WHISPER_CPP' || status.providerId === 'AZURE_FAST_TRANSCRIPTION' || status.providerId === 'OPENAI_TRANSCRIPTION';
  const capabilities = new Set(status.capabilities);
  if (status.requiresNetwork === local || capabilities.size !== status.capabilities.length
    || (stt && (capabilities.size !== 1 || !capabilities.has('STT')))
    || (!stt && (!capabilities.has('TTS') || capabilities.has('STT')))
    || (status.providerId === 'WINDOWS_SYSTEM_SPEECH' && capabilities.has('VISEME'))) {
    ctx.addIssue({ code: 'custom', message: 'Provider capability or locality is inconsistent' });
  }
});
export type VoiceProviderStatus = z.infer<typeof voiceProviderStatusSchema>;

export interface VoiceAudio {
  readonly bytes: Uint8Array;
  readonly codec: 'wav' | 'pcm_s16le';
  readonly sampleRate: number;
  readonly channels: number;
}
export interface VoiceAudioInfo {
  readonly frames: number;
  readonly durationMs: number;
  readonly pcmOffset: number;
  readonly pcmBytes: number;
  readonly sampleRate: number;
  readonly channels: number;
}

function invalidAudio(): never { throw new RangeError('Invalid or unsupported bounded PCM audio'); }
function tag(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every((character, i) => bytes[offset + i] === character.charCodeAt(0));
}

/** Strict RIFF little-endian PCM16 or raw signed LE PCM16 structural probe.
 * Metadata, lengths, chunk bounds and frame counts must agree before decode.
 * Unknown bounded RIFF metadata chunks are skipped as data; no decompression.
 * Returns indices into exactly the supplied bytes, not a file or URL. */
export function inspectVoiceAudio(audio: VoiceAudio): VoiceAudioInfo {
  const { bytes, sampleRate, channels, codec } = audio;
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_VOICE_AUDIO_BYTES
    || !Number.isSafeInteger(sampleRate) || sampleRate < minSampleRate || sampleRate > maxSampleRate
    || (channels !== 1 && channels !== 2) || (codec !== 'wav' && codec !== 'pcm_s16le')) return invalidAudio();
  const alignment = channels * 2;
  let pcmOffset = 0, pcmBytes = bytes.byteLength;
  if (codec === 'wav') {
    if (bytes.byteLength < 44 || !tag(bytes, 0, 'RIFF') || !tag(bytes, 8, 'WAVE')) return invalidAudio();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== bytes.byteLength - 8) return invalidAudio();
    let offset = 12, chunks = 0, foundFmt = false, foundData = false;
    while (offset < bytes.byteLength) {
      if (++chunks > 64 || offset > bytes.byteLength - 8) return invalidAudio();
      const size = view.getUint32(offset + 4, true);
      const payload = offset + 8;
      const next = payload + size + (size & 1);
      if (next > bytes.byteLength) return invalidAudio();
      if (tag(bytes, offset, 'fmt ')) {
        if (foundFmt || foundData || (size !== 16 && size !== 18)
          || (size === 18 && view.getUint16(payload + 16, true) !== 0)
          || view.getUint16(payload, true) !== 1 || view.getUint16(payload + 2, true) !== channels
          || view.getUint32(payload + 4, true) !== sampleRate || view.getUint32(payload + 8, true) !== sampleRate * alignment
          || view.getUint16(payload + 12, true) !== alignment || view.getUint16(payload + 14, true) !== 16) return invalidAudio();
        foundFmt = true;
      } else if (tag(bytes, offset, 'data')) {
        if (!foundFmt || foundData || size === 0) return invalidAudio();
        foundData = true; pcmOffset = payload; pcmBytes = size;
      }
      offset = next;
    }
    if (!foundFmt || !foundData || offset !== bytes.byteLength) return invalidAudio();
  }
  if (pcmBytes <= 0 || pcmBytes % alignment !== 0) return invalidAudio();
  const frames = pcmBytes / alignment;
  const durationMs = frames * 1000 / sampleRate;
  if (durationMs <= 0 || durationMs > MAX_VOICE_AUDIO_MS) return invalidAudio();
  return { frames, durationMs, pcmOffset, pcmBytes, sampleRate, channels };
}

export const voiceAudioSchema = z.strictObject({
  bytes: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= MAX_VOICE_AUDIO_BYTES, 'Audio size exceeds limits'),
  codec: z.enum(['wav', 'pcm_s16le']), sampleRate: z.number().int().min(minSampleRate).max(maxSampleRate), channels: z.number().int().min(1).max(2),
}).superRefine((audio, ctx) => {
  try { inspectVoiceAudio(audio); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid PCM16 audio container or metadata' }); }
});
export const voiceRecordingAudioSchema = voiceAudioSchema.refine(audio => {
  try { return audio.codec === 'wav' && audio.channels === 1 && audio.sampleRate === 16_000
    && inspectVoiceAudio(audio).durationMs <= MAX_VOICE_RECORDING_MS; } catch { return false; }
}, 'Recording must be bounded 16 kHz mono PCM16 WAV');

export const voiceVisemeSchema = z.strictObject({ offsetMs: audioTime, id: providerVoiceId.max(64) });
export type VoiceViseme = z.infer<typeof voiceVisemeSchema>;
const visemes = z.array(voiceVisemeSchema).max(4096);
const voiceText = z.string().max(MAX_VOICE_TEXT_LENGTH);

/** Public coordinator requests do not choose the next generation. START's
 * chat requestId is reserved by the caller solely for this voice turn. */
export const voiceRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('START_PTT'), petId: identity, conversationId: identity, turnId: identity, requestId: identity, config: voiceSessionConfigSchema }),
  z.strictObject({ type: z.literal('STOP_PTT'), job: voiceJobSchema }),
  z.strictObject({ type: z.literal('CANCEL'), job: voiceJobSchema, reason: voiceCancelReasonSchema }),
  z.strictObject({ type: z.literal('SELECT_PET'), petId: identity.nullable() }),
  z.strictObject({ type: z.literal('SET_MUTED'), petId: identity, muted: z.boolean() }),
  z.strictObject({ type: z.literal('RESET') }),
]);
export type VoiceRequest = z.infer<typeof voiceRequestSchema>;

export const voiceEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('CAPTURE_STARTED'), job: voiceJobSchema }),
  z.strictObject({ type: z.literal('RECORDING_LIMIT_REACHED'), job: voiceJobSchema }),
  z.strictObject({ type: z.literal('RECORDING_DONE'), job: voiceJobSchema, audio: voiceRecordingAudioSchema }),
  z.strictObject({ type: z.literal('STT_DONE'), job: voiceJobSchema, text: voiceText }),
  z.strictObject({ type: z.literal('CHAT_DONE'), job: voiceJobSchema, requestId: identity, text: voiceText }),
  z.strictObject({ type: z.literal('TTS_DONE'), job: voiceJobSchema, audio: voiceAudioSchema, visemes: visemes.optional() }),
  z.strictObject({ type: z.literal('PLAYBACK_STARTED'), job: voiceJobSchema, durationMs: audioTime.positive() }),
  z.strictObject({ type: z.literal('PLAYBACK_SAMPLE'), job: voiceJobSchema, atMs: audioTime, mouthOpen: normalizedOpen, speaking: z.boolean(), viseme: providerVoiceId.max(64).optional() }),
  z.strictObject({ type: z.literal('PLAYBACK_ENDED'), job: voiceJobSchema }),
  z.strictObject({ type: z.literal('FAILED'), job: voiceJobSchema, phase: activeVoicePhaseSchema, code: voiceErrorCodeSchema }),
]).superRefine((event, ctx) => {
  if (event.type === 'CHAT_DONE' && event.requestId !== event.job.requestId) {
    ctx.addIssue({ code: 'custom', message: 'Voice chat result belongs to a different request' });
  }
  if (event.type === 'PLAYBACK_SAMPLE' && !event.speaking && (event.mouthOpen !== 0 || event.viseme !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Non-speaking sample must close the mouth' });
  }
  if (event.type === 'TTS_DONE' && event.visemes) {
    let duration = -1;
    try { duration = inspectVoiceAudio(event.audio).durationMs; } catch { /* audio schema already reports invalid PCM */ }
    let last = -1;
    for (const sample of event.visemes) {
      if (sample.offsetMs <= last || sample.offsetMs > duration) {
        ctx.addIssue({ code: 'custom', path: ['visemes'], message: 'Visemes must be ordered and within actual audio duration' });
        break;
      }
      last = sample.offsetMs;
    }
  }
});
export type VoiceEvent = z.infer<typeof voiceEventSchema>;

/** Narrow visual-only projection for the pet renderer. No audio, chat text
 * or provider configuration crosses this interface. */
export const voiceMouthSampleSchema = z.strictObject({
  petId: identity, turnId: identity, generation: safeNonnegative, atMs: audioTime, mouthOpen: normalizedOpen,
  speaking: z.boolean(), viseme: providerVoiceId.max(64).optional(),
}).refine(sample => sample.speaking || (sample.mouthOpen === 0 && sample.viseme === undefined), 'Non-speaking mouth sample must be closed');
export type VoiceMouthSample = z.infer<typeof voiceMouthSampleSchema>;

// Signal is supplied by the owning runtime (e.g. AbortSignal in a trusted
// provider) without forcing DOM or Node libraries into shared contracts.
export interface VoiceSttProvider<Signal> {
  readonly status: VoiceProviderStatus;
  transcribe(audio: VoiceAudio, options: { locale?: string; signal: Signal }): Promise<{ text: string }>;
}
export interface VoiceTtsProvider<Signal> {
  readonly status: VoiceProviderStatus;
  listVoices(): Promise<VoiceRef[]>;
  synthesize(text: string, options: { voice: VoiceRef; signal: Signal }): Promise<{ audio: VoiceAudio; visemes?: VoiceViseme[] }>;
}
