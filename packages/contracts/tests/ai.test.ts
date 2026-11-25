import { describe, expect, it } from 'vitest';
import {
  actionProposalDraftSchema, actionProposalSchema, aiLimits, aiUsageSchema, authorizedMemoryContextSchema,
  chatMessageSchema, chatReplyJsonSchema, chatReplySchema, chatStreamEventSchema, conversationSchema,
  memoryCandidateDraftSchema, memoryRecordSchema, pendingMemoryCandidateSchema, providerBaseUrlSchema,
  providerConfigSchema, providerOutputSchema, providerRequestSchema, turnRequestSchema,
} from '../src/ai.js';
import type { ChatReply, ProviderConfig, TurnRequest } from '../src/ai.js';

const identity = { requestId: 'turn-1', petId: 'pet-1', conversationId: 'conv-1' };
const capabilities = { streamText: true, nativeStructured: true, jsonMode: false, usage: true, embeddings: false };
const mock: ProviderConfig = { providerId: 'provider-mock', endpointKind: 'MOCK', privacyBoundary: 'MOCK', baseUrl: null,
  modelId: 'demo-mock', credentialRef: null, capabilities, maxContextTokens: 8_000, maxOutputTokens: 400, timeoutMs: 30_000 };
const local: ProviderConfig = { ...mock, providerId: 'provider-local', endpointKind: 'OLLAMA', privacyBoundary: 'LOCAL',
  baseUrl: 'http://localhost:11434/api', modelId: 'llama3:latest' };
const cloud: ProviderConfig = { ...mock, providerId: 'provider-cloud', endpointKind: 'OPENAI_RESPONSES', privacyBoundary: 'CLOUD',
  baseUrl: 'https://api.example.com/v1', modelId: 'model-demo', credentialRef: 'credential:cloud-1' };

function turn(): TurnRequest {
  return {
    ...identity, trigger: 'USER', personaRevision: 1, snapshotRevision: 8, deadline: 100_000,
    userText: '我喜欢茶。', userMessageId: 'message-current',
    context: {
      persona: { personaId: 'star-persona', characterId: 'star-singer', revision: 1, displayName: '星咏',
        background: '探索星光的魔族少女。', personality: { summary: '好奇而温柔', traits: ['好奇'], likes: ['星星'], speechStyle: '温柔' },
        languageTag: 'zh-CN', allowedMotionIds: ['idle','talk','happy'] },
      game: { petId: identity.petId, characterId: 'star-singer', nickname: '星咏', petRevision: 4,
        presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL', moodScore: 50, healthPoints: 100,
        energy: 87.5, bond: 10.1, level: 2, xp: 120, trip: null, recentEvents: [] },
      recentMessages: [
        { petId: 'pet-1', conversationId: 'conv-1', messageId: 'old-user', role: 'USER', text: '你好', createdAt: 20 },
        { petId: 'pet-1', conversationId: 'conv-1', messageId: 'old-assistant', role: 'ASSISTANT', text: '你好呀！', createdAt: 30 },
      ],
      authorizedMemories: [
        { memoryId: 'memory-a', ownerPetId: 'pet-1', recipientPetId: 'pet-1', scope: 'PRIVATE', type: 'PREFERENCE',
          summary: '喜欢安静的早晨', consentState: 'CONFIRMED' },
        { memoryId: 'memory-b', ownerPetId: 'pet-2', recipientPetId: 'pet-1', scope: 'SHARED', type: 'PREFERENCE',
          summary: '喜欢猫', consentState: 'CONFIRMED' },
      ],
      historySummary: null,
    },
  };
}

const rest = { type: 'REST' as const, targetId: 'self', reason: '休息一下吧' };
const memory = { scope: 'PRIVATE' as const, type: 'PREFERENCE' as const, summary: '用户喜欢茶',
  sourceMessageIds: ['message-current'], confidence: 0.8 };
const reply: ChatReply = { text: '一起喝茶吧！', emotion: 'calm', motionIntent: 'talk', actionProposals: [rest], memoryCandidates: [memory] };
const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
const error = { code: 'TIMEOUT' as const, message: '模型响应超时。', retryable: true };

describe('trusted Provider settings, not per-message address or credential overrides', () => {
  it('accepts mock without any network or credential, explicit local and HTTPS cloud', () => {
    expect(providerConfigSchema.parse(mock)).toEqual(mock);
    expect(providerConfigSchema.parse(local)).toEqual(local);
    expect(providerConfigSchema.parse(cloud)).toEqual(cloud);
    expect(providerConfigSchema.parse({ ...cloud, endpointKind: 'ANTHROPIC' }).endpointKind).toBe('ANTHROPIC');
    expect(providerConfigSchema.parse({ ...cloud, endpointKind: 'OPENAI_COMPATIBLE', modelId: 'vendor/model.v2' }).modelId).toBe('vendor/model.v2');
    expect(providerConfigSchema.parse({ ...local, baseUrl: 'http://[::1]:11434/api/' }).baseUrl).toBe('http://[::1]:11434/api/');
    expect(providerConfigSchema.parse({ ...local, baseUrl: 'https://127.0.0.1:8000/v1' }).privacyBoundary).toBe('LOCAL');
  });

  it.each([
    'http://api.example.com/v1', 'https://user:password@api.example.com/v1', 'https://@api.example.com/v1',
    'https://api.example.com/v1?secret=one', 'https://api.example.com/v1?', 'https://api.example.com/v1#fragment',
    'https://api.example.com/v1#', 'https://api.example.com/../v1', 'https://api.example.com/a/%2e%2e/b',
    'https://api.example.com/a%2fb', 'https://api.example.com/a\\b', 'https://api.example.com//v1',
    'https://api.example.com/v1\n', 'https://api.example.com:65536/v1', 'https://api.example.com:0/v1',
    'https://api.example.com./v1', 'https://-wrong.example.com/v1', 'http://127.1:11434', 'http://127.0.0.2:11434',
    'https://127.0.0.2:443', 'https://2130706433/v1', 'https://0177.0.0.1/v1', 'https://0x7f000001/v1',
    'http://localhost.evil.example/v1', 'https://a.localhost/v1', 'file:///tmp/models', 'ftp://api.example.com',
    'https://api.example.com/a:cmd', 'javascript:alert(1)', 'https://api.example.com/a/./b',
  ])('rejects ambiguous, unapproved or path-injecting base URL %s', value => {
    expect(providerBaseUrlSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { apiKey: 'raw-key' }, { headers: { Authorization: 'Bearer raw-key' } }, { baseUrl: 'https://api.example.com/v1' },
    { privacyBoundary: 'LOCAL' }, { endpointKind: 'OLLAMA' }, { credentialRef: 'credential:secret' },
    { maxContextTokens: 100 }, { maxOutputTokens: 0 }, { maxOutputTokens: 8000 }, { maxContextTokens: 8.5 },
    { timeoutMs: 0 }, { timeoutMs: 300001 }, { capabilities: { ...capabilities, toolCalls: true } },
  ])('does not accept unknown settings, mock networking or invalid budgets: %o', invalid => {
    expect(providerConfigSchema.safeParse({ ...mock, ...invalid }).success).toBe(false);
  });

  it.each([
    { privacyBoundary: 'LOCAL' }, { privacyBoundary: 'MOCK' }, { credentialRef: null }, { credentialRef: 'sk-example' },
    { baseUrl: 'http://localhost:8000/v1' }, { baseUrl: 'https://127.0.0.1:8000/v1' }, { baseUrl: null },
  ])('requires explicit cloud HTTPS boundary and broker credential reference: %o', invalid => {
    expect(providerConfigSchema.safeParse({ ...cloud, ...invalid }).success).toBe(false);
  });

  it.each(['https://api.example.com/model', 'file:/etc/models', 'C:/models/demo', 'x/../model', 'a//b', 'model name', 'model?x=y', 'model\\raw'])('model identity is not a URL or path: %s', modelId => {
    expect(providerConfigSchema.safeParse({ ...cloud, modelId }).success).toBe(false);
  });
});

describe('request and pre-authorized one-pet context', () => {
  it('accepts one user turn and a no-current-message proactive turn with the same closed context', () => {
    expect(turnRequestSchema.parse(turn())).toEqual(turn());
    expect(turnRequestSchema.parse({ ...turn(), trigger: 'PROACTIVE', userText: null, userMessageId: null }).trigger).toBe('PROACTIVE');
  });

  it.each([
    { userText: null }, { userMessageId: null }, { userText: '   ' }, { userText: 'x'.repeat(4001) },
    { trigger: 'PROACTIVE' }, { trigger: 'UNKNOWN' }, { deadline: 0 }, { deadline: NaN }, { snapshotRevision: -1 },
    { endpoint: 'https://api.example.com' }, { credentialRef: 'credential:one' }, { modelId: 'x' }, { tools: [] },
    { petId: 'different-pet' }, { personaRevision: 2 },
  ])('rejects unclosed, oversized or mismatched turns: %o', invalid => {
    expect(turnRequestSchema.safeParse({ ...turn(), ...invalid }).success).toBe(false);
  });

  it('rejects cross-pet, cross-conversation, unordered, repeated or current-message history', () => {
    const request = turn();
    const history = request.context.recentMessages;
    for (const recentMessages of [
      [{ ...history[0], petId: 'pet-2' }], [{ ...history[0], conversationId: 'other-conv' }],
      [history[0], history[0]], [history[1], history[0]], [{ ...history[0], messageId: request.userMessageId }],
    ]) expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, recentMessages } }).success).toBe(false);
  });

  it('rejects unapproved private/shared memories and forbids raw sources in retrieval context', () => {
    const request = turn();
    const [privateMemory, sharedMemory] = request.context.authorizedMemories;
    for (const authorizedMemories of [
      [{ ...privateMemory, ownerPetId: 'pet-2' }], [{ ...sharedMemory, recipientPetId: 'pet-2' }],
      [{ ...sharedMemory, consentState: 'PENDING' }], [privateMemory, privateMemory],
      [{ ...sharedMemory, sourceConversationId: 'other-private-chat' }], [{ ...sharedMemory, rawText: 'secret conversation' }],
    ]) expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, authorizedMemories } }).success).toBe(false);
  });

  it('requires the authority pet and persona/template association, bounded game values and private event scope', () => {
    const request = turn();
    const { game, persona } = request.context;
    for (const invalid of [
      { ...request.context, game: { ...game, petId: 'pet-2' } }, { ...request.context, persona: { ...persona, characterId: 'fluffy-ranger' } },
      { ...request.context, game: { ...game, energy: 500 } }, { ...request.context, game: { ...game, walletCoins: 400 } },
      { ...request.context, game: { ...game, presence: 'AWAY' } }, { ...request.context, game: { ...game, activity: null } },
      { ...request.context, game: { ...game, recentEvents: [{ petId: 'pet-2', eventId: 'event-a', type: 'TripSettled', occurredAt: 100, summary: 'returned' }] } },
      { ...request.context, persona: { ...persona, allowedMotionIds: ['idle', 'idle'] } },
    ]) expect(turnRequestSchema.safeParse({ ...request, context: invalid }).success).toBe(false);
  });

  it('pins a history summary to an eligible same-pet conversation, not its current user message', () => {
    const request = turn();
    const summary = { petId: identity.petId, conversationId: identity.conversationId, text: '早上的闲聊。', version: 1, sourceMessageIds: ['older-a'] };
    expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, historySummary: summary } }).success).toBe(true);
    for (const historySummary of [{ ...summary, petId: 'pet-2' }, { ...summary, conversationId: 'other' },
      { ...summary, sourceMessageIds: [request.userMessageId] }, { ...summary, sourceMessageIds: ['duplicate','duplicate'] }]) {
      expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, historySummary } }).success).toBe(false);
    }
  });

  it('bounds memory and message context even with syntactically valid distinct IDs', () => {
    const request = turn();
    const recentMessages = Array.from({ length: aiLimits.historyMessages + 1 }, (_, index) => ({
      ...request.context.recentMessages[0], messageId: `message-${index}`, createdAt: index,
    }));
    const authorizedMemories = Array.from({ length: aiLimits.authorizedMemories + 1 }, (_, index) => ({
      ...request.context.authorizedMemories[0], memoryId: `memory-${index}`,
    }));
    expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, recentMessages } }).success).toBe(false);
    expect(turnRequestSchema.safeParse({ ...request, context: { ...request.context, authorizedMemories } }).success).toBe(false);
  });
});

describe('model reply and suggestions are not commands or authorization', () => {
  it('validates structured text, emotion, semantics, limited suggestions and memory drafts', () => {
    expect(chatReplySchema.parse(reply)).toEqual(reply);
    const withSuggestions = { ...reply, actionProposals: [rest, { type: 'TRIP_SUGGESTION', targetId: 'morning-dew-meadow', reason: '出门走走' },
      { type: 'QUICK_ACTION_SUGGESTION', targetId: 'workspace-editor', reason: '建议打开工作区' }] };
    expect(chatReplySchema.safeParse(withSuggestions).success).toBe(true);
    expect(chatReplySchema.safeParse({ ...reply, memoryCandidates: [{ ...memory, scope: 'SHARED' }] }).success).toBe(true);
  });

  it.each([
    { text: ' ' }, { text: 'a'.repeat(aiLimits.replyText + 1) }, { emotion: 'EXECUTE' }, { motionIntent: '../../program' },
    { actionProposals: [rest,rest,rest,rest] }, { memoryCandidates: Array.from({ length: 6 }, () => memory) },
    { petId: 'pet-2' }, { xp: 1000 }, { inventoryDelta: [] }, { walletCoins: 42 }, { executed: true }, { toolCalls: [] },
  ])('rejects excessive text, invented game effects, execution output and unsupported fields: %o', invalid => {
    expect(chatReplySchema.safeParse({ ...reply, ...invalid }).success).toBe(false);
  });

  it.each([
    { type: 'RUN_COMMAND' }, { type: 'WRITE_DATABASE' }, { type: 'OPEN_URL' }, { targetId: 'C:/Program Files/example.exe' },
    { targetId: 'https://api.example.com' }, { targetId: '../path' }, { targetId: 'tool; run' }, { targetId: '\\network\\share' },
    { command: 'start editor' }, { args: [] }, { path: 'file' }, { proposalId: 'trusted-id' }, { petId: 'pet-2' },
    { expiresAt: 100 }, { confirmationRequired: false }, { confirmed: true },
  ])('proposal draft cannot supply OS/command parameters or self-authorize: %o', invalid => {
    expect(actionProposalDraftSchema.safeParse({ ...rest, ...invalid }).success).toBe(false);
    expect(chatReplySchema.safeParse({ ...reply, actionProposals: [{ ...rest, ...invalid }] }).success).toBe(false);
  });

  it.each([
    { summary: ' ' }, { sourceMessageIds: [] }, { sourceMessageIds: ['x', 'x'] }, { confidence: -0.1 }, { confidence: 1.1 },
    { type: 'CREDENTIAL' }, { scope: 'GLOBAL_WRITE' }, { petId: 'pet-2' }, { memoryId: 'owned' }, { consentState: 'CONFIRMED' },
    { recipientPetIds: ['pet-2'] }, { pinned: true }, { sourcePath: '/home/private' }, { apiKey: 'raw-key' },
  ])('memory draft contains user-source candidates only, never confirmation or secrets fields: %o', invalid => {
    expect(memoryCandidateDraftSchema.safeParse({ ...memory, ...invalid }).success).toBe(false);
  });

  it('generates a JSON Schema from the closed reply contract with exact top-level keys and array budgets', () => {
    const schema = chatReplyJsonSchema();
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false,
      properties: { actionProposals: { type: 'array', maxItems: 3 }, memoryCandidates: { type: 'array', maxItems: 5 } } });
  });
});

describe('trusted confirmation and conversation DTOs', () => {
  it('does not permit a proposal to drop user confirmation, even after binding a trusted identity', () => {
    const proposal = { ...rest, ...identity, proposalId: 'proposal-id', expiresAt: 500, confirmationRequired: true };
    expect(actionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(actionProposalSchema.safeParse({ ...proposal, confirmationRequired: false }).success).toBe(false);
    expect(actionProposalSchema.safeParse({ ...proposal, commandLine: 'run this' }).success).toBe(false);
  });

  it('keeps candidate confirmation pending and expiration bounded by creation time', () => {
    const candidate = { ...memory, candidateId: 'candidate-1', ownerPetId: identity.petId, conversationId: identity.conversationId,
      requestId: identity.requestId, consentState: 'PENDING', createdAt: 10, expiresAt: 100 };
    expect(pendingMemoryCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(pendingMemoryCandidateSchema.safeParse({ ...candidate, consentState: 'CONFIRMED' }).success).toBe(false);
    expect(pendingMemoryCandidateSchema.safeParse({ ...candidate, expiresAt: 10 }).success).toBe(false);
  });

  it('only confirmed shared memory may have explicit, unique recipients', () => {
    const record = { memoryId: 'mem-one', ownerPetId: 'pet-1', type: 'PREFERENCE', summary: '喜欢茶', sourceConversationId: 'conv-1',
      sourceMessageIds: ['user-1'], confidence: 1, createdAt: 1, updatedAt: 2, expiresAt: null, pinned: false, consentState: 'CONFIRMED' };
    expect(memoryRecordSchema.safeParse({ ...record, scope: 'PRIVATE' }).success).toBe(true);
    expect(memoryRecordSchema.safeParse({ ...record, scope: 'SHARED', recipientPetIds: ['pet-2'] }).success).toBe(true);
    for (const invalid of [{ ...record, scope: 'SHARED', recipientPetIds: [] }, { ...record, scope: 'SHARED', recipientPetIds: ['pet-1'] },
      { ...record, scope: 'PRIVATE', recipientPetIds: ['pet-2'] }, { ...record, scope: 'SHARED', recipientPetIds: ['pet-2','pet-2'] },
      { ...record, scope: 'PRIVATE', consentState: 'PENDING' }, { ...record, scope: 'PRIVATE', updatedAt: 0 }]) {
      expect(memoryRecordSchema.safeParse(invalid).success).toBe(false);
    }
    expect(authorizedMemoryContextSchema.safeParse(turn().context.authorizedMemories[0]).success).toBe(true);
  });

  it('checks conversation and durable message lifecycle without allowing raw audio paths', () => {
    const conversation = { petId: 'pet-1', conversationId: 'conv-1', title: '茶会', createdAt: 1, updatedAt: 2 };
    expect(conversationSchema.safeParse(conversation).success).toBe(true);
    expect(conversationSchema.safeParse({ ...conversation, updatedAt: 0 }).success).toBe(false);
    const msg = { ...identity, role: 'USER', text: '你好', messageId: 'msg-1', createdAt: 2, status: 'COMPLETED' };
    expect(chatMessageSchema.safeParse(msg).success).toBe(true);
    expect(chatMessageSchema.safeParse({ ...msg, status: 'PENDING' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...msg, text: '   ' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...msg, audioPath: '/tmp/recording.wav' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...msg, role: 'ASSISTANT', status: 'CANCELLED', text: '' }).success).toBe(true);
  });
});

describe('stream correlation, provider normalization and usage', () => {
  it('requires identical event identity fields for every stream result and disallows partial instructions', () => {
    const base = { ...identity, sequence: 0 };
    expect(chatStreamEventSchema.parse({ ...base, kind: 'textDelta', delta: '呀！' })).toMatchObject(identity);
    expect(chatStreamEventSchema.safeParse({ ...base, kind: 'textDelta', delta: 'partial', actionProposals: [rest] }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ ...base, kind: 'final', reply, usage }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({ ...base, kind: 'error', error }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({ ...base, kind: 'cancelled', reason: 'USER' }).success).toBe(true);
    for (const invalid of [{ ...base, kind: 'textDelta', delta: '' }, { ...base, kind: 'textDelta', delta: 'x'.repeat(aiLimits.deltaText + 1) },
      { ...base, kind: 'error', error, sequence: -1 }, { ...base, kind: 'cancelled', reason: 'USER', reply },
      { ...base, kind: 'final', reply, usage, petId: undefined }, { ...base, kind: 'error', error, requestId: '' },
      { ...base, kind: 'final', reply, usage, conversationId: '../foreign' }]) {
      expect(chatStreamEventSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('separates normalized plain-text fallback from structured reply and rejects hidden execution', () => {
    const request = { providerId: 'provider-mock', modelId: 'demo-mock', maxOutputTokens: 400, outputMode: 'TEXT', turn: turn() };
    expect(providerRequestSchema.safeParse(request).success).toBe(true);
    expect(providerRequestSchema.safeParse({ ...request, baseUrl: 'https://api.example.com' }).success).toBe(false);
    expect(providerRequestSchema.safeParse({ ...request, credentialRef: 'credential:one' }).success).toBe(false);
    expect(providerRequestSchema.safeParse({ ...request, tools: [] }).success).toBe(false);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'TEXT', text: '只回复文字', usage: null }).success).toBe(true);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'TEXT', text: '只回复文字', usage: null, actionProposals: [rest] }).success).toBe(false);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'STRUCTURED', reply, usage }).success).toBe(true);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'STRUCTURED', reply: { ...reply, shell: 'execute' }, usage }).success).toBe(false);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'ERROR', error }).success).toBe(true);
    expect(providerOutputSchema.safeParse({ ...identity, kind: 'CANCELLED', reason: 'SUPERSEDED' }).success).toBe(true);
  });

  it.each([{ inputTokens: -1 }, { outputTokens: 0.5 }, { totalTokens: 119 }, { outputTokens: aiLimits.outputTokens + 1 }, { cost: 5 }, { apiKey: 'secret' }])('rejects corrupt or authority-bearing usage: %o', invalid => {
    expect(aiUsageSchema.safeParse({ ...usage, ...invalid }).success).toBe(false);
  });
});
