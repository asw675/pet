import { aiLimits, chatStreamEventSchema, providerConfigSchema } from '@pet-desktop/contracts/ai';
import type { AiErrorCode, ActionProposal, ChatMessage, Conversation, MemoryRecord, PendingMemoryCandidate, ProviderConfig } from '@pet-desktop/contracts/ai';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { aiIntentSchema, aiResultMatches, aiResultSchema } from '../../shared/ai-ipc';
import type { AiIntent, AiResult, ChatIdentity, ProviderAssignmentView, ProviderRecordView } from '../../shared/ai-ipc';

export type AiMethod = AiIntent['method'];
export type AiSuccess<M extends AiMethod> = Extract<AiResult, { ok: true; method: M }>;
export type AiData<M extends AiMethod> = AiSuccess<M>['data'];
/** Read-page shape derived from validated IPC and named explicitly for Vue's
 * generic ref unwrapping (which cannot preserve the conditional union). */
export interface AiQueryData {
  'settings/list': { providers: ProviderRecordView[]; assignments: ProviderAssignmentView[] };
  'conversations/list': { petId: string; offset: number; limit: number; rows: Conversation[] };
  'messages/list': { petId: string; conversationId: string; offset: number; limit: number; rows: ChatMessage[] };
  'memory/list': { petId: string; offset: number; limit: number; candidateOffset: number; memories: MemoryRecord[]; candidates: PendingMemoryCandidate[] };
  'proposals/list': { petId: string; rows: ActionProposal[] };
}
export const AI_PAGE_MAX_OFFSET = 10_000;
export const aiErrorText: Record<AiErrorCode, string> = {
  AUTH_REQUIRED: '请先为伙伴配置并授权 AI 服务。', RATE_LIMITED: 'AI 服务暂时繁忙。', CONTEXT_LIMIT: '上下文超过模型限制。',
  TIMEOUT: '请求超时，结果尚未确认。', NETWORK: 'AI 服务连接失败。', UNAVAILABLE: '当前服务不可用。',
  UNSUPPORTED: '当前操作不受支持。', INVALID_RESPONSE: '服务返回内容不符合契约。', REFUSED: '模型未完成回复。',
  TRUNCATED: '回复超出长度限制。', INTERNAL_ERROR: '本地 AI 服务处理失败。',
};
export function aiIntentKey(intent: AiIntent | undefined): string { return intent ? JSON.stringify(intent) : ''; }
export function sameChatIdentity(a: ChatIdentity, b: ChatIdentity): boolean {
  return a.petId === b.petId && a.conversationId === b.conversationId && a.requestId === b.requestId;
}
/** Correlation by transport requestId is performed by preload, which owns
 * that ID. Here additionally check method, visible query scope and bounds. */
export function validateAiResponse(intent: AiIntent, raw: unknown): AiResult | null {
  const parsed = aiResultSchema.safeParse(raw);
  if (!parsed.success || !aiResultMatches({ requestId: parsed.data.requestId, intent }, parsed.data)) return null;
  const result = parsed.data;
  if (!result.ok) return result;
  switch (result.method) {
    case 'settings/list':
      if (intent.method !== 'settings/list' || result.data.providers.length > intent.payload.limit) return null;
      break;
    case 'messages/list': case 'conversations/list':
      if (result.data.rows.length > result.data.limit) return null;
      break;
    case 'memory/list':
      if (result.data.memories.length > result.data.limit || result.data.candidates.length > result.data.limit
        || new Set(result.data.memories.map(memory => memory.memoryId)).size !== result.data.memories.length
        || new Set(result.data.candidates.map(candidate => candidate.candidateId)).size !== result.data.candidates.length) return null;
      break;
    case 'memory/confirm': case 'memory/edit':
      if ((intent.method !== 'memory/confirm' && intent.method !== 'memory/edit') || result.data.ownerPetId !== intent.payload.petId
        || (intent.method === 'memory/edit' && result.data.memoryId !== intent.payload.memoryId)) return null;
      break;
    case 'proposals/list':
      if (new Set(result.data.rows.map(proposal => proposal.proposalId)).size !== result.data.rows.length) return null;
      break;
  }
  return result;
}
export function aiNextOffset(offset: number, limit: number, rows: number, direction: -1 | 1): number | undefined {
  const next = offset + limit * direction;
  return Number.isSafeInteger(next) && next >= 0 && next <= AI_PAGE_MAX_OFFSET
    && (direction === -1 || rows === limit) ? next : undefined;
}

export interface ChatOverlay {
  readonly generation: number;
  readonly scopeEpoch: number;
  readonly identity: ChatIdentity;
  readonly nextSequence: number;
  readonly text: string;
  readonly degraded: boolean;
  readonly terminal: 'final' | 'error' | 'cancelled' | null;
  readonly error: AiErrorCode | null;
}
export function newChatOverlay(identity: ChatIdentity, generation: number, scopeEpoch: number): ChatOverlay {
  return { identity: { ...identity }, generation, scopeEpoch, nextSequence: 0, text: '', degraded: false, terminal: null, error: null };
}
/** Deltas are temporary presentation only. Missing/out-of-order data stops
 * delta presentation; a valid newer terminal can still signal authoritative
 * history reload. No draft reply effects/memory are accepted into the UI. */
export function reduceChatOverlay(active: ChatOverlay, raw: unknown, generation: number | null, scopeEpoch: number): ChatOverlay {
  if (active.terminal || active.generation !== generation || active.scopeEpoch !== scopeEpoch) return active;
  const parsed = chatStreamEventSchema.safeParse(raw);
  if (!parsed.success || !sameChatIdentity(active.identity, parsed.data) || parsed.data.sequence < active.nextSequence) return active;
  const event = parsed.data;
  const degraded = active.degraded || event.sequence !== active.nextSequence || event.sequence === Number.MAX_SAFE_INTEGER;
  const nextSequence = Math.min(Number.MAX_SAFE_INTEGER, event.sequence + 1);
  if (event.kind === 'textDelta') {
    if (degraded || active.text.length + event.delta.length > aiLimits.replyText)
      return { ...active, degraded: true, text: '', nextSequence };
    return { ...active, nextSequence, text: active.text + event.delta };
  }
  return { ...active, nextSequence, degraded, text: '', terminal: event.kind, error: event.kind === 'error' ? event.error.code : null };
}

export const privacyLabel = { MOCK: '本地模拟（不联网）', LOCAL: '本机回环地址', CLOUD: '远程 HTTPS' } as const;
export interface ProviderDraft {
  providerId: string; profile: 'MOCK' | 'LOCAL' | 'CLOUD'; baseUrl: string; modelId: string;
  useCredential: boolean; jsonMode: boolean; streamText: boolean; maxContextTokens: number; maxOutputTokens: number; timeoutMs: number;
}
export function draftProviderConfig(draft: ProviderDraft, existing: ProviderRecordView | null, makeRef: () => string): ProviderConfig | undefined {
  // Never reuse a credential ref at a changed endpoint. Adding credentials
  // or saving config alone still cannot grant remote context consent.
  const mock = draft.profile === 'MOCK';
  const credential = !mock && (draft.profile === 'CLOUD' || draft.useCredential);
  let credentialRef: string | null = null;
  if (credential) {
    const previous = existing?.config;
    if (previous?.providerId === draft.providerId && previous.baseUrl === draft.baseUrl.trim()
      && previous.privacyBoundary === draft.profile && previous.credentialRef) credentialRef = previous.credentialRef;
    else { try { credentialRef = makeRef(); } catch { return undefined; } }
  }
  const parsed = providerConfigSchema.safeParse({
    providerId: draft.providerId.trim(), privacyBoundary: draft.profile, endpointKind: mock ? 'MOCK' : 'OPENAI_COMPATIBLE',
    baseUrl: mock ? null : draft.baseUrl.trim(), modelId: draft.modelId.trim(), credentialRef,
    capabilities: { streamText: draft.streamText, nativeStructured: mock, jsonMode: !mock && draft.jsonMode, usage: false, embeddings: false },
    maxContextTokens: draft.maxContextTokens, maxOutputTokens: draft.maxOutputTokens, timeoutMs: draft.timeoutMs,
  });
  return parsed.success ? parsed.data : undefined;
}
export function providerAssignmentIntent(petId: string, provider: ProviderRecordView, explicitlyAllowCloud: boolean): AiIntent | undefined {
  const cloud = provider.config.privacyBoundary === 'CLOUD';
  if (cloud !== explicitlyAllowCloud) return undefined;
  const parsed = aiIntentSchema.safeParse({ method: 'provider/assign', payload: { petId, providerId: provider.config.providerId,
    providerRevision: provider.revision, allowCloudContext: cloud } });
  return parsed.success ? parsed.data : undefined;
}
export function validRecipientIds(ownerPetId: string, ids: readonly string[], snapshot: AppSnapshot | null): boolean {
  return snapshot !== null && Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length
    && ids.every(id => id !== ownerPetId && snapshot.pets.some(pet => pet.petId === id));
}
export interface MemoryDraft { summary: string; scope: 'PRIVATE' | 'SHARED'; recipients: string[]; pinned: boolean; expiresAt: number | null }
export function memoryDecisionIntent(row: PendingMemoryCandidate | MemoryRecord, draft: MemoryDraft,
  snapshot: AppSnapshot | null, owner: string, now: number): AiIntent | undefined {
  if (!Number.isSafeInteger(now) || now < 0 || row.ownerPetId !== owner || !snapshot?.pets.some(pet => pet.petId === owner)
    || (row.consentState === 'PENDING' && now >= row.expiresAt)
    || (draft.scope === 'SHARED' && !validRecipientIds(owner, draft.recipients, snapshot))
    || (draft.scope === 'PRIVATE' && draft.recipients.length !== 0)
    || (draft.expiresAt !== null && draft.expiresAt <= now)) return undefined;
  const shared = draft.scope === 'SHARED' ? { recipientPetIds: [...draft.recipients].sort() } : {};
  const intent = row.consentState === 'PENDING'
    ? { method: 'memory/confirm', payload: { petId: owner, candidateId: row.candidateId,
      decision: { kind: 'CONFIRM', scope: draft.scope, editedSummary: draft.summary.trim(), pinned: draft.pinned, expiresAt: draft.expiresAt, ...shared } } }
    : { method: 'memory/edit', payload: { petId: owner, memoryId: row.memoryId,
      decision: { kind: 'EDIT', scope: draft.scope, summary: draft.summary.trim(), pinned: draft.pinned, expiresAt: draft.expiresAt, ...shared } } };
  const parsed = aiIntentSchema.safeParse(intent);
  return parsed.success ? parsed.data : undefined;
}
/** Rest is the only direct game gesture here. Trip UI performs its own
 * preparation; quick actions cannot be executed from model output. */
export function canConfirmRest(proposal: ActionProposal, petId: string, snapshot: AppSnapshot | null, at: number): boolean {
  const pet = snapshot?.pets.find(candidate => candidate.petId === petId);
  return proposal.petId === petId && proposal.type === 'REST' && proposal.targetId === 'self' && proposal.confirmationRequired
    && Number.isSafeInteger(at) && at >= 0 && at < proposal.expiresAt
    && pet?.presence === 'HOME' && pet.activity !== 'DRAG' && pet.activity !== 'CHAT';
}
