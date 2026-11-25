import {
  actionProposalSchema, aiCancelReasonSchema, aiErrorCodeSchema, aiErrorSchema, aiLimits, aiUsageSchema,
  chatEmotionSchema, chatMessageSchema, chatReplySchema, conversationSchema, memoryRecordSchema,
  pendingMemoryCandidateSchema, providerConfigSchema, turnRequestSchema,
} from '@pet-desktop/contracts/ai';
import type {
  ActionProposal, AiCancelReason, AiError, AiErrorCode, AiUsage, AuthorizedMemoryContext, ChatMessage, ChatReply,
  Conversation, MemoryRecord, PendingMemoryCandidate, ProviderConfig, TurnRequest,
} from '@pet-desktop/contracts/ai';
import {
  confirmMemoryCandidate, memoryPolicyLimits, retrieveAuthorizedMemories, screenMemoryText,
} from '@pet-desktop/app-service/memory-policy';
import type { ConfirmMemoryResult, TrustedMemoryConfirmation } from '@pet-desktop/app-service/memory-policy';
import type { SqliteConnection, SqlValue } from './ports.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const sqlId = (field: string) => `length(${field}) BETWEEN 1 AND 128 AND ${field} GLOB '[A-Za-z0-9]*' AND ${field} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const unsigned = (field: string) => `${field} BETWEEN 0 AND ${MAX_SAFE}`;
const positive = (field: string) => `${field} BETWEEN 1 AND ${MAX_SAFE}`;
const json = (field: string) => `json_valid(${field}) AND json_type(${field})='object'`;

/** Additive, numbered by the integrating repository. No game-table changes,
 * real credential storage, secondary connection or transaction ownership. */
export const AI_STATE_MIGRATION_SQL = `
CREATE TABLE ai_provider_configs (
  provider_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('provider_id')}),
  config_json TEXT NOT NULL CHECK (${json('config_json')} AND json_extract(config_json,'$.providerId')=provider_id),
  revision INTEGER NOT NULL CHECK (${positive('revision')}),
  updated_at INTEGER NOT NULL CHECK (${unsigned('updated_at')})
) STRICT;
CREATE TABLE ai_pet_provider_assignments (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  provider_id TEXT NOT NULL REFERENCES ai_provider_configs(provider_id),
  provider_revision INTEGER NOT NULL CHECK (${positive('provider_revision')}),
  consent_ref TEXT CHECK (${sqlId('consent_ref')} AND consent_ref LIKE 'consent:%'),
  assigned_at INTEGER NOT NULL CHECK (${unsigned('assigned_at')})
) STRICT;
CREATE TRIGGER ai_assignment_validate_insert BEFORE INSERT ON ai_pet_provider_assignments
WHEN NOT EXISTS (SELECT 1 FROM ai_provider_configs p WHERE p.provider_id=NEW.provider_id
  AND p.revision=NEW.provider_revision AND p.updated_at<=NEW.assigned_at
  AND (json_extract(p.config_json,'$.privacyBoundary')<>'CLOUD' OR NEW.consent_ref IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'provider assignment requires current consent and configuration'); END;
CREATE TRIGGER ai_assignment_validate_update BEFORE UPDATE ON ai_pet_provider_assignments
WHEN OLD.pet_id IS NOT NEW.pet_id OR NEW.assigned_at<OLD.assigned_at OR NOT EXISTS (
  SELECT 1 FROM ai_provider_configs p WHERE p.provider_id=NEW.provider_id AND p.revision=NEW.provider_revision
  AND p.updated_at<=NEW.assigned_at AND (json_extract(p.config_json,'$.privacyBoundary')<>'CLOUD' OR NEW.consent_ref IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'provider assignment requires current consent and configuration'); END;

CREATE TABLE ai_conversations (
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  conversation_id TEXT NOT NULL CHECK (${sqlId('conversation_id')}),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (${unsigned('created_at')}),
  updated_at INTEGER NOT NULL CHECK (${unsigned('updated_at')} AND updated_at>=created_at),
  PRIMARY KEY (pet_id,conversation_id)
) STRICT;
CREATE INDEX ai_conversation_time ON ai_conversations(pet_id,updated_at DESC,conversation_id);
CREATE TABLE ai_turns (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('request_id')}),
  pet_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('USER','PROACTIVE')),
  provider_id TEXT NOT NULL CHECK (${sqlId('provider_id')}),
  provider_revision INTEGER NOT NULL CHECK (${positive('provider_revision')}),
  provider_consent_ref TEXT CHECK (${sqlId('provider_consent_ref')} AND provider_consent_ref LIKE 'consent:%'),
  provider_assigned_at INTEGER NOT NULL CHECK (${unsigned('provider_assigned_at')}),
  character_id TEXT NOT NULL CHECK (${sqlId('character_id')}),
  persona_revision INTEGER NOT NULL CHECK (${unsigned('persona_revision')}),
  snapshot_revision INTEGER NOT NULL CHECK (${unsigned('snapshot_revision')}),
  started_at INTEGER NOT NULL CHECK (${unsigned('started_at')}),
  deadline INTEGER NOT NULL CHECK (${positive('deadline')} AND deadline>started_at),
  user_message_id TEXT UNIQUE CHECK (${sqlId('user_message_id')}),
  assistant_message_id TEXT UNIQUE NOT NULL CHECK (${sqlId('assistant_message_id')}),
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
  terminal_at INTEGER CHECK (${unsigned('terminal_at')} AND terminal_at>=started_at),
  error_code TEXT CHECK (error_code IN ('AUTH_REQUIRED','RATE_LIMITED','CONTEXT_LIMIT','TIMEOUT','NETWORK','UNAVAILABLE','UNSUPPORTED','INVALID_RESPONSE','REFUSED','TRUNCATED','INTERNAL_ERROR')),
  cancel_reason TEXT CHECK (cancel_reason IN ('USER','SUPERSEDED','PET_SWITCH','TIMEOUT','SERVICE_STOPPED')),
  emotion TEXT CHECK (emotion IN ('neutral','calm','happy','excited','sad','upset','tired','surprised','embarrassed')),
  motion_intent TEXT,
  usage_json TEXT CHECK (${json('usage_json')}),
  UNIQUE (request_id,pet_id,conversation_id),
  FOREIGN KEY (pet_id,conversation_id) REFERENCES ai_conversations(pet_id,conversation_id),
  FOREIGN KEY (user_message_id) REFERENCES ai_messages(message_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (assistant_message_id) REFERENCES ai_messages(message_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((trigger='USER' AND user_message_id IS NOT NULL AND user_message_id<>assistant_message_id) OR (trigger='PROACTIVE' AND user_message_id IS NULL)),
  CHECK ((status='PENDING' AND terminal_at IS NULL AND error_code IS NULL AND cancel_reason IS NULL AND emotion IS NULL AND motion_intent IS NULL AND usage_json IS NULL)
    OR (status='COMPLETED' AND terminal_at IS NOT NULL AND terminal_at<deadline AND error_code IS NULL AND cancel_reason IS NULL AND emotion IS NOT NULL)
    OR (status='FAILED' AND terminal_at IS NOT NULL AND error_code IS NOT NULL AND cancel_reason IS NULL AND emotion IS NULL AND motion_intent IS NULL AND usage_json IS NULL)
    OR (status='CANCELLED' AND terminal_at IS NOT NULL AND error_code IS NULL AND cancel_reason IS NOT NULL AND emotion IS NULL AND motion_intent IS NULL AND usage_json IS NULL))
) STRICT;
CREATE UNIQUE INDEX ai_one_pending_per_pet ON ai_turns(pet_id) WHERE status='PENDING';
CREATE INDEX ai_turn_conversation_time ON ai_turns(pet_id,conversation_id,started_at,request_id);
CREATE TRIGGER ai_turn_identity_immutable BEFORE UPDATE ON ai_turns
WHEN OLD.status<>'PENDING' OR OLD.request_id IS NOT NEW.request_id OR OLD.pet_id IS NOT NEW.pet_id OR OLD.conversation_id IS NOT NEW.conversation_id
  OR OLD.trigger IS NOT NEW.trigger OR OLD.provider_id IS NOT NEW.provider_id OR OLD.provider_revision IS NOT NEW.provider_revision
  OR OLD.provider_consent_ref IS NOT NEW.provider_consent_ref OR OLD.provider_assigned_at IS NOT NEW.provider_assigned_at
  OR OLD.character_id IS NOT NEW.character_id
  OR OLD.persona_revision IS NOT NEW.persona_revision OR OLD.snapshot_revision IS NOT NEW.snapshot_revision
  OR OLD.started_at IS NOT NEW.started_at OR OLD.deadline IS NOT NEW.deadline OR OLD.user_message_id IS NOT NEW.user_message_id
  OR OLD.assistant_message_id IS NOT NEW.assistant_message_id OR NEW.status='PENDING'
BEGIN SELECT RAISE(ABORT,'AI turn identity and terminal are immutable'); END;
CREATE TRIGGER ai_turn_no_delete BEFORE DELETE ON ai_turns BEGIN SELECT RAISE(ABORT,'AI turn request identity is immutable'); END;

CREATE TABLE ai_messages (
  message_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('message_id')}),
  request_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('USER','ASSISTANT')),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','PENDING','CANCELLED','FAILED')),
  text TEXT NOT NULL CHECK (length(text)<=8000),
  created_at INTEGER NOT NULL CHECK (${unsigned('created_at')}),
  content_revision INTEGER NOT NULL DEFAULT 0 CHECK (${unsigned('content_revision')}),
  edited_at INTEGER CHECK (${unsigned('edited_at')} AND edited_at>=created_at),
  deleted_at INTEGER CHECK (${unsigned('deleted_at')} AND deleted_at>=created_at),
  UNIQUE(request_id,role),
  FOREIGN KEY (request_id,pet_id,conversation_id) REFERENCES ai_turns(request_id,pet_id,conversation_id),
  CHECK ((role='USER' AND status='COMPLETED' AND length(text)<=4000) OR role='ASSISTANT'),
  CHECK ((deleted_at IS NOT NULL AND text='' AND status<>'PENDING') OR (deleted_at IS NULL
    AND ((status='COMPLETED' AND length(text)>0) OR (status<>'COMPLETED' AND text=''))))
) STRICT;
CREATE INDEX ai_message_history ON ai_messages(pet_id,conversation_id,created_at,request_id,role) WHERE deleted_at IS NULL;
CREATE TRIGGER ai_message_insert_guard BEFORE INSERT ON ai_messages
WHEN NEW.content_revision<>0 OR NEW.edited_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM ai_turns t WHERE t.request_id=NEW.request_id AND t.pet_id=NEW.pet_id AND t.conversation_id=NEW.conversation_id
  AND t.status='PENDING' AND t.started_at=NEW.created_at AND ((NEW.role='USER' AND t.user_message_id=NEW.message_id AND NEW.status='COMPLETED')
    OR (NEW.role='ASSISTANT' AND t.assistant_message_id=NEW.message_id AND NEW.status='PENDING')))
BEGIN SELECT RAISE(ABORT,'AI message must belong to its exact pending turn'); END;
CREATE TRIGGER ai_message_update_guard BEFORE UPDATE ON ai_messages
WHEN OLD.message_id IS NOT NEW.message_id OR OLD.request_id IS NOT NEW.request_id OR OLD.pet_id IS NOT NEW.pet_id
  OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.role IS NOT NEW.role OR OLD.created_at IS NOT NEW.created_at
  OR OLD.deleted_at IS NOT NULL
  OR (OLD.role='USER' AND OLD.status IS NOT NEW.status)
  OR (OLD.role='ASSISTANT' AND OLD.status IS NOT NEW.status AND (OLD.status<>'PENDING' OR NEW.status='PENDING'
    OR NOT EXISTS(SELECT 1 FROM ai_turns t WHERE t.request_id=NEW.request_id AND t.status=NEW.status)))
  OR (OLD.role='ASSISTANT' AND OLD.status<>'PENDING' AND OLD.text IS NOT NEW.text AND NEW.deleted_at IS NULL)
  OR ((OLD.role='USER' AND OLD.text IS NOT NEW.text OR NEW.deleted_at IS NOT OLD.deleted_at) AND NEW.content_revision<>OLD.content_revision+1)
  OR NEW.content_revision<OLD.content_revision OR NEW.content_revision>OLD.content_revision+1
BEGIN SELECT RAISE(ABORT,'invalid AI message identity or lifecycle transition'); END;
CREATE TRIGGER ai_message_no_delete BEFORE DELETE ON ai_messages BEGIN SELECT RAISE(ABORT,'redact AI content without erasing request identity'); END;

CREATE TABLE ai_turn_sources (
  request_id TEXT NOT NULL REFERENCES ai_turns(request_id),
  message_id TEXT NOT NULL REFERENCES ai_messages(message_id),
  source_revision INTEGER NOT NULL CHECK (${unsigned('source_revision')}),
  PRIMARY KEY(request_id,message_id)
) STRICT;
-- Deliberately no FK to live memory: a forgotten fact must disappear while
-- still allowing a pending turn to detect that its frozen context is stale.
CREATE TABLE ai_turn_memory_refs (
  request_id TEXT NOT NULL REFERENCES ai_turns(request_id),
  memory_id TEXT NOT NULL CHECK (${sqlId('memory_id')}),
  memory_revision INTEGER NOT NULL CHECK (${positive('memory_revision')}),
  PRIMARY KEY(request_id,memory_id)
) STRICT;
CREATE TRIGGER ai_turn_source_insert_guard BEFORE INSERT ON ai_turn_sources
WHEN NOT EXISTS(SELECT 1 FROM ai_turns t JOIN ai_messages m ON m.message_id=NEW.message_id
  WHERE t.request_id=NEW.request_id AND t.status='PENDING' AND t.pet_id=m.pet_id
  AND t.conversation_id=m.conversation_id AND m.status='COMPLETED'
  AND m.deleted_at IS NULL AND m.content_revision=NEW.source_revision AND m.created_at<=t.started_at)
BEGIN SELECT RAISE(ABORT,'AI turn source must match pending context'); END;
CREATE TRIGGER ai_turn_source_no_update BEFORE UPDATE ON ai_turn_sources BEGIN SELECT RAISE(ABORT,'AI turn source is immutable'); END;
CREATE TRIGGER ai_turn_source_no_delete BEFORE DELETE ON ai_turn_sources BEGIN SELECT RAISE(ABORT,'AI turn source identity is immutable'); END;
CREATE TRIGGER ai_turn_memory_ref_no_update BEFORE UPDATE ON ai_turn_memory_refs BEGIN SELECT RAISE(ABORT,'AI turn memory revision is immutable'); END;
CREATE TRIGGER ai_turn_memory_ref_no_delete BEFORE DELETE ON ai_turn_memory_refs BEGIN SELECT RAISE(ABORT,'AI turn memory identity is immutable'); END;
-- These ID-only tombstones contain no user/model content. They prevent a
-- forgotten record or rejected proposal from being revived under a reused ID.
CREATE TABLE ai_proposal_ids (proposal_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('proposal_id')})) STRICT;
CREATE TABLE ai_candidate_ids (candidate_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('candidate_id')})) STRICT;
CREATE TABLE ai_memory_ids (memory_id TEXT PRIMARY KEY NOT NULL CHECK (${sqlId('memory_id')})) STRICT;
CREATE TRIGGER ai_proposal_id_no_update BEFORE UPDATE ON ai_proposal_ids BEGIN SELECT RAISE(ABORT,'AI proposal identity is immutable'); END;
CREATE TRIGGER ai_proposal_id_no_delete BEFORE DELETE ON ai_proposal_ids BEGIN SELECT RAISE(ABORT,'AI proposal identity is immutable'); END;
CREATE TRIGGER ai_candidate_id_no_update BEFORE UPDATE ON ai_candidate_ids BEGIN SELECT RAISE(ABORT,'AI candidate identity is immutable'); END;
CREATE TRIGGER ai_candidate_id_no_delete BEFORE DELETE ON ai_candidate_ids BEGIN SELECT RAISE(ABORT,'AI candidate identity is immutable'); END;
CREATE TRIGGER ai_memory_id_no_update BEFORE UPDATE ON ai_memory_ids BEGIN SELECT RAISE(ABORT,'AI memory identity is immutable'); END;
CREATE TRIGGER ai_memory_id_no_delete BEFORE DELETE ON ai_memory_ids BEGIN SELECT RAISE(ABORT,'AI memory identity is immutable'); END;
CREATE TABLE ai_action_proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL REFERENCES ai_proposal_ids(proposal_id),
  request_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (${json('proposal_json')}),
  expires_at INTEGER NOT NULL CHECK (${positive('expires_at')}),
  FOREIGN KEY(request_id,pet_id,conversation_id) REFERENCES ai_turns(request_id,pet_id,conversation_id)
) STRICT;
CREATE INDEX ai_proposal_expiry ON ai_action_proposals(pet_id,expires_at);
CREATE TABLE ai_memory_candidates (
  candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES ai_candidate_ids(candidate_id),
  owner_pet_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('PRIVATE','SHARED')),
  type TEXT NOT NULL CHECK (type IN ('PREFERENCE','HISTORY','AGREEMENT')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 512),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL CHECK (${unsigned('created_at')}),
  expires_at INTEGER NOT NULL CHECK (${positive('expires_at')} AND expires_at>created_at),
  FOREIGN KEY(request_id,owner_pet_id,conversation_id) REFERENCES ai_turns(request_id,pet_id,conversation_id)
) STRICT;
CREATE INDEX ai_candidate_owner ON ai_memory_candidates(owner_pet_id,created_at DESC,candidate_id);
CREATE TABLE ai_candidate_sources (
  candidate_id TEXT NOT NULL REFERENCES ai_memory_candidates(candidate_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ai_messages(message_id),
  source_revision INTEGER NOT NULL CHECK (${unsigned('source_revision')}),
  PRIMARY KEY(candidate_id,message_id)
) STRICT;
CREATE TABLE ai_memories (
  memory_id TEXT PRIMARY KEY NOT NULL REFERENCES ai_memory_ids(memory_id),
  owner_pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  source_conversation_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('PRIVATE','SHARED')),
  type TEXT NOT NULL CHECK (type IN ('PREFERENCE','HISTORY','AGREEMENT')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 512),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL CHECK (${unsigned('created_at')}),
  updated_at INTEGER NOT NULL CHECK (${unsigned('updated_at')} AND updated_at>=created_at),
  expires_at INTEGER CHECK (${positive('expires_at')} AND expires_at>created_at),
  pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (${positive('revision')}),
  FOREIGN KEY(owner_pet_id,source_conversation_id) REFERENCES ai_conversations(pet_id,conversation_id)
) STRICT;
CREATE INDEX ai_memory_owner ON ai_memories(owner_pet_id,updated_at DESC,memory_id);
CREATE TABLE ai_memory_sources (
  memory_id TEXT NOT NULL REFERENCES ai_memories(memory_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ai_messages(message_id),
  source_revision INTEGER NOT NULL CHECK (${unsigned('source_revision')}),
  PRIMARY KEY(memory_id,message_id)
) STRICT;
CREATE TABLE ai_memory_grants (
  memory_id TEXT NOT NULL REFERENCES ai_memories(memory_id) ON DELETE CASCADE,
  recipient_pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  granted_at INTEGER NOT NULL CHECK (${unsigned('granted_at')}),
  PRIMARY KEY(memory_id,recipient_pet_id)
) STRICT;
CREATE INDEX ai_memory_recipient ON ai_memory_grants(recipient_pet_id,memory_id);
CREATE TRIGGER ai_candidate_source_guard BEFORE INSERT ON ai_candidate_sources
WHEN NOT EXISTS(SELECT 1 FROM ai_memory_candidates c JOIN ai_messages m ON m.message_id=NEW.message_id
  WHERE c.candidate_id=NEW.candidate_id AND c.owner_pet_id=m.pet_id AND c.conversation_id=m.conversation_id
   AND m.role='USER' AND m.status='COMPLETED' AND m.deleted_at IS NULL AND m.content_revision=NEW.source_revision AND m.created_at<=c.created_at)
BEGIN SELECT RAISE(ABORT,'memory candidate source must be eligible user message'); END;
CREATE TRIGGER ai_memory_source_guard BEFORE INSERT ON ai_memory_sources
WHEN NOT EXISTS(SELECT 1 FROM ai_memories c JOIN ai_messages m ON m.message_id=NEW.message_id
  WHERE c.memory_id=NEW.memory_id AND c.owner_pet_id=m.pet_id AND c.source_conversation_id=m.conversation_id
   AND m.role='USER' AND m.status='COMPLETED' AND m.deleted_at IS NULL AND m.content_revision=NEW.source_revision AND m.created_at<=c.created_at)
BEGIN SELECT RAISE(ABORT,'memory source must be eligible user message'); END;
CREATE TRIGGER ai_grant_guard BEFORE INSERT ON ai_memory_grants
WHEN NOT EXISTS(SELECT 1 FROM ai_memories m WHERE m.memory_id=NEW.memory_id AND m.scope='SHARED'
  AND m.owner_pet_id<>NEW.recipient_pet_id AND m.created_at<=NEW.granted_at)
BEGIN SELECT RAISE(ABORT,'memory grant requires explicit shared scope and separate recipient'); END;
CREATE TRIGGER ai_redact_dependent_sources AFTER UPDATE OF content_revision,deleted_at ON ai_messages
WHEN OLD.content_revision IS NOT NEW.content_revision OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  DELETE FROM ai_memory_candidates WHERE candidate_id IN (SELECT candidate_id FROM ai_candidate_sources WHERE message_id=NEW.message_id);
  DELETE FROM ai_memories WHERE memory_id IN (SELECT memory_id FROM ai_memory_sources WHERE message_id=NEW.message_id);
  DELETE FROM ai_action_proposals WHERE request_id IN (SELECT request_id FROM ai_turn_sources WHERE message_id=NEW.message_id);
END;
`;

export interface AiProviderRecord { config: ProviderConfig; revision: number; updatedAt: number }
export interface AiProviderAssignment { petId: string; providerId: string; providerRevision: number; consentRef: string | null; assignedAt: number }
export interface ResolvedAiAssignment { assignment: AiProviderAssignment; provider: AiProviderRecord }
export interface AiBeginTurnInput { turn: TurnRequest; providerId: string; providerRevision: number; assistantMessageId: string; startedAt: number }
export interface AiTurnIdentity { requestId: string; petId: string; conversationId: string }
export interface AiTurnRecord extends AiTurnIdentity {
  trigger: 'USER' | 'PROACTIVE'; providerId: string; providerRevision: number; providerConsentRef:string|null; providerAssignedAt:number;
  characterId: string; personaRevision: number; snapshotRevision: number;
  startedAt: number; deadline: number; userMessageId: string | null; assistantMessageId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'; terminalAt: number | null;
  errorCode: AiErrorCode | null; cancelReason: AiCancelReason | null;
  emotion: ChatReply['emotion'] | null; motionIntent: string | null; usage: AiUsage | null;
}
type TerminalFields = AiTurnIdentity & { completedAt: number };
export type AiChatTerminal =
  | (TerminalFields & { kind: 'COMPLETED'; reply: ChatReply; usage: AiUsage | null;
    proposals: readonly ActionProposal[]; memoryCandidates: readonly PendingMemoryCandidate[] })
  | (TerminalFields & { kind: 'FAILED'; error: AiError })
  | (TerminalFields & { kind: 'CANCELLED'; reason: AiCancelReason });

type AiMemoryEditBase = { kind:'EDIT'; summary:string; expiresAt:number|null; pinned:boolean };
export type AiMemoryEdit = AiMemoryEditBase & ({scope:'PRIVATE'} | {scope:'SHARED';recipientPetIds:string[]});
export type AiConfirmMemoryResult = ConfirmMemoryResult | { ok: false; reason: 'NOT_FOUND' };

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI storage row');
  return value as Row;
}
function closed(value:unknown, keys:readonly string[]):Row {
  const data=row(value);if(Object.keys(data).length!==keys.length||keys.some(key=>!Object.hasOwn(data,key)))throw new Error('Invalid closed AI storage input');return data;
}
const idSchema={parse(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))throw new Error('Invalid AI identity');return value;}};
const time={parse(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Invalid AI timestamp or revision');return value;}};
function pos(value:unknown):number {const parsed=time.parse(value);if(parsed===0)throw new Error('Invalid positive AI integer');return parsed;}
function enumValue<T extends string>(value:unknown, allowed:readonly T[]):T {if(typeof value!=='string'||!allowed.includes(value as T))throw new Error('Invalid AI enum');return value as T;}
function ids(value:unknown,max:number):string[]{if(!Array.isArray(value)||value.length<1||value.length>max)throw new Error('Invalid AI identities');return value.map(idSchema.parse);}
function boundedArray<T>(value:unknown,max:number,parse:(raw:unknown)=>T):T[]{if(!Array.isArray(value)||value.length>max)throw new Error('Invalid AI bounded array');return value.map(entry=>parse(entry));}
function parseAssignment(value:unknown):AiProviderAssignment {
  const data=closed(value,['petId','providerId','providerRevision','consentRef','assignedAt']);
  if(data.consentRef!==null&&(typeof data.consentRef!=='string'||!/^consent:[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(data.consentRef)))throw new Error('Invalid provider consent reference');
  return {petId:idSchema.parse(data.petId),providerId:idSchema.parse(data.providerId),providerRevision:pos(data.providerRevision),consentRef:data.consentRef,assignedAt:time.parse(data.assignedAt)};
}
function parseBegin(value:unknown):AiBeginTurnInput {
  const data=closed(value,['turn','providerId','providerRevision','assistantMessageId','startedAt']);return{turn:turnRequestSchema.parse(data.turn),providerId:idSchema.parse(data.providerId),
    providerRevision:pos(data.providerRevision),assistantMessageId:idSchema.parse(data.assistantMessageId),startedAt:time.parse(data.startedAt)};
}
const terminalFields=['requestId','petId','conversationId','completedAt','kind'] as const;
function parseTerminal(raw:unknown):AiChatTerminal {
  const kind=row(raw).kind;
  const data=kind==='COMPLETED'?closed(raw,[...terminalFields,'reply','usage','proposals','memoryCandidates']):kind==='FAILED'?closed(raw,[...terminalFields,'error']):closed(raw,[...terminalFields,'reason']);
  const base={requestId:idSchema.parse(data.requestId),petId:idSchema.parse(data.petId),conversationId:idSchema.parse(data.conversationId),completedAt:time.parse(data.completedAt)};
  if(kind==='COMPLETED')return{...base,kind,reply:chatReplySchema.parse(data.reply),usage:data.usage===null?null:aiUsageSchema.parse(data.usage),
    proposals:boundedArray(data.proposals,aiLimits.proposals,value=>actionProposalSchema.parse(value)),memoryCandidates:boundedArray(data.memoryCandidates,aiLimits.memoryCandidates,value=>pendingMemoryCandidateSchema.parse(value))};
  if(kind==='FAILED')return{...base,kind,error:aiErrorSchema.parse(data.error)};
  if(kind==='CANCELLED')return{...base,kind,reason:aiCancelReasonSchema.parse(data.reason)};
  throw new Error('Invalid AI terminal kind');
}
function parseTurnRecord(value:unknown):AiTurnRecord {
  const data=row(value),motion=data.motionIntent;
  if(motion!==null&&(typeof motion!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(motion)))throw new Error('Invalid stored AI motion');
  const providerConsentRef=data.providerConsentRef;
  if(providerConsentRef!==null&&(typeof providerConsentRef!=='string'||!/^consent:[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(providerConsentRef)))throw new Error('Invalid stored AI consent');
  return {requestId:idSchema.parse(data.requestId),petId:idSchema.parse(data.petId),conversationId:idSchema.parse(data.conversationId),trigger:enumValue(data.trigger,['USER','PROACTIVE']),
    providerId:idSchema.parse(data.providerId),providerRevision:pos(data.providerRevision),providerConsentRef,providerAssignedAt:time.parse(data.providerAssignedAt),characterId:idSchema.parse(data.characterId),personaRevision:time.parse(data.personaRevision),snapshotRevision:time.parse(data.snapshotRevision),
    startedAt:time.parse(data.startedAt),deadline:pos(data.deadline),userMessageId:data.userMessageId===null?null:idSchema.parse(data.userMessageId),assistantMessageId:idSchema.parse(data.assistantMessageId),
    status:enumValue(data.status,['PENDING','COMPLETED','FAILED','CANCELLED']),terminalAt:data.terminalAt===null?null:time.parse(data.terminalAt),
    errorCode:data.errorCode===null?null:aiErrorCodeSchema.parse(data.errorCode),cancelReason:data.cancelReason===null?null:aiCancelReasonSchema.parse(data.cancelReason),
    emotion:data.emotion===null?null:chatEmotionSchema.parse(data.emotion),motionIntent:motion,usage:data.usage===null?null:aiUsageSchema.parse(data.usage)};
}
function parseMemoryEdit(raw:unknown):AiMemoryEdit {
  const scope=row(raw).scope, data=closed(raw,['kind','scope','summary','expiresAt','pinned',...(scope==='SHARED'?['recipientPetIds']:[])]);
  if(data.kind!=='EDIT'||typeof data.summary!=='string'||data.summary.length<1||data.summary.length>512||typeof data.pinned!=='boolean')throw new Error('Invalid memory edit');
  const base={kind:'EDIT' as const,summary:data.summary,expiresAt:data.expiresAt===null?null:pos(data.expiresAt),pinned:data.pinned};
  if(scope==='PRIVATE')return{...base,scope};if(scope==='SHARED')return{...base,scope,recipientPetIds:ids(data.recipientPetIds,100)};throw new Error('Invalid memory scope');
}
function int(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  return time.parse(parsed);
}
function nullableInt(value: unknown): number | null { return value === null ? null : int(value); }
function bool(value: unknown): boolean { const number = int(value); if (number>1) throw new Error('Invalid AI boolean'); return number===1; }
function parseJson(value: unknown): unknown { if (typeof value !== 'string') throw new Error('Invalid AI JSON'); return JSON.parse(value) as unknown; }
function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry === null || typeof entry !== 'object' || Array.isArray(entry) ? entry
    : Object.fromEntries(Object.entries(entry).sort(([a],[b]) => a<b?-1:a>b?1:0)));
}
function same(a: unknown, b: unknown): boolean { return jsonText(a)===jsonText(b); }
function page(limit: number, offset = 0, max = 100): [number,number] {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>max || !Number.isSafeInteger(offset) || offset<0 || offset>10_000) throw new RangeError('Invalid AI page');
  return [limit,offset];
}
function identity(value: AiTurnIdentity): AiTurnIdentity { return { requestId: value.requestId, petId: value.petId, conversationId: value.conversationId }; }
function sameIdentity(a: AiTurnIdentity,b: AiTurnIdentity): boolean { return a.requestId===b.requestId && a.petId===b.petId && a.conversationId===b.conversationId; }

/** All operations use the existing transaction and single SQLite connection.
 * The outer repository must rollback on any thrown error. This class does
 * not own transactions, network, credentials, clock or command authority. */
export class AiStateStorage {
  private readonly connection: SqliteConnection;
  private readonly inScope: () => boolean;
  constructor(connection: SqliteConnection, inScope: () => boolean) {
    this.connection=connection; this.inScope=inScope;
  }
  private get db(): SqliteConnection { if (!this.inScope()) throw new Error('Transaction is no longer active'); return this.connection; }
  private run(sql: string, ...params: SqlValue[]): number { return int(this.db.prepare(sql).run(...params).changes); }
  private get(sql: string, ...params: SqlValue[]): Row | null {
    const value = this.db.prepare(sql).get(...params); return value===undefined || value===null ? null : row(value);
  }
  private all(sql: string, ...params: SqlValue[]): Row[] { return this.db.prepare(sql).all(...params).map(row); }

  private providerFromRow(value: Row): AiProviderRecord {
    const config = providerConfigSchema.parse(parseJson(value.config_json));
    if (config.providerId!==idSchema.parse(value.provider_id)) throw new Error('Provider identity mismatch');
    return { config,revision:pos(int(value.revision)),updatedAt:int(value.updated_at) };
  }
  getProviderConfig(providerId: string): AiProviderRecord | null {
    const value=this.get('SELECT * FROM ai_provider_configs WHERE provider_id=?',idSchema.parse(providerId)); return value ? this.providerFromRow(value) : null;
  }
  listProviderConfigs(limit = 50, offset = 0): AiProviderRecord[] {
    const [take,skip]=page(limit,offset); return this.all('SELECT * FROM ai_provider_configs ORDER BY provider_id LIMIT ? OFFSET ?',take,skip).map(value=>this.providerFromRow(value));
  }
  saveProviderConfig(config: ProviderConfig, expectedRevision: number | null, at: number): AiProviderRecord {
    const parsed=providerConfigSchema.parse(config), now=time.parse(at), current=this.getProviderConfig(parsed.providerId);
    if (current ? expectedRevision!==current.revision || now<current.updatedAt : expectedRevision!==null) throw new Error('Provider config revision conflict');
    if (current && same(current.config,parsed)) return current;
    const revision=current ? time.parse(current.revision+1) : 1;
    if (current) this.run('UPDATE ai_provider_configs SET config_json=?,revision=?,updated_at=? WHERE provider_id=?',jsonText(parsed),revision,now,parsed.providerId);
    else this.run('INSERT INTO ai_provider_configs VALUES (?,?,?,?)',parsed.providerId,jsonText(parsed),revision,now);
    return {config:parsed,revision,updatedAt:now};
  }
  getPetProviderAssignment(petId: string): AiProviderAssignment | null {
    const value=this.get('SELECT * FROM ai_pet_provider_assignments WHERE pet_id=?',idSchema.parse(petId));
    return value ? parseAssignment({petId:value.pet_id,providerId:value.provider_id,providerRevision:int(value.provider_revision),
      consentRef:value.consent_ref,assignedAt:int(value.assigned_at)}) : null;
  }
  setPetProviderAssignment(value: AiProviderAssignment): void {
    const assignment=parseAssignment(value), provider=this.getProviderConfig(assignment.providerId);
    if (!provider || provider.revision!==assignment.providerRevision || provider.updatedAt>assignment.assignedAt
      || (provider.config.privacyBoundary==='CLOUD' && assignment.consentRef===null)) throw new Error('Current provider consent required');
    this.run(`INSERT INTO ai_pet_provider_assignments VALUES(?,?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET
      provider_id=excluded.provider_id,provider_revision=excluded.provider_revision,consent_ref=excluded.consent_ref,assigned_at=excluded.assigned_at`,
    assignment.petId,assignment.providerId,assignment.providerRevision,assignment.consentRef,assignment.assignedAt);
  }
  clearPetProviderAssignment(petId: string): boolean { return this.run('DELETE FROM ai_pet_provider_assignments WHERE pet_id=?',idSchema.parse(petId))===1; }
  resolveAssignedProvider(petId: string): ResolvedAiAssignment | null {
    const assignment=this.getPetProviderAssignment(petId); if (!assignment) return null;
    const provider=this.getProviderConfig(assignment.providerId);
    return provider && provider.revision===assignment.providerRevision && provider.updatedAt<=assignment.assignedAt
      && (provider.config.privacyBoundary!=='CLOUD' || assignment.consentRef!==null) ? {assignment,provider} : null;
  }

  private conversationFromRow(value: Row): Conversation {
    return conversationSchema.parse({petId:value.pet_id,conversationId:value.conversation_id,title:value.title,createdAt:int(value.created_at),updatedAt:int(value.updated_at)});
  }
  createConversation(value: Conversation): void {
    const conversation=conversationSchema.parse(value);
    this.run('INSERT INTO ai_conversations VALUES(?,?,?,?,?)',conversation.petId,conversation.conversationId,conversation.title,conversation.createdAt,conversation.updatedAt);
  }
  getConversation(petId: string, conversationId: string): Conversation | null {
    const value=this.get('SELECT * FROM ai_conversations WHERE pet_id=? AND conversation_id=?',idSchema.parse(petId),idSchema.parse(conversationId));
    return value ? this.conversationFromRow(value) : null;
  }
  listConversations(petId: string, limit=50,offset=0): Conversation[] {
    const [take,skip]=page(limit,offset); return this.all('SELECT * FROM ai_conversations WHERE pet_id=? ORDER BY updated_at DESC,conversation_id LIMIT ? OFFSET ?',
      idSchema.parse(petId),take,skip).map(value=>this.conversationFromRow(value));
  }
  private touchConversation(petId:string,conversationId:string,at:number):void {
    if (this.run('UPDATE ai_conversations SET updated_at=max(updated_at,?) WHERE pet_id=? AND conversation_id=?',at,petId,conversationId)!==1) throw new Error('Missing AI conversation');
  }

  private messageFromRow(value: Row): ChatMessage {
    return chatMessageSchema.parse({messageId:value.message_id,requestId:value.request_id,petId:value.pet_id,conversationId:value.conversation_id,
      role:value.role,status:value.status,text:value.text,createdAt:int(value.created_at)});
  }
  private messageRow(messageId: string): Row | null { return this.get('SELECT * FROM ai_messages WHERE message_id=? AND deleted_at IS NULL',idSchema.parse(messageId)); }
  lookupMessage(messageId: string): ChatMessage | null { const value=this.messageRow(messageId); return value ? this.messageFromRow(value) : null; }
  getMessage(petId:string,conversationId:string,messageId:string):ChatMessage|null {
    const value=this.get('SELECT * FROM ai_messages WHERE pet_id=? AND conversation_id=? AND message_id=? AND deleted_at IS NULL',idSchema.parse(petId),idSchema.parse(conversationId),idSchema.parse(messageId));
    return value ? this.messageFromRow(value) : null;
  }
  listMessages(petId:string,conversationId:string,limit=50,offset=0):ChatMessage[] {
    const [take,skip]=page(limit,offset);return this.all(`SELECT * FROM ai_messages WHERE pet_id=? AND conversation_id=? AND deleted_at IS NULL
      ORDER BY created_at DESC,request_id DESC,CASE role WHEN 'ASSISTANT' THEN 0 ELSE 1 END LIMIT ? OFFSET ?`,idSchema.parse(petId),idSchema.parse(conversationId),take,skip)
      .map(value=>this.messageFromRow(value)).reverse();
  }
  listRecentCompletedMessages(petId:string,conversationId:string,limit:number=aiLimits.historyMessages):ChatMessage[] {
    const [take]=page(limit,0,aiLimits.historyMessages);return this.all(`SELECT * FROM ai_messages WHERE pet_id=? AND conversation_id=? AND deleted_at IS NULL AND status='COMPLETED'
      ORDER BY created_at DESC,request_id DESC,CASE role WHEN 'ASSISTANT' THEN 0 ELSE 1 END LIMIT ?`,idSchema.parse(petId),idSchema.parse(conversationId),take)
      .map(value=>this.messageFromRow(value)).reverse();
  }
  private insertMessage(value:ChatMessage):void {
    const message=chatMessageSchema.parse(value);this.run(`INSERT INTO ai_messages(message_id,request_id,pet_id,conversation_id,role,status,text,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,message.messageId,message.requestId,message.petId,message.conversationId,message.role,message.status,message.text,message.createdAt);
  }
  editUserMessage(petId:string,conversationId:string,messageId:string,text:string,at:number):boolean {
    const value=this.getMessage(petId,conversationId,messageId), now=time.parse(at);
    if (!value || value.role!=='USER' || now<value.createdAt) return false;
    chatMessageSchema.parse({...value,text}); if (text===value.text) return false;
    const current=this.messageRow(messageId)!; if (current.edited_at!==null && now<int(current.edited_at)) throw new Error('Message edit time regressed');
    this.run('UPDATE ai_messages SET text=?,content_revision=content_revision+1,edited_at=? WHERE message_id=?',text,now,messageId);
    this.touchConversation(petId,conversationId,now);return true;
  }
  deleteMessage(petId:string,conversationId:string,messageId:string,at:number):boolean {
    const value=this.getMessage(petId,conversationId,messageId),now=time.parse(at);
    if (!value || value.status==='PENDING' || now<value.createdAt) return false;
    const current=this.messageRow(messageId)!; if (current.edited_at!==null && now<int(current.edited_at)) throw new Error('Message deletion time regressed');
    this.run("UPDATE ai_messages SET text='',content_revision=content_revision+1,deleted_at=? WHERE message_id=?",now,messageId);
    this.touchConversation(petId,conversationId,now);return true;
  }

  private turnFromRow(value:Row):AiTurnRecord {
    return parseTurnRecord({requestId:value.request_id,petId:value.pet_id,conversationId:value.conversation_id,trigger:value.trigger,
      providerId:value.provider_id,providerRevision:int(value.provider_revision),providerConsentRef:value.provider_consent_ref,providerAssignedAt:int(value.provider_assigned_at),characterId:value.character_id,personaRevision:int(value.persona_revision),snapshotRevision:int(value.snapshot_revision),
      startedAt:int(value.started_at),deadline:int(value.deadline),userMessageId:value.user_message_id,assistantMessageId:value.assistant_message_id,
      status:value.status,terminalAt:nullableInt(value.terminal_at),errorCode:value.error_code,cancelReason:value.cancel_reason,emotion:value.emotion,
      motionIntent:value.motion_intent,usage:value.usage_json===null?null:parseJson(value.usage_json)});
  }
  getTurn(requestId:string):AiTurnRecord|null { const value=this.get('SELECT * FROM ai_turns WHERE request_id=?',idSchema.parse(requestId));return value?this.turnFromRow(value):null; }
  hasPendingTurn(petId:string):boolean { return this.get("SELECT 1 FROM ai_turns WHERE pet_id=? AND status='PENDING'",idSchema.parse(petId))!==null; }
  countPendingTurns():number { return int(this.get("SELECT COUNT(*) AS count FROM ai_turns WHERE status='PENDING'")?.count); }

  beginTurn(raw: AiBeginTurnInput): 'STARTED'|'DUPLICATE' {
    const input=parseBegin(raw),turn=input.turn;
    if (this.getTurn(turn.requestId)) return 'DUPLICATE';
    if (turn.trigger!=='USER' && turn.trigger!=='PROACTIVE') throw new Error('Unsupported persisted AI turn trigger');
    const conversation=this.getConversation(turn.petId,turn.conversationId), assigned=this.resolveAssignedProvider(turn.petId);
    if (!conversation || !assigned || assigned.provider.config.providerId!==input.providerId || assigned.provider.revision!==input.providerRevision
      || input.startedAt<conversation.createdAt || input.startedAt>=turn.deadline || input.assistantMessageId===turn.userMessageId
      || assigned.assignment.assignedAt>input.startedAt || turn.context.historySummary!==null) throw new Error('Invalid authoritative AI turn context or provider');
    this.run(`INSERT INTO ai_turns(request_id,pet_id,conversation_id,trigger,provider_id,provider_revision,provider_consent_ref,provider_assigned_at,character_id,persona_revision,snapshot_revision,started_at,deadline,
      user_message_id,assistant_message_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`,turn.requestId,turn.petId,turn.conversationId,turn.trigger,
    input.providerId,input.providerRevision,assigned.assignment.consentRef,assigned.assignment.assignedAt,turn.context.game.characterId,turn.personaRevision,turn.snapshotRevision,input.startedAt,turn.deadline,turn.userMessageId,input.assistantMessageId);
    if (turn.trigger==='USER' && turn.userMessageId!==null && turn.userText!==null) this.insertMessage({...identity(turn),messageId:turn.userMessageId,role:'USER',status:'COMPLETED',text:turn.userText,createdAt:input.startedAt});
    this.insertMessage({...identity(turn),messageId:input.assistantMessageId,role:'ASSISTANT',status:'PENDING',text:'',createdAt:input.startedAt});
    // Validate actual history before storing references; do not persist the
    // prompt or source texts a second time. A later edit/redaction invalidates
    // a result assembled from that previous revision.
    for (const projected of turn.context.recentMessages) {
      const source=this.messageRow(projected.messageId),message=source?this.messageFromRow(source):null;
      if (!source || !message || message.status!=='COMPLETED' || message.petId!==turn.petId || message.conversationId!==turn.conversationId
        || message.role!==projected.role || message.text!==projected.text || message.createdAt!==projected.createdAt || message.createdAt>input.startedAt) throw new Error('AI history projection is stale');
      this.run('INSERT INTO ai_turn_sources VALUES(?,?,?)',turn.requestId,message.messageId,int(source.content_revision));
    }
    if (turn.userMessageId!==null) this.run('INSERT INTO ai_turn_sources VALUES(?,?,0)',turn.requestId,turn.userMessageId);
    for (const memory of turn.context.authorizedMemories) {
      const value=this.get('SELECT * FROM ai_memories WHERE memory_id=?',memory.memoryId);
      if (!value || !this.memoryMetaAuthorized(value,turn.petId,input.startedAt)) throw new Error('AI memory projection lacks current grant');
      const actual=this.memoryFromRow(value);
      if (actual.ownerPetId!==memory.ownerPetId || actual.scope!==memory.scope || actual.type!==memory.type || actual.summary!==memory.summary) throw new Error('AI memory projection is stale');
      this.run('INSERT INTO ai_turn_memory_refs VALUES(?,?,?)',turn.requestId,memory.memoryId,int(value.revision));
    }
    this.touchConversation(turn.petId,turn.conversationId,input.startedAt);return 'STARTED';
  }

  private requireCurrentTurnSources(turn:AiTurnRecord,at:number):void {
    const assigned=this.resolveAssignedProvider(turn.petId);
    if(!assigned||assigned.provider.config.providerId!==turn.providerId||assigned.provider.revision!==turn.providerRevision
      ||assigned.assignment.consentRef!==turn.providerConsentRef||assigned.assignment.assignedAt!==turn.providerAssignedAt)throw new Error('AI provider assignment or consent changed while generating');
    const missing=this.get(`SELECT s.message_id FROM ai_turn_sources s LEFT JOIN ai_messages m ON m.message_id=s.message_id
      WHERE s.request_id=? AND (m.message_id IS NULL OR m.deleted_at IS NOT NULL OR m.content_revision<>s.source_revision
       OR m.pet_id<>? OR m.conversation_id<>? OR m.status<>'COMPLETED') LIMIT 1`,turn.requestId,turn.petId,turn.conversationId);
    if (missing) throw new Error('AI turn source changed while generating');
    for (const ref of this.all('SELECT * FROM ai_turn_memory_refs WHERE request_id=?',turn.requestId)) {
      const value=this.get('SELECT * FROM ai_memories WHERE memory_id=?',idSchema.parse(ref.memory_id));
      if (!value || int(value.revision)!==int(ref.memory_revision) || !this.memoryMetaAuthorized(value,turn.petId,at)) throw new Error('AI memory was forgotten or its grant changed while generating');
      this.memoryFromRow(value);
    }
  }

  /** Credential lookup is an async boundary in the caller. Recheck the
   * exact pending request's persisted consent, sources and memory grants
   * before transmitting any frozen context. Never return a substitute. */
  resolvePendingTurnProvider(identity:AiTurnIdentity,at:number):AiProviderRecord|null {
    const now=time.parse(at),turn=this.getTurn(identity.requestId);
    if(!turn||!sameIdentity(turn,identity)||turn.status!=='PENDING'||now<turn.startedAt||now>=turn.deadline)return null;
    try {this.requireCurrentTurnSources(turn,now);}catch {return null;}
    const provider=this.resolveAssignedProvider(turn.petId)?.provider;
    return provider?.revision===turn.providerRevision && provider.config.providerId===turn.providerId ? provider : null;
  }

  finishTurn(raw:AiChatTerminal):boolean {
    const terminal=parseTerminal(raw),turn=this.getTurn(terminal.requestId);
    if (!turn || !sameIdentity(turn,terminal) || turn.status!=='PENDING') return false;
    if (terminal.completedAt<turn.startedAt || terminal.kind==='COMPLETED' && terminal.completedAt>=turn.deadline) throw new Error('Invalid AI terminal time');
    const pending=this.lookupMessage(turn.assistantMessageId);
    if (!pending || pending.status!=='PENDING' || pending.role!=='ASSISTANT' || !sameIdentity(pending,turn)) throw new Error('Pending assistant identity missing');
    if (terminal.kind==='COMPLETED') {
      this.requireCurrentTurnSources(turn,terminal.completedAt);
      if (!same(terminal.reply.actionProposals,terminal.proposals.map(({type,targetId,reason})=>({type,targetId,reason})))
        || !same(terminal.reply.memoryCandidates,terminal.memoryCandidates.map(({scope,type,summary,sourceMessageIds,confidence})=>({scope,type,summary,sourceMessageIds,confidence})))
        || (turn.trigger!=='USER' && (terminal.proposals.length>0 || terminal.memoryCandidates.length>0))) throw new Error('AI reply contradicts validated pending records');
      for (const proposal of terminal.proposals) {
        if (!sameIdentity(turn,proposal) || proposal.expiresAt<=terminal.completedAt) throw new Error('Invalid proposal authority identity');
      }
      for (const candidate of terminal.memoryCandidates) this.validateCandidateForTurn(turn,candidate,terminal.completedAt);
    }
    const status=terminal.kind, text=terminal.kind==='COMPLETED'?terminal.reply.text:'';
    const changed=this.run(`UPDATE ai_turns SET status=?,terminal_at=?,error_code=?,cancel_reason=?,emotion=?,motion_intent=?,usage_json=? WHERE request_id=? AND status='PENDING'`,status,
      terminal.completedAt,terminal.kind==='FAILED'?terminal.error.code:null,terminal.kind==='CANCELLED'?terminal.reason:null,
      terminal.kind==='COMPLETED'?terminal.reply.emotion:null,terminal.kind==='COMPLETED'?terminal.reply.motionIntent:null,
      terminal.kind==='COMPLETED' && terminal.usage!==null?jsonText(terminal.usage):null,turn.requestId);
    if (changed!==1) return false;
    if (this.run('UPDATE ai_messages SET status=?,text=? WHERE message_id=? AND status=\'PENDING\'',status,text,turn.assistantMessageId)!==1) throw new Error('AI assistant terminal CAS failed');
    if (terminal.kind==='COMPLETED') {
      for (const proposal of terminal.proposals) {
        this.run('INSERT INTO ai_proposal_ids VALUES(?)',proposal.proposalId);
        this.run('INSERT INTO ai_action_proposals VALUES(?,?,?,?,?,?)',proposal.proposalId,proposal.requestId,proposal.petId,proposal.conversationId,jsonText(proposal),proposal.expiresAt);
      }
      for (const candidate of terminal.memoryCandidates) this.insertCandidate(candidate);
    }
    this.touchConversation(turn.petId,turn.conversationId,terminal.completedAt);return true;
  }
  recoverPendingTurns(at:number):number {
    const now=time.parse(at);let count=0;
    for (const value of this.all("SELECT * FROM ai_turns WHERE status='PENDING' ORDER BY request_id LIMIT 101")) {
      const turn=this.turnFromRow(value);if(this.finishTurn({...identity(turn),completedAt:Math.max(now,turn.startedAt),kind:'FAILED',error:{code:'INTERNAL_ERROR',message:'Interrupted generation was not resumed.',retryable:true}}))count++;
    }
    return count;
  }
  listActionProposals(petId:string,now:number,limit=50):ActionProposal[] {
    const [take]=page(limit);return this.all('SELECT * FROM ai_action_proposals WHERE pet_id=? AND expires_at>? ORDER BY expires_at,proposal_id LIMIT ?',idSchema.parse(petId),time.parse(now),take)
      .map(value=>{const proposal=actionProposalSchema.parse(parseJson(value.proposal_json));
        if(proposal.proposalId!==value.proposal_id || proposal.petId!==value.pet_id || proposal.requestId!==value.request_id || proposal.conversationId!==value.conversation_id || proposal.expiresAt!==int(value.expires_at))throw new Error('Proposal projection mismatch');return proposal;});
  }
  deleteActionProposal(petId:string,proposalId:string):boolean {return this.run('DELETE FROM ai_action_proposals WHERE pet_id=? AND proposal_id=?',idSchema.parse(petId),idSchema.parse(proposalId))===1;}

  private validatedMemorySource(ownerPetId:string,conversationId:string,messageId:string,at:number):Row {
    const value=this.messageRow(messageId),message=value?this.messageFromRow(value):null;
    if(!value||!message||message.petId!==ownerPetId||message.conversationId!==conversationId||message.role!=='USER'||message.status!=='COMPLETED'
      || message.createdAt>at || !screenMemoryText(message.text,aiLimits.userText).ok)throw new Error('Invalid or sensitive memory source');return value;
  }
  private validateCandidateForTurn(turn:AiTurnRecord,candidate:PendingMemoryCandidate,at:number):void {
    if(candidate.ownerPetId!==turn.petId||candidate.conversationId!==turn.conversationId||candidate.requestId!==turn.requestId||candidate.createdAt!==at||!screenMemoryText(candidate.summary).ok)throw new Error('Invalid memory candidate identity or content');
    for(const messageId of candidate.sourceMessageIds){const source=this.validatedMemorySource(turn.petId,turn.conversationId,messageId,at);
      const frozen=this.get('SELECT source_revision FROM ai_turn_sources WHERE request_id=? AND message_id=?',turn.requestId,messageId);
      if(!frozen||int(frozen.source_revision)!==int(source.content_revision))throw new Error('Memory candidate source excluded or changed');}
  }
  private insertCandidate(candidate:PendingMemoryCandidate):void {
    this.run('INSERT INTO ai_candidate_ids VALUES(?)',candidate.candidateId);
    this.run('INSERT INTO ai_memory_candidates VALUES(?,?,?,?,?,?,?,?,?,?)',candidate.candidateId,candidate.ownerPetId,candidate.conversationId,candidate.requestId,candidate.scope,candidate.type,candidate.summary,candidate.confidence,candidate.createdAt,candidate.expiresAt);
    for(const messageId of candidate.sourceMessageIds){const source=this.validatedMemorySource(candidate.ownerPetId,candidate.conversationId,messageId,candidate.createdAt);
      this.run('INSERT INTO ai_candidate_sources VALUES(?,?,?)',candidate.candidateId,messageId,int(source.content_revision));}
  }
  private candidateFromRow(value:Row):PendingMemoryCandidate {
    const candidateId=idSchema.parse(value.candidate_id),ownerPetId=idSchema.parse(value.owner_pet_id),conversationId=idSchema.parse(value.conversation_id),createdAt=int(value.created_at);
    const sourceMessageIds=this.all('SELECT * FROM ai_candidate_sources WHERE candidate_id=? ORDER BY message_id',candidateId).map(link=>{
      const messageId=idSchema.parse(link.message_id),source=this.validatedMemorySource(ownerPetId,conversationId,messageId,createdAt);
      if(int(link.source_revision)!==int(source.content_revision))throw new Error('Memory candidate source revision mismatch');return messageId;});
    return pendingMemoryCandidateSchema.parse({candidateId,ownerPetId,conversationId,createdAt,requestId:value.request_id,scope:value.scope,type:value.type,summary:value.summary,
      confidence:value.confidence,sourceMessageIds,consentState:'PENDING',expiresAt:int(value.expires_at)});
  }
  getPendingCandidate(ownerPetId:string,candidateId:string):PendingMemoryCandidate|null {const value=this.get('SELECT * FROM ai_memory_candidates WHERE owner_pet_id=? AND candidate_id=?',idSchema.parse(ownerPetId),idSchema.parse(candidateId));return value?this.candidateFromRow(value):null;}
  listPendingCandidates(ownerPetId:string,now:number,limit=50,offset=0):PendingMemoryCandidate[] {const [take,skip]=page(limit,offset);return this.all('SELECT * FROM ai_memory_candidates WHERE owner_pet_id=? AND expires_at>? ORDER BY created_at DESC,candidate_id LIMIT ? OFFSET ?',idSchema.parse(ownerPetId),time.parse(now),take,skip).map(value=>this.candidateFromRow(value));}
  rejectCandidate(ownerPetId:string,candidateId:string):boolean {return this.run('DELETE FROM ai_memory_candidates WHERE owner_pet_id=? AND candidate_id=?',idSchema.parse(ownerPetId),idSchema.parse(candidateId))===1;}

  private existingPetIds():string[]{const pets=this.all('SELECT pet_id FROM pets ORDER BY pet_id LIMIT 101').map(value=>idSchema.parse(value.pet_id));if(pets.length>100)throw new Error('AI pet scope exceeds bound');return pets;}
  confirmMemory(ownerPetId:string,candidateId:string,memoryId:string,now:number,decision:TrustedMemoryConfirmation):AiConfirmMemoryResult {
    const at=time.parse(now),candidate=this.getPendingCandidate(ownerPetId,candidateId);if(!candidate)return {ok:false,reason:'NOT_FOUND'};
    const result=confirmMemoryCandidate({candidate,ownerPetId,candidateId,memoryId,now:at,existingPetIds:this.existingPetIds(),lookupSource:id=>this.lookupMessage(id),decision});
    if(!result.ok)return result;this.insertMemory(result.record);
    if(!this.rejectCandidate(ownerPetId,candidateId))throw new Error('Pending candidate confirmation CAS failed');return result;
  }
  private insertMemory(record:MemoryRecord):void {
    const value=memoryRecordSchema.parse(record);if(!screenMemoryText(value.summary).ok)throw new Error('Invalid memory summary');
    this.run('INSERT INTO ai_memory_ids VALUES(?)',value.memoryId);
    this.run(`INSERT INTO ai_memories(memory_id,owner_pet_id,source_conversation_id,scope,type,summary,confidence,created_at,updated_at,expires_at,pinned)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,value.memoryId,value.ownerPetId,value.sourceConversationId,value.scope,value.type,value.summary,value.confidence,value.createdAt,value.updatedAt,value.expiresAt,Number(value.pinned));
    for(const messageId of value.sourceMessageIds){const source=this.validatedMemorySource(value.ownerPetId,value.sourceConversationId,messageId,value.createdAt);
      this.run('INSERT INTO ai_memory_sources VALUES(?,?,?)',value.memoryId,messageId,int(source.content_revision));}
    if(value.scope==='SHARED')for(const petId of value.recipientPetIds)this.run('INSERT INTO ai_memory_grants VALUES(?,?,?)',value.memoryId,petId,value.updatedAt);
  }
  private memoryFromRow(value:Row):MemoryRecord {
    const memoryId=idSchema.parse(value.memory_id),ownerPetId=idSchema.parse(value.owner_pet_id),sourceConversationId=idSchema.parse(value.source_conversation_id),createdAt=int(value.created_at);
    const sourceMessageIds=this.all('SELECT * FROM ai_memory_sources WHERE memory_id=? ORDER BY message_id',memoryId).map(link=>{
      const messageId=idSchema.parse(link.message_id),source=this.validatedMemorySource(ownerPetId,sourceConversationId,messageId,createdAt);
      if(int(link.source_revision)!==int(source.content_revision))throw new Error('Memory source revision mismatch');return messageId;});
    const recipients=this.all('SELECT recipient_pet_id FROM ai_memory_grants WHERE memory_id=? ORDER BY recipient_pet_id',memoryId).map(grant=>idSchema.parse(grant.recipient_pet_id));
    if(value.scope==='PRIVATE'&&recipients.length>0)throw new Error('Private memory has grants');
    return memoryRecordSchema.parse({memoryId,ownerPetId,sourceConversationId,scope:value.scope,type:value.type,summary:value.summary,confidence:value.confidence,sourceMessageIds,
      createdAt,updatedAt:int(value.updated_at),expiresAt:nullableInt(value.expires_at),pinned:bool(value.pinned),consentState:'CONFIRMED',...(value.scope==='SHARED'?{recipientPetIds:recipients}:{})});
  }
  getMemoryRecord(ownerPetId:string,memoryId:string):MemoryRecord|null {const value=this.get('SELECT * FROM ai_memories WHERE owner_pet_id=? AND memory_id=?',idSchema.parse(ownerPetId),idSchema.parse(memoryId));return value?this.memoryFromRow(value):null;}
  listMemoryRecords(ownerPetId:string,limit=50,offset=0):MemoryRecord[] {const [take,skip]=page(limit,offset);return this.all('SELECT * FROM ai_memories WHERE owner_pet_id=? ORDER BY updated_at DESC,memory_id LIMIT ? OFFSET ?',idSchema.parse(ownerPetId),take,skip).map(value=>this.memoryFromRow(value));}
  editMemory(ownerPetId:string,memoryId:string,decision:AiMemoryEdit,at:number):MemoryRecord|null {
    const current=this.getMemoryRecord(ownerPetId,memoryId);if(!current)return null;const edit=parseMemoryEdit(decision),now=time.parse(at);
    if(now<current.updatedAt||edit.expiresAt!==null&&edit.expiresAt<=now||!screenMemoryText(edit.summary).ok)throw new Error('Invalid trusted memory edit');
    if(edit.scope==='SHARED'){const pets=new Set(this.existingPetIds());if(edit.recipientPetIds.includes(ownerPetId)||new Set(edit.recipientPetIds).size!==edit.recipientPetIds.length||edit.recipientPetIds.some(id=>!pets.has(id)))throw new Error('Invalid explicit shared recipients');}
    const base={memoryId:current.memoryId,ownerPetId:current.ownerPetId,sourceConversationId:current.sourceConversationId,type:current.type,summary:edit.summary,
      confidence:current.confidence,sourceMessageIds:current.sourceMessageIds,createdAt:current.createdAt,updatedAt:now,expiresAt:edit.expiresAt,pinned:edit.pinned,consentState:'CONFIRMED',scope:edit.scope};
    const next=memoryRecordSchema.parse({...base,...(edit.scope==='SHARED'?{recipientPetIds:edit.recipientPetIds}:{})});
    this.run('DELETE FROM ai_memory_grants WHERE memory_id=?',memoryId);
    this.run('UPDATE ai_memories SET scope=?,summary=?,expires_at=?,pinned=?,updated_at=?,revision=revision+1 WHERE owner_pet_id=? AND memory_id=?',next.scope,next.summary,next.expiresAt,Number(next.pinned),now,ownerPetId,memoryId);
    if(next.scope==='SHARED')for(const recipient of next.recipientPetIds)this.run('INSERT INTO ai_memory_grants VALUES(?,?,?)',memoryId,recipient,now);
    return next;
  }
  revokeMemoryGrant(ownerPetId:string,memoryId:string,recipientPetId:string,at:number):boolean {
    const current=this.getMemoryRecord(ownerPetId,memoryId);if(!current||current.scope!=='SHARED'||!current.recipientPetIds.includes(idSchema.parse(recipientPetId)))return false;
    const recipients=current.recipientPetIds.filter(pet=>pet!==recipientPetId),now=time.parse(at);
    if(now<current.updatedAt)throw new Error('Memory revocation time regressed');
    this.run('DELETE FROM ai_memory_grants WHERE memory_id=? AND recipient_pet_id=?',memoryId,recipientPetId);
    this.run('UPDATE ai_memories SET scope=?,revision=revision+1,updated_at=? WHERE owner_pet_id=? AND memory_id=?',recipients.length===0?'PRIVATE':'SHARED',now,ownerPetId,memoryId);return true;
  }
  deleteMemory(ownerPetId:string,memoryId:string):boolean{return this.run('DELETE FROM ai_memories WHERE owner_pet_id=? AND memory_id=?',idSchema.parse(ownerPetId),idSchema.parse(memoryId))===1;}
  clearMemories(ownerPetId:string):number{const pet=idSchema.parse(ownerPetId);return this.run('DELETE FROM ai_memories WHERE owner_pet_id=?',pet)+this.run('DELETE FROM ai_memory_candidates WHERE owner_pet_id=?',pet);}
  private memoryMetaAuthorized(value:Row,recipientPetId:string,now:number):boolean {
    const ownerPetId=idSchema.parse(value.owner_pet_id),expiresAt=nullableInt(value.expires_at);
    if(int(value.updated_at)>now||expiresAt!==null&&expiresAt<=now)return false;
    return ownerPetId===recipientPetId || value.scope==='SHARED'&&this.get('SELECT 1 FROM ai_memory_grants WHERE memory_id=? AND recipient_pet_id=?',idSchema.parse(value.memory_id),recipientPetId)!==null;
  }
  retrieveMemories(recipientPetId:string,query:string,now:number,limit:number=aiLimits.authorizedMemories):AuthorizedMemoryContext[]{
    const pet=idSchema.parse(recipientPetId),at=time.parse(now);if(typeof query!=='string'||query.length>aiLimits.userText||!Number.isSafeInteger(limit)||limit<0||limit>aiLimits.authorizedMemories)throw new RangeError('Invalid bounded memory query');
    if(limit===0)return [];const pets=this.existingPetIds();if(!pets.includes(pet))return [];
    // Authorization is in SQL, before touching any source/summary or doing
    // lexical ranking. FTS/embeddings are separate future work.
    const records=this.all(`SELECT m.* FROM ai_memories m WHERE (m.owner_pet_id=? OR (m.scope='SHARED' AND EXISTS(
      SELECT 1 FROM ai_memory_grants g WHERE g.memory_id=m.memory_id AND g.recipient_pet_id=?))) AND m.updated_at<=?
      AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.pinned DESC,m.updated_at DESC,m.memory_id LIMIT ?`,pet,pet,at,at,memoryPolicyLimits.recordsToConsider)
      .map(value=>this.memoryFromRow(value));
    return retrieveAuthorizedMemories({recipientPetId:pet,query,now:at,records,existingPetIds:pets,lookupSource:messageId=>this.lookupMessage(messageId),limit});
  }
}
