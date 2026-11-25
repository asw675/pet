import { z } from 'zod';

/** Declarative AI contracts. None of these schemas grants tools, system
 * permissions, memory writes or authoritative gameplay effects. */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const deadline = integer.min(1);
const score = z.number().min(0).max(100);
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Text cannot be blank');
const shortText = boundedText(128);
const replyText = boundedText(8_000);
const sourceMessageIds = z.array(id).min(1).max(16).refine(values => new Set(values).size === values.length, 'Duplicate source message ID');
const semanticMotionId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);

export const aiLimits = Object.freeze({
  contextTokens: 1_000_000, outputTokens: 32_768, timeoutMs: 300_000,
  userText: 4_000, replyText: 8_000, historyMessages: 24, authorizedMemories: 16,
  recentEvents: 12, deltaText: 2_000, proposals: 3, memoryCandidates: 5,
});

// Provider base URLs belong exclusively to trusted settings. A strict subset
// of canonical HTTP(S) syntax makes it impossible to infer an endpoint from a
// userinfo, query, fragment, escaped/dot path, or alternative loopback spelling.
type EndpointClass = 'LOOPBACK' | 'HTTPS_REMOTE';
function endpointClass(value: string): EndpointClass | null {
  const match = /^(https?):\/\/(\[::1\]|[A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?(\/[^?#]*)?$/u.exec(value);
  if (!match) return null;
  const [, protocol, rawHost, port, path] = match;
  if (rawHost === undefined || (port !== undefined && Number(port) > 65535)) return null;
  const host = rawHost.toLowerCase();
  const literalLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!literalLoopback) {
    if (host.length > 253 || host.endsWith('.localhost')) return null;
    const labels = host.split('.');
    if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
    if (/^[0-9.]+$/u.test(host)) {
      if (labels.length !== 4 || labels.some(label => !/^(0|[1-9][0-9]{0,2})$/u.test(label) || Number(label) > 255)) return null;
      // Other loopback/unspecified spellings are not the supported local form.
      if (labels[0] === '127' || labels[0] === '0') return null;
    } else if (/^[0-9]/u.test(labels.at(-1) ?? '')) return null;
    if (protocol !== 'https') return null;
  }
  if (path !== undefined) {
    if (path.length > 256) return null;
    const segments = path.split('/').slice(1);
    if (segments.at(-1) === '') segments.pop();
    if (segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(segment) || segment.includes('..'))) return null;
  }
  return literalLoopback ? 'LOOPBACK' : 'HTTPS_REMOTE';
}

export const providerBaseUrlSchema = z.string().min(1).max(512)
  .refine(value => endpointClass(value) !== null, 'Provider endpoint must be a canonical HTTPS or explicit loopback HTTP(S) base URL');
// The reference is an opaque broker identity, not an API key. Resolution and
// credential ownership remain the broker's responsibility.
export const credentialRefSchema = z.string().regex(/^credential:[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u);
// Namespace/model:tag is accepted; a model ID is data, never a URL path.
export const modelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
  .refine(value => !value.includes('..') && !value.includes('//') && !value.includes(':/') && !value.endsWith('/')
    && !/^(?:https?|file|data|javascript|ftp):/iu.test(value), 'Model ID must not be a URL or relative path');

export const endpointKindSchema = z.enum(['OPENAI_RESPONSES', 'OPENAI_COMPATIBLE', 'ANTHROPIC', 'OLLAMA', 'MOCK']);
export type EndpointKind = z.infer<typeof endpointKindSchema>;
export const privacyBoundarySchema = z.enum(['CLOUD', 'LOCAL', 'MOCK']);
export type PrivacyBoundary = z.infer<typeof privacyBoundarySchema>;
export const providerCapabilitiesSchema = z.strictObject({
  streamText: z.boolean(), nativeStructured: z.boolean(), jsonMode: z.boolean(), usage: z.boolean(), embeddings: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** Settings projection only. No apiKey, headers, custom tools, or request-time
 * address overrides. Runtime settings still need an explicit user operation. */
export const providerConfigSchema = z.strictObject({
  providerId: id,
  endpointKind: endpointKindSchema,
  privacyBoundary: privacyBoundarySchema,
  baseUrl: providerBaseUrlSchema.nullable(),
  modelId: modelIdSchema,
  credentialRef: credentialRefSchema.nullable(),
  capabilities: providerCapabilitiesSchema,
  maxContextTokens: integer.min(512).max(aiLimits.contextTokens),
  maxOutputTokens: integer.min(1).max(aiLimits.outputTokens),
  timeoutMs: integer.min(1_000).max(aiLimits.timeoutMs),
}).superRefine((config, ctx) => {
  if (config.maxOutputTokens >= config.maxContextTokens) {
    ctx.addIssue({ code: 'custom', path: ['maxOutputTokens'], message: 'Output budget must leave room for input context' });
  }
  if (config.endpointKind === 'MOCK') {
    if (config.privacyBoundary !== 'MOCK' || config.baseUrl !== null || config.credentialRef !== null) {
      ctx.addIssue({ code: 'custom', path: ['privacyBoundary'], message: 'Mock provider cannot have a network endpoint or credential' });
    }
    return;
  }
  const endpoint = config.baseUrl === null ? null : endpointClass(config.baseUrl);
  if (config.privacyBoundary === 'LOCAL' && endpoint === 'LOOPBACK') return;
  if (config.privacyBoundary === 'CLOUD' && endpoint === 'HTTPS_REMOTE' && config.credentialRef !== null) return;
  ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Provider endpoint and credential reference must match the declared privacy boundary' });
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

const identity = { requestId: id, petId: id, conversationId: id };
export const chatRoleSchema = z.enum(['USER', 'ASSISTANT']);
export const messageStatusSchema = z.enum(['COMPLETED', 'PENDING', 'CANCELLED', 'FAILED']);
export const conversationSchema = z.strictObject({
  petId: id, conversationId: id, title: shortText,
  createdAt: integer, updatedAt: integer,
}).refine(value => value.updatedAt >= value.createdAt, 'Conversation update precedes creation');
export type Conversation = z.infer<typeof conversationSchema>;

const contextMessageFields = {
  petId: id, conversationId: id, messageId: id, role: chatRoleSchema, createdAt: integer,
};
export const chatMessageSchema = z.strictObject({
  ...contextMessageFields, requestId: id, text: z.string().max(aiLimits.replyText), status: messageStatusSchema,
}).superRefine((message, ctx) => {
  if (message.role === 'USER' && (message.status !== 'COMPLETED' || message.text.length > aiLimits.userText)) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'Stored user input must be a bounded completed message' });
  }
  if (message.status === 'COMPLETED' && message.text.trim().length === 0) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'Completed message cannot be blank' });
  }
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Only already completed, same-conversation messages qualify as context. */
export const chatContextMessageSchema = z.strictObject({ ...contextMessageFields, text: replyText })
  .refine(message => message.role !== 'USER' || message.text.length <= aiLimits.userText, 'History user input exceeds its limit');
export type ChatContextMessage = z.infer<typeof chatContextMessageSchema>;

export const memoryScopeSchema = z.enum(['PRIVATE', 'SHARED']);
export const memoryTypeSchema = z.enum(['PREFERENCE', 'HISTORY', 'AGREEMENT']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
const memoryDraftFields = {
  scope: memoryScopeSchema, type: memoryTypeSchema, summary: boundedText(512),
  sourceMessageIds, confidence: z.number().min(0).max(1),
};
/** The model may propose a shared/individual fact, but cannot bind ownership,
 * authorization, permanence, timestamps or recipients. Semantic filtering
 * of sensitive facts is a subsequent trusted memory-service responsibility. */
export const memoryCandidateDraftSchema = z.strictObject(memoryDraftFields);
export type MemoryCandidateDraft = z.infer<typeof memoryCandidateDraftSchema>;

export const pendingMemoryCandidateSchema = z.strictObject({
  ...memoryDraftFields, candidateId: id, ownerPetId: id, conversationId: id, requestId: id,
  consentState: z.literal('PENDING'), createdAt: integer, expiresAt: deadline,
}).refine(candidate => candidate.expiresAt > candidate.createdAt, 'Candidate expiration must follow its creation');
export type PendingMemoryCandidate = z.infer<typeof pendingMemoryCandidateSchema>;

const memoryRecordFields = {
  memoryId: id, ownerPetId: id, type: memoryTypeSchema, summary: boundedText(512),
  sourceConversationId: id, sourceMessageIds, confidence: z.number().min(0).max(1),
  consentState: z.literal('CONFIRMED'), createdAt: integer, updatedAt: integer, expiresAt: deadline.nullable(), pinned: z.boolean(),
};
/** Editable management projection, not an API allowing the model to confirm
 * or grant a memory. A shared record names explicit recipient pet IDs. */
export const memoryRecordSchema = z.discriminatedUnion('scope', [
  z.strictObject({ ...memoryRecordFields, scope: z.literal('PRIVATE') }),
  z.strictObject({ ...memoryRecordFields, scope: z.literal('SHARED'),
    recipientPetIds: z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length, 'Duplicate memory recipient') }),
]).superRefine((record, ctx) => {
  if (record.updatedAt < record.createdAt || (record.expiresAt !== null && record.expiresAt <= record.createdAt)) {
    ctx.addIssue({ code: 'custom', path: ['createdAt'], message: 'Memory timestamps are inconsistent' });
  }
  if (record.scope === 'SHARED' && record.recipientPetIds.includes(record.ownerPetId)) {
    ctx.addIssue({ code: 'custom', path: ['recipientPetIds'], message: 'Owner already has access to the memory' });
  }
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

/** Retrieval DTO already filtered by authorization in repository; this
 * deliberately contains no other pet's raw messages or source conversation. */
export const authorizedMemoryContextSchema = z.strictObject({
  memoryId: id, ownerPetId: id, recipientPetId: id, scope: memoryScopeSchema,
  type: memoryTypeSchema, summary: boundedText(512), consentState: z.literal('CONFIRMED'),
}).refine(value => value.scope !== 'PRIVATE' || value.ownerPetId === value.recipientPetId, 'Private memory is owner-only');
export type AuthorizedMemoryContext = z.infer<typeof authorizedMemoryContextSchema>;

export const personaContextSchema = z.strictObject({
  personaId: id, characterId: id, revision: integer, displayName: shortText, background: boundedText(2_048),
  personality: z.strictObject({ summary: boundedText(1_024), traits: z.array(shortText).max(16),
    likes: z.array(shortText).max(16), speechStyle: boundedText(1_024) }),
  languageTag: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u),
  allowedMotionIds: z.array(semanticMotionId).min(1).max(64)
    .refine(values => new Set(values).size === values.length, 'Duplicate motion ID'),
});
export type PersonaContext = z.infer<typeof personaContextSchema>;

/** Restricted one-pet read model. No wallet, inventory, OS information,
 * resource paths or unrelated pet state are needed to express personality. */
export const aiGameContextSchema = z.strictObject({
  petId: id, characterId: id, nickname: boundedText(80), petRevision: integer,
  presence: z.enum(['HOME', 'AWAY', 'RETURNING']),
  activity: z.enum(['IDLE', 'WALK', 'DRAG', 'INTERACT', 'CHAT', 'EAT', 'REST', 'SLEEP', 'CELEBRATE']).nullable(),
  mood: z.enum(['CALM', 'HAPPY', 'EXCITED', 'BORED', 'UPSET', 'TIRED']),
  healthStatus: z.enum(['NORMAL', 'INJURED', 'RECOVERING']),
  moodScore: score, healthPoints: score, energy: score, bond: score, level: integer.min(1), xp: integer,
  trip: z.strictObject({ tripId: id, routeId: id, status: z.enum(['TRAVELING', 'SETTLED']), expectedReturnAt: integer }).nullable(),
  recentEvents: z.array(z.strictObject({ eventId: id, petId: id, type: id, occurredAt: integer, summary: boundedText(512) })).max(aiLimits.recentEvents),
}).superRefine((game, ctx) => {
  if ((game.presence === 'HOME') !== (game.activity !== null)
    || (game.presence === 'HOME' ? game.trip?.status === 'TRAVELING' : game.trip?.status !== 'TRAVELING')) {
    ctx.addIssue({ code: 'custom', path: ['presence'], message: 'Pet presence contradicts activity or travel' });
  }
  if (game.recentEvents.some(event => event.petId !== game.petId)
    || new Set(game.recentEvents.map(event => event.eventId)).size !== game.recentEvents.length) {
    ctx.addIssue({ code: 'custom', path: ['recentEvents'], message: 'Events must be unique and belong to the current pet' });
  }
});
export type AiGameContext = z.infer<typeof aiGameContextSchema>;

export const historySummarySchema = z.strictObject({
  petId: id, conversationId: id, version: integer.min(1),
  sourceMessageIds: z.array(id).min(1).max(64).refine(values => new Set(values).size === values.length, 'Duplicate summary source'),
  text: boundedText(2_048),
});
export type HistorySummary = z.infer<typeof historySummarySchema>;

export const turnContextSchema = z.strictObject({
  persona: personaContextSchema,
  game: aiGameContextSchema,
  recentMessages: z.array(chatContextMessageSchema).max(aiLimits.historyMessages),
  authorizedMemories: z.array(authorizedMemoryContextSchema).max(aiLimits.authorizedMemories),
  historySummary: historySummarySchema.nullable(),
});
export type TurnContext = z.infer<typeof turnContextSchema>;
export const turnTriggerSchema = z.enum(['USER', 'PROACTIVE', 'MEMORY_EXTRACTION', 'SUMMARY']);
export type TurnTrigger = z.infer<typeof turnTriggerSchema>;

/** Trusted, assembled turn for one immutable pet/conversation identity. The
 * renderer must not supply this context, persona, revision or endpoint. */
export const turnRequestSchema = z.strictObject({
  ...identity, trigger: turnTriggerSchema, personaRevision: integer, snapshotRevision: integer, deadline,
  userText: boundedText(aiLimits.userText).nullable(), userMessageId: id.nullable(), context: turnContextSchema,
}).superRefine((turn, ctx) => {
  const { context } = turn;
  if (turn.trigger === 'USER' ? turn.userText === null || turn.userMessageId === null
    : turn.userText !== null || turn.userMessageId !== null) {
    ctx.addIssue({ code: 'custom', path: ['userText'], message: 'Only a user turn carries a current user message' });
  }
  if (context.game.petId !== turn.petId || context.persona.characterId !== context.game.characterId
    || context.persona.revision !== turn.personaRevision) {
    ctx.addIssue({ code: 'custom', path: ['context'], message: 'Persona, game projection and turn identities differ' });
  }
  const messageIds = new Set<string>();
  let previousTime = 0;
  for (const message of context.recentMessages) {
    if (message.petId !== turn.petId || message.conversationId !== turn.conversationId
      || message.messageId === turn.userMessageId || messageIds.has(message.messageId) || message.createdAt < previousTime) {
      ctx.addIssue({ code: 'custom', path: ['context', 'recentMessages'], message: 'History must be ordered, unique and from this conversation' });
      break;
    }
    messageIds.add(message.messageId);
    previousTime = message.createdAt;
  }
  const memoryIds = new Set<string>();
  for (const memory of context.authorizedMemories) {
    if (memory.recipientPetId !== turn.petId || memoryIds.has(memory.memoryId)) {
      ctx.addIssue({ code: 'custom', path: ['context', 'authorizedMemories'], message: 'Authorized memories must be unique and scoped to this recipient' });
      break;
    }
    memoryIds.add(memory.memoryId);
  }
  const summary = context.historySummary;
  if (summary !== null && (summary.petId !== turn.petId || summary.conversationId !== turn.conversationId
    || (turn.userMessageId !== null && summary.sourceMessageIds.includes(turn.userMessageId)))) {
    ctx.addIssue({ code: 'custom', path: ['context', 'historySummary'], message: 'History summary cannot belong to another conversation or the current message' });
  }
});
export type TurnRequest = z.infer<typeof turnRequestSchema>;

export const chatEmotionSchema = z.enum(['neutral', 'calm', 'happy', 'excited', 'sad', 'upset', 'tired', 'surprised', 'embarrassed']);
export type ChatEmotion = z.infer<typeof chatEmotionSchema>;
export const actionProposalTypeSchema = z.enum(['REST', 'TRIP_SUGGESTION', 'QUICK_ACTION_SUGGESTION']);
export type ActionProposalType = z.infer<typeof actionProposalTypeSchema>;
const proposalFields = {
  type: actionProposalTypeSchema,
  // An opaque whitelist lookup key, never an OS command, URI or path.
  targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).refine(value => !value.includes('..')),
  reason: boundedText(400),
};
export const actionProposalDraftSchema = z.strictObject(proposalFields);
export type ActionProposalDraft = z.infer<typeof actionProposalDraftSchema>;
/** Only trusted service code binds a proposal to its source and confirmation
 * requirements. This still represents a suggestion, not permission to execute. */
export const actionProposalSchema = z.strictObject({ ...proposalFields, ...identity,
  proposalId: id, expiresAt: deadline, confirmationRequired: z.literal(true) });
export type ActionProposal = z.infer<typeof actionProposalSchema>;

/** Entire model reply is schema-validated before presentation or proposal
 * handling. Free-form text is displayed as plain text, never executed. */
export const chatReplySchema = z.strictObject({
  text: replyText,
  emotion: chatEmotionSchema,
  motionIntent: semanticMotionId.nullable(),
  actionProposals: z.array(actionProposalDraftSchema).max(aiLimits.proposals),
  memoryCandidates: z.array(memoryCandidateDraftSchema).max(aiLimits.memoryCandidates),
});
export type ChatReply = z.infer<typeof chatReplySchema>;
export function chatReplyJsonSchema() { return z.toJSONSchema(chatReplySchema); }

export const aiUsageSchema = z.strictObject({
  inputTokens: integer.max(aiLimits.contextTokens), outputTokens: integer.max(aiLimits.outputTokens),
  totalTokens: integer.max(aiLimits.contextTokens + aiLimits.outputTokens),
}).refine(value => value.totalTokens === value.inputTokens + value.outputTokens, 'Usage token total is inconsistent');
export type AiUsage = z.infer<typeof aiUsageSchema>;
export const aiErrorCodeSchema = z.enum(['AUTH_REQUIRED', 'RATE_LIMITED', 'CONTEXT_LIMIT', 'TIMEOUT', 'NETWORK', 'UNAVAILABLE',
  'UNSUPPORTED', 'INVALID_RESPONSE', 'REFUSED', 'TRUNCATED', 'INTERNAL_ERROR']);
export type AiErrorCode = z.infer<typeof aiErrorCodeSchema>;
/** Adapter supplies a sanitized public error rather than a raw SDK exception. */
export const aiErrorSchema = z.strictObject({ code: aiErrorCodeSchema, message: boundedText(256), retryable: z.boolean() });
export type AiError = z.infer<typeof aiErrorSchema>;
export const aiCancelReasonSchema = z.enum(['USER', 'SUPERSEDED', 'PET_SWITCH', 'TIMEOUT', 'SERVICE_STOPPED']);
export type AiCancelReason = z.infer<typeof aiCancelReasonSchema>;

const streamFields = { ...identity, sequence: integer };
export const chatStreamEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...streamFields, kind: z.literal('textDelta'), delta: z.string().min(1).max(aiLimits.deltaText) }),
  z.strictObject({ ...streamFields, kind: z.literal('final'), reply: chatReplySchema, usage: aiUsageSchema.nullable() }),
  z.strictObject({ ...streamFields, kind: z.literal('error'), error: aiErrorSchema }),
  z.strictObject({ ...streamFields, kind: z.literal('cancelled'), reason: aiCancelReasonSchema }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

export const providerOutputModeSchema = z.enum(['STRUCTURED', 'JSON', 'TEXT']);
export type ProviderOutputMode = z.infer<typeof providerOutputModeSchema>;
/** Provider registry resolves the separately stored configuration. The turn
 * request never contains credentials, endpoint overrides, or tool functions. */
export const providerRequestSchema = z.strictObject({
  providerId: id, modelId: modelIdSchema, outputMode: providerOutputModeSchema,
  maxOutputTokens: integer.min(1).max(aiLimits.outputTokens), turn: turnRequestSchema,
});
export type ProviderRequest = z.infer<typeof providerRequestSchema>;
/** Adapter-normalized terminal results. A TEXT fallback has no proposals,
 * memory candidates or claimed execution outcome by construction. */
export const providerOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...identity, kind: z.literal('STRUCTURED'), reply: chatReplySchema, usage: aiUsageSchema.nullable() }),
  z.strictObject({ ...identity, kind: z.literal('TEXT'), text: replyText, usage: aiUsageSchema.nullable() }),
  z.strictObject({ ...identity, kind: z.literal('ERROR'), error: aiErrorSchema }),
  z.strictObject({ ...identity, kind: z.literal('CANCELLED'), reason: aiCancelReasonSchema }),
]);
export type ProviderOutput = z.infer<typeof providerOutputSchema>;
