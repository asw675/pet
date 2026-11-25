import { z } from 'zod';
import { DEFAULT_LOCAL_VOICE_CONFIG, voiceRefSchema, voiceSessionConfigSchema } from '@pet-desktop/contracts/voice';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const settingsConfig = voiceSessionConfigSchema.refine(config => config.tts.mode !== 'LOCAL' || /^sapi-[0-9a-f]{64}$/u.test(config.tts.voice.voiceId));
export const voiceSettingsProfileSchema = z.strictObject({ petId: id, revision, updatedAt: revision.nullable(), config: settingsConfig })
  .refine(profile => (profile.revision === 0) === (profile.updatedAt === null), 'Default profile revision must have no timestamp');
export type VoiceSettingsProfile = z.infer<typeof voiceSettingsProfileSchema>;

/** A voice choice must come from an actual bounded local SAPI enumeration;
 * user-selected rate belongs to profile config and not the installed ref. */
export const installedVoiceOptionSchema = z.strictObject({
  ref: voiceRefSchema.omit({ rate: true }).extend({ providerId: z.literal('WINDOWS_SYSTEM_SPEECH'), voiceId: z.string().regex(/^sapi-[0-9a-f]{64}$/u) }),
  displayName: z.string().min(1).max(240).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)),
});
export const installedVoiceOptionsSchema = z.array(installedVoiceOptionSchema).max(128).refine(list => new Set(list.map(item => item.ref.voiceId)).size === list.length);
export type InstalledVoiceOption = z.infer<typeof installedVoiceOptionSchema>;

export const voiceSettingsRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('get'), petId: id }),
  z.strictObject({ kind: z.literal('listVoices'), petId: id }),
  z.strictObject({ kind: z.literal('save'), petId: id, expectedRevision: revision, config: settingsConfig }),
  z.strictObject({ kind: z.literal('reset'), petId: id, expectedRevision: revision }),
]);
export type VoiceSettingsRequest = z.infer<typeof voiceSettingsRequestSchema>;
export const voiceSettingsErrorCodeSchema = z.enum(['INVALID_REQUEST', 'NOT_FOUND', 'REVISION_CONFLICT', 'VOICE_NOT_ENUMERATED', 'CONSENT_REQUIRED', 'UNSUPPORTED', 'UNAVAILABLE', 'BUSY', 'TIMEOUT']);
export type VoiceSettingsErrorCode = z.infer<typeof voiceSettingsErrorCodeSchema>;
export const voiceSettingsResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), kind: z.literal('profile'), profile: voiceSettingsProfileSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('voices'), petId: id, voices: installedVoiceOptionsSchema, health: z.enum(['READY', 'UNCONFIGURED', 'UNAVAILABLE']) }),
  z.strictObject({ ok: z.literal(false), kind: z.literal('error'), code: voiceSettingsErrorCodeSchema, petId: id.optional() }),
]).refine(result => result.kind !== 'voices' || ((result.voices.length > 0) === (result.health === 'READY')), 'Unavailable or unconfigured provider must not expose invented voices');
export type VoiceSettingsResult = z.infer<typeof voiceSettingsResultSchema>;

export function voiceSettingsResultMatchesRequest(request: VoiceSettingsRequest, result: VoiceSettingsResult): boolean {
  if (result.kind === 'error') return result.petId === request.petId;
  if (request.kind === 'listVoices') return result.kind === 'voices' && request.petId === result.petId;
  if (result.kind !== 'profile' || result.profile.petId !== request.petId) return false;
  if (request.kind === 'get') return true;
  const revisionMatches = result.profile.revision === request.expectedRevision || (request.expectedRevision < Number.MAX_SAFE_INTEGER && result.profile.revision === request.expectedRevision + 1);
  return revisionMatches && JSON.stringify(result.profile.config) === JSON.stringify(request.kind === 'reset' ? DEFAULT_LOCAL_VOICE_CONFIG : request.config);
}
