import { z } from 'zod';
import { MAX_VOICE_AUDIO_MS, MAX_VOICE_TEXT_LENGTH, voiceAudioSchema, voiceCancelReasonSchema, voiceErrorCodeSchema,
  voiceEventSchema, voiceJobSchema, voiceMouthSampleSchema, voiceProviderStatusSchema, voiceRecordingAudioSchema,
  voiceSessionConfigSchema, voiceVisemeSchema } from '../../../../packages/contracts/src/voice.js';
import { aiCancelReasonSchema, aiErrorSchema, aiLimits, chatStreamEventSchema } from '@pet-desktop/contracts/ai';
import type { AiCancelReason, ChatStreamEvent } from '@pet-desktop/contracts/ai';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const voiceScopeSchema = z.strictObject({ petId: id, conversationId: id });
export type VoiceScope = z.infer<typeof voiceScopeSchema>;
/** This feature always reserves a separate globally unique chat request ID. */
export const voiceOwnedJobSchema = voiceJobSchema.extend({ requestId: id });
export type VoiceOwnedJob = z.infer<typeof voiceOwnedJobSchema>;

export const voiceTranscriptSchema = z.string().min(1).max(Math.min(MAX_VOICE_TEXT_LENGTH, aiLimits.userText)).refine(value => value.trim().length > 0);
export const voiceAuthorityConfigSchema = z.strictObject({ configRevision: integer, config: voiceSessionConfigSchema });
export type VoiceAuthorityConfig = z.infer<typeof voiceAuthorityConfigSchema>;
export const voiceStatusProjectionSchema = voiceAuthorityConfigSchema.extend({
  scope: voiceScopeSchema,
  /** Monotonic floor for a newly mounted control-center coordinator. */
  latestGeneration: integer,
  stt: voiceProviderStatusSchema,
  tts: voiceProviderStatusSchema.nullable(),
  canBegin: z.boolean(),
  busy: z.boolean(),
}).superRefine((projection, context) => {
  const ttsProvider = projection.config.tts.mode === 'DISABLED' ? null : projection.config.tts.voice.providerId;
  if (projection.stt.providerId !== projection.config.stt.providerId || (projection.tts?.providerId ?? null) !== ttsProvider
    || (projection.canBegin && (projection.config.stt.mode !== 'LOCAL' || projection.stt.health !== 'READY'))) {
    context.addIssue({ code: 'custom', message: 'Voice status disagrees with authoritative configuration' });
  }
});
export type VoiceStatusProjection = z.infer<typeof voiceStatusProjectionSchema>;

/** Provider requests have no locale/model path/voice/text/provider/key
 * overrides. The service re-reads authoritative settings and chat reply. */
export const voiceServiceRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), scope: voiceScopeSchema, probe: z.boolean() }),
  z.strictObject({ kind: z.literal('begin'), job: voiceOwnedJobSchema, expectedConfigRevision: integer }),
  z.strictObject({ kind: z.literal('transcribe'), job: voiceOwnedJobSchema, audio: voiceRecordingAudioSchema }),
  z.strictObject({ kind: z.literal('synthesize'), job: voiceOwnedJobSchema }),
  z.strictObject({ kind: z.literal('finish'), job: voiceOwnedJobSchema }),
  z.strictObject({ kind: z.literal('cancel'), job: voiceOwnedJobSchema, reason: voiceCancelReasonSchema }),
]);
export type VoiceServiceRequest = z.infer<typeof voiceServiceRequestSchema>;

export const voiceServiceResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), kind: z.literal('status'), status: voiceStatusProjectionSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('begun'), job: voiceOwnedJobSchema, configRevision: integer }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('transcribed'), job: voiceOwnedJobSchema, text: voiceTranscriptSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('synthesized'), job: voiceOwnedJobSchema, audio: voiceAudioSchema, visemes: z.array(voiceVisemeSchema).max(4096).optional() }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('closed'), job: voiceOwnedJobSchema, changed: z.boolean() }),
  z.strictObject({ ok: z.literal(false), kind: z.literal('error'), code: voiceErrorCodeSchema, job: voiceOwnedJobSchema.optional() }),
]).superRefine((result, context) => {
  if (result.kind === 'synthesized' && !voiceEventSchema.safeParse({ type: 'TTS_DONE', job: result.job, audio: result.audio,
    ...(result.visemes === undefined ? {} : { visemes: result.visemes }) }).success) {
    context.addIssue({ code: 'custom', message: 'Voice audio/visemes are not a valid completed synthesis' });
  }
});
export type VoiceServiceResult = z.infer<typeof voiceServiceResultSchema>;

export function sameVoiceScope(a: VoiceScope, b: VoiceScope): boolean { return a.petId === b.petId && a.conversationId === b.conversationId; }
export function sameVoiceJob(a: VoiceOwnedJob, b: VoiceOwnedJob): boolean {
  return sameVoiceScope(a, b) && a.generation === b.generation && a.turnId === b.turnId && a.requestId === b.requestId;
}
export function voiceResultMatchesRequest(request: VoiceServiceRequest, result: VoiceServiceResult): boolean {
  if (result.kind === 'error') return request.kind === 'status' ? result.job === undefined
    : result.job !== undefined && sameVoiceJob(request.job, result.job);
  if (request.kind === 'status') return result.kind === 'status' && sameVoiceScope(request.scope, result.status.scope);
  const expected = request.kind === 'begin' ? 'begun' : request.kind === 'transcribe' ? 'transcribed'
    : request.kind === 'synthesize' ? 'synthesized' : 'closed';
  return result.kind === expected && 'job' in result && sameVoiceJob(request.job, result.job)
    && (request.kind !== 'begin' || (result.kind === 'begun' && result.configRevision === request.expectedConfigRevision));
}

export const voiceMicGrantSchema = z.strictObject({ grantId: id, job: voiceOwnedJobSchema });
export type VoiceMicGrant = z.infer<typeof voiceMicGrantSchema>;

/** Chat keeps ownership of the accepted input/reply and durable history;
 * voice only submits the final recognized text as an ordinary USER turn. */
export const voiceChatIdentitySchema = z.strictObject({ petId: id, conversationId: id, requestId: id });
export type VoiceChatIdentity = z.infer<typeof voiceChatIdentitySchema>;
export const voiceChatStartSchema = voiceChatIdentitySchema.extend({ trigger: z.literal('USER'), userText: voiceTranscriptSchema });
export type VoiceChatStart = z.infer<typeof voiceChatStartSchema>;
export const voiceChatStartResultSchema = z.union([
  voiceChatIdentitySchema.extend({ accepted: z.literal(true) }),
  z.strictObject({ accepted: z.literal(false), reason: z.enum(['INVALID_REQUEST', 'DUPLICATE', 'PET_BUSY', 'GLOBAL_BUSY', 'AUTHORITY_REJECTED', 'CLOSED']), error: aiErrorSchema }),
]);
export type VoiceChatStartResult = z.infer<typeof voiceChatStartResultSchema>;
export const voiceChatCancelSchema = z.strictObject({ identity: voiceChatIdentitySchema, reason: aiCancelReasonSchema });
export const voiceChatPushSchema = chatStreamEventSchema;

/** Optional downstream visual-only port. No audio buffers or transcript
 * enter a pet renderer; the Main integration will enforce window identity. */
export const voiceMouthNotificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('begin'), job: voiceOwnedJobSchema, durationMs: z.number().positive().max(MAX_VOICE_AUDIO_MS) }),
  z.strictObject({ kind: z.literal('sample'), job: voiceOwnedJobSchema, sample: voiceMouthSampleSchema }),
  z.strictObject({ kind: z.literal('clear'), job: voiceOwnedJobSchema }),
]).refine(event => event.kind !== 'sample' || (event.sample.petId === event.job.petId && event.sample.turnId === event.job.turnId
  && event.sample.generation === event.job.generation), 'Mouth sample must match its job');
export type VoiceMouthNotification = z.infer<typeof voiceMouthNotificationSchema>;

/** Composition boundary, deliberately not yet attached to the existing
 * Electron protocol/preload. Host wiring must authenticate the control
 * center and correlate every invocation/push before exposing this port. */
export interface VoiceSessionBridgePort {
  voiceRequest(request: VoiceServiceRequest): Promise<VoiceServiceResult>;
  requestMic(job: VoiceOwnedJob): Promise<VoiceMicGrant | null>;
  revokeMic(grant: VoiceMicGrant): Promise<void> | void;
  startChat(intent: VoiceChatStart): Promise<VoiceChatStartResult>;
  cancelChat(identity: VoiceChatIdentity, reason: AiCancelReason): Promise<boolean>;
  subscribeChat(listener: (event: ChatStreamEvent) => void): () => void;
  publishMouth?(event: VoiceMouthNotification): Promise<void> | void;
  subscribeSuspend?(listener: () => void): () => void;
}
