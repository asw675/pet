import { DEFAULT_LOCAL_VOICE_CONFIG, voiceJobSchema, voiceRefSchema, voiceSessionConfigSchema } from '@pet-desktop/contracts/voice';
import type { VoiceRef, VoiceSessionConfig } from '@pet-desktop/contracts/voice';
import type { SqliteConnection } from './ports.js';
import { AiStateStorage } from '#ai-state-storage';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_CONFIG_LENGTH = 4096;
const LOCAL_VOICE_ID = /^sapi-[0-9a-f]{64}$/u;
const MAX_ENUMERATED_VOICES = 256;

/** Additive migration, numbered and executed by the owning repository after
 * AI tables. No audio, transcript, vault credential or secondary writer. */
export const VOICE_PROFILE_MIGRATION_SQL = `
CREATE TABLE voice_profiles (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  config_json TEXT NOT NULL CHECK (length(config_json) BETWEEN 1 AND ${MAX_CONFIG_LENGTH}
    AND json_valid(config_json) AND json_type(config_json)='object'),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND ${MAX_SAFE}),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND ${MAX_SAFE})
) STRICT;
CREATE TRIGGER voice_profile_revision_insert BEFORE INSERT ON voice_profiles
WHEN NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'Voice profile must start at revision one'); END;
CREATE TRIGGER voice_profile_revision_update BEFORE UPDATE ON voice_profiles
WHEN OLD.pet_id IS NOT NEW.pet_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'Voice profile identity/revision must be monotonic'); END;
-- Reset stores default config at a new revision instead of deleting the row:
-- an old expectedRevision=0 request must never become valid again.
CREATE TRIGGER voice_profile_no_delete BEFORE DELETE ON voice_profiles
BEGIN SELECT RAISE(ABORT,'Reset voice profile with monotonic revision'); END;
`;

export interface VoiceProfileRecord {
  readonly petId: string;
  /** 0 only when an owned pet has never stored non-default settings. */
  readonly revision: number;
  readonly updatedAt: number | null;
  readonly config: VoiceSessionConfig;
}
export interface VoiceProfileScope { readonly petId: string; readonly conversationId: string }
export interface VoiceProfileAuthorityConfig { readonly configRevision: number; readonly config: VoiceSessionConfig }
export interface VoiceCompletedAssistantText extends VoiceProfileScope { readonly requestId: string; readonly text: string }

/** Trusted enrichment, NOT renderer payload. The invoking utility must
 * obtain real enumerated voice refs from its installed-voice provider and
 * scoped consent evidence from an explicit consent action. Merely passing a
 * consent ID or an invented voice ID in `config` cannot authorize a change. */
export interface VoiceProfileSaveAuthorization {
  readonly installedVoices?: readonly VoiceRef[];
  readonly sttCloudConsent?: { readonly scope: 'STT_AUDIO'; readonly petId: string;
    readonly providerId: 'AZURE_FAST_TRANSCRIPTION' | 'OPENAI_TRANSCRIPTION'; readonly authorizationId: string };
  readonly ttsCloudConsent?: { readonly scope: 'TTS_TEXT'; readonly petId: string;
    readonly providerId: 'AZURE_NEURAL_TTS'; readonly authorizationId: string };
}
export type VoiceProfileErrorCode = 'INACTIVE' | 'INVALID_PROFILE' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'VOICE_NOT_ENUMERATED' | 'CONSENT_REQUIRED';
export class VoiceProfileStorageError extends Error {
  readonly code: VoiceProfileErrorCode;
  constructor(code: VoiceProfileErrorCode) { super(`Voice profile ${code.toLowerCase().replace(/_/gu, ' ')}`); this.code=code; }
}
function fail(code: VoiceProfileErrorCode): never { throw new VoiceProfileStorageError(code); }
function id(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(raw)) fail('INVALID_PROFILE');
  return raw;
}
function uint(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail('INVALID_PROFILE');
  return raw;
}
function sqlInt(raw: unknown): number { return uint(typeof raw === 'bigint' ? Number(raw) : raw); }
function parseConfig(raw: unknown): VoiceSessionConfig {
  const parsed = voiceSessionConfigSchema.safeParse(raw);
  if (!parsed.success) fail('INVALID_PROFILE');
  const config = parsed.data;
  if (config.tts.mode === 'LOCAL' && !LOCAL_VOICE_ID.test(config.tts.voice.voiceId)) fail('INVALID_PROFILE');
  // Separate privacy scopes must not accidentally reference a single opaque
  // authorization as permission to transmit both microphone audio and text.
  if (config.stt.mode === 'CLOUD' && config.tts.mode === 'CLOUD'
    && config.stt.consent.authorizationId === config.tts.consent.authorizationId) fail('CONSENT_REQUIRED');
  return config;
}
function sameVoice(a: VoiceRef, b: VoiceRef): boolean {
  return a.providerId === b.providerId && a.voiceId === b.voiceId && a.locale === b.locale;
}
function confirmedVoice(voice: VoiceRef, installed: readonly VoiceRef[] | undefined): boolean {
  if (!Array.isArray(installed) || installed.length > MAX_ENUMERATED_VOICES) return false;
  // Provider list is still validated at this boundary. The optional rate is
  // an independent user setting, not part of the installed voice identity.
  const parsed = installed.map(item => voiceRefSchema.safeParse(item));
  if (parsed.some(item => !item.success || item.data.providerId !== 'WINDOWS_SYSTEM_SPEECH' || !LOCAL_VOICE_ID.test(item.data.voiceId))) return false;
  return parsed.some(item => item.success && sameVoice(item.data, voice));
}
function consentMatches(evidence: VoiceProfileSaveAuthorization['sttCloudConsent'] | VoiceProfileSaveAuthorization['ttsCloudConsent'], petId: string,
  providerId: string, scope: 'STT_AUDIO' | 'TTS_TEXT', authorizationId: string): boolean {
  return evidence !== undefined && evidence !== null && evidence.petId === petId && evidence.providerId === providerId
    && evidence.scope === scope && evidence.authorizationId === authorizationId;
}
function authorizeChange(petId: string, before: VoiceSessionConfig, after: VoiceSessionConfig, authorization: VoiceProfileSaveAuthorization): void {
  if (after.tts.mode === 'LOCAL' && (before.tts.mode !== 'LOCAL' || !sameVoice(before.tts.voice, after.tts.voice))
    && !confirmedVoice(after.tts.voice, authorization.installedVoices)) fail('VOICE_NOT_ENUMERATED');
  if (after.stt.mode === 'CLOUD' && (before.stt.mode !== 'CLOUD' || before.stt.providerId !== after.stt.providerId
    || before.stt.consent.authorizationId !== after.stt.consent.authorizationId)
    && !consentMatches(authorization.sttCloudConsent, petId, after.stt.providerId, 'STT_AUDIO', after.stt.consent.authorizationId)) fail('CONSENT_REQUIRED');
  if (after.tts.mode === 'CLOUD' && (before.tts.mode !== 'CLOUD' || before.tts.voice.providerId !== after.tts.voice.providerId
    || before.tts.consent.authorizationId !== after.tts.consent.authorizationId)
    && !consentMatches(authorization.ttsCloudConsent, petId, after.tts.voice.providerId, 'TTS_TEXT', after.tts.consent.authorizationId)) fail('CONSENT_REQUIRED');
}

/** Synchronous repository-scoped persistence. All calls use the existing
 * transaction/connection; no await, OS enumeration, cloud request, file
 * access or independent DB lifetime. A failed mutation aborts the owning
 * transaction. Runtime provider availability is separately projected. */
export class VoiceProfileStorage {
  private readonly ai: AiStateStorage;
  private readonly connection: SqliteConnection;
  private readonly inScope: () => boolean;
  constructor(connection: SqliteConnection, inScope: () => boolean) {
    this.connection=connection; this.inScope=inScope;
    this.ai = new AiStateStorage(connection, inScope);
  }
  private get db(): SqliteConnection { if (!this.inScope()) fail('INACTIVE'); return this.connection; }
  private ownsPet(petId: string): boolean { return this.db.prepare('SELECT 1 FROM pets WHERE pet_id=?').get(petId) != null; }

  get(rawPetId: string): VoiceProfileRecord | null {
    const petId = id(rawPetId), db = this.db;
    if (!this.ownsPet(petId)) return null;
    const raw = db.prepare('SELECT config_json,revision,updated_at FROM voice_profiles WHERE pet_id=?').get(petId);
    if (raw == null) return { petId, revision: 0, updatedAt: null, config: parseConfig(DEFAULT_LOCAL_VOICE_CONFIG) };
    if (typeof raw !== 'object' || !('config_json' in raw) || typeof raw.config_json !== 'string' || raw.config_json.length > MAX_CONFIG_LENGTH
      || !('revision' in raw) || !('updated_at' in raw)) fail('INVALID_PROFILE');
    const revision = sqlInt(raw.revision);
    if (revision === 0) fail('INVALID_PROFILE');
    let json: unknown;
    try { json = JSON.parse(raw.config_json); } catch { return fail('INVALID_PROFILE'); }
    return { petId, revision, updatedAt: sqlInt(raw.updated_at), config: parseConfig(json) };
  }

  save(rawPetId: string, rawConfig: VoiceSessionConfig, expectedRevision: number, at: number,
    authorization: VoiceProfileSaveAuthorization = {}): VoiceProfileRecord {
    const petId = id(rawPetId), db = this.db, config = parseConfig(rawConfig), expected = uint(expectedRevision), now = uint(at);
    const current = this.get(petId);
    if (!current) fail('NOT_FOUND');
    if (current.revision !== expected || (current.updatedAt !== null && now < current.updatedAt)) fail('REVISION_CONFLICT');
    if (authorization === null || typeof authorization !== 'object' || Array.isArray(authorization)) fail('INVALID_PROFILE');
    authorizeChange(petId, current.config, config, authorization);
    const encoded = JSON.stringify(config);
    if (encoded.length > MAX_CONFIG_LENGTH) fail('INVALID_PROFILE');
    if (JSON.stringify(current.config) === encoded) return current;
    if (current.revision >= MAX_SAFE) fail('REVISION_CONFLICT');
    const revision = current.revision + 1;
    const changed = current.revision === 0
      ? db.prepare('INSERT INTO voice_profiles(pet_id,config_json,revision,updated_at) VALUES(?,?,?,?)').run(petId, encoded, revision, now).changes
      : db.prepare('UPDATE voice_profiles SET config_json=?,revision=?,updated_at=? WHERE pet_id=? AND revision=?').run(encoded, revision, now, petId, expected).changes;
    if (sqlInt(changed) !== 1) fail('REVISION_CONFLICT');
    return { petId, revision, updatedAt: now, config };
  }

  reset(petId: string, expectedRevision: number, at: number): VoiceProfileRecord {
    return this.save(petId, parseConfig(DEFAULT_LOCAL_VOICE_CONFIG), expectedRevision, at);
  }

  /** Authority port for VoiceService. Caller wraps each call in its own
   * short repository transaction; no provider promise can hold that scope. */
  readConfig(scope: VoiceProfileScope): VoiceProfileAuthorityConfig | null {
    this.db;
    const petId = id(scope.petId), conversationId = id(scope.conversationId);
    if (!this.ai.getConversation(petId, conversationId)) return null;
    const profile = this.get(petId);
    return profile === null ? null : { configRevision: profile.revision, config: profile.config };
  }

  /** No arbitrary supplied text, conversation history scan, provisional
   * stream, redacted message or proactive reply. Only exact durable USER
   * assistant completion is eligible for synthesis. */
  completedAssistantText(rawJob: unknown): VoiceCompletedAssistantText | null {
    this.db;
    const job = voiceJobSchema.safeParse(rawJob);
    if (!job.success || job.data.requestId === undefined) return null;
    const { petId, conversationId, requestId } = job.data;
    const turn = this.ai.getTurn(requestId);
    if (!turn || turn.petId !== petId || turn.conversationId !== conversationId || turn.trigger !== 'USER' || turn.status !== 'COMPLETED') return null;
    const assistant = this.ai.getMessage(petId, conversationId, turn.assistantMessageId);
    if (!assistant || assistant.petId !== petId || assistant.conversationId !== conversationId || assistant.requestId !== requestId
      || assistant.messageId !== turn.assistantMessageId || assistant.role !== 'ASSISTANT' || assistant.status !== 'COMPLETED' || assistant.text.trim().length === 0) return null;
    return { petId, conversationId, requestId, text: assistant.text };
  }
}
