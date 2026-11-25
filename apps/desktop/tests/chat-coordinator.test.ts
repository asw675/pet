import { describe, expect, it, vi } from 'vitest';
import { chatStreamEventSchema, providerOutputSchema } from '@pet-desktop/contracts/ai';
import type { ActionProposalDraft, ChatMessage, ChatReply, ChatStreamEvent, ProviderConfig, ProviderOutput, ProviderRequest, TurnRequest } from '@pet-desktop/contracts/ai';
import { ChatCoordinator } from '../src/app-service/ai/chat-coordinator';
import type { ChatAuthorityPort, ChatBeginResult, ChatTerminal, ChatTurnIntent, UserChatTurnIntent } from '../src/app-service/ai/chat-coordinator';
import type { ModelProvider, TurnIdentity } from '../src/app-service/ai/model-provider';

const NOW = 1000;
const baseConfig: ProviderConfig = { providerId: 'provider-one', endpointKind: 'MOCK', privacyBoundary: 'MOCK', baseUrl: null,
  credentialRef: null, modelId: 'mock', capabilities: { streamText: true, nativeStructured: false, jsonMode: false, usage: false, embeddings: false },
  maxContextTokens: 8_000, maxOutputTokens: 400, timeoutMs: 30_000 };
const input = (requestId = 'request-1', petId = 'pet-1', conversationId = `conv-${petId}`): UserChatTurnIntent => ({
  requestId, petId, conversationId, trigger: 'USER', userText: '我喜欢茶。',
});
const identityOf = (value: TurnIdentity): TurnIdentity => ({ requestId: value.requestId, petId: value.petId, conversationId: value.conversationId });
const textResult = (intent: TurnIdentity, text = '你好'): ProviderOutput => ({ ...identityOf(intent), kind: 'TEXT', text, usage: null });
const structuredReply: ChatReply = { text: '你好呀。', emotion: 'calm', motionIntent: 'talk', actionProposals: [], memoryCandidates: [] };
const structureResult = (intent: TurnIdentity, reply = structuredReply): ProviderOutput => ({ ...identityOf(intent), kind: 'STRUCTURED', reply, usage: null });

function assembleTurn(intent: ChatTurnIntent, at: number): TurnRequest {
  const characterId = intent.petId === 'pet-2' ? 'fluffy-ranger' : 'star-singer';
  return { ...identityOf(intent), trigger: intent.trigger, personaRevision: 3, snapshotRevision: 9, deadline: at + 30_000,
    userText: intent.userText, userMessageId: intent.trigger === 'USER' ? `message-${intent.requestId}` : null,
    context: {
      persona: { personaId: `persona-${characterId}`, characterId, revision: 3, displayName: '星咏', background: '原创角色',
        personality: { summary: '温柔', traits: ['细心'], likes: ['茶'], speechStyle: '温柔' }, languageTag: 'zh-CN', allowedMotionIds: ['idle','talk'] },
      game: { petId: intent.petId, characterId, nickname: '星咏', petRevision: 2, presence: 'HOME', activity: 'IDLE',
        mood: 'CALM', healthStatus: 'NORMAL', moodScore: 50, healthPoints: 100, energy: 80, bond: 10,
        level: 1, xp: 5, trip: null, recentEvents: [] }, recentMessages: [], authorizedMemories: [], historySummary: null,
    },
  };
}

class MemoryAuthority implements ChatAuthorityPort {
  begins: ChatTurnIntent[] = [];
  pending = new Map<string, TurnRequest>();
  messages = new Map<string, ChatMessage>();
  terminals = new Map<string, ChatTerminal>();
  attemptedTerminals: ChatTerminal[] = [];
  providerId = baseConfig.providerId;
  rejectBegin = false;
  refuseFinish = false;
  failComplete = false;
  transform: ((turn: TurnRequest) => void) | undefined;
  allowed = new Set<string>(['REST:self','TRIP_SUGGESTION:morning-dew-meadow','QUICK_ACTION_SUGGESTION:editor']);

  beginTurn(intent: ChatTurnIntent, at: number): ChatBeginResult {
    this.begins.push(intent);
    if (this.pending.has(intent.requestId) || this.terminals.has(intent.requestId)) return { kind: 'DUPLICATE' };
    if (this.rejectBegin) return { kind: 'REJECTED', error: { code: 'UNAVAILABLE', message: 'private repository error', retryable: true } };
    const turn = assembleTurn(intent, at);
    if (intent.trigger === 'USER') {
      const messageId = turn.userMessageId!;
      this.messages.set(messageId, { ...identityOf(intent), role: 'USER', status: 'COMPLETED', text: intent.userText, messageId, createdAt: at });
    }
    this.pending.set(intent.requestId, turn);
    this.transform?.(turn);
    return { kind: 'STARTED', turn, providerId: this.providerId };
  }
  finishTurn(terminal: ChatTerminal): boolean {
    this.attemptedTerminals.push(terminal);
    if (this.failComplete && terminal.kind === 'COMPLETED') throw new Error('private persistence exception');
    if (this.refuseFinish || !this.pending.has(terminal.requestId) || this.terminals.has(terminal.requestId)) return false;
    this.pending.delete(terminal.requestId);
    this.terminals.set(terminal.requestId, terminal);
    return true;
  }
  lookupMessage(messageId: string): ChatMessage | null { return this.messages.get(messageId) ?? null; }
  isProposalAllowed(_identity: TurnIdentity, draft: ActionProposalDraft): boolean { return this.allowed.has(`${draft.type}:${draft.targetId}`); }
}

interface ProviderCall { config: ProviderConfig; request: ProviderRequest; credential: string | null; signal: AbortSignal;
  delta: ((value: string) => void) | undefined; resolve(value: ProviderOutput): void; reject(error: unknown): void }
class DeferredProvider implements ModelProvider {
  calls: ProviderCall[] = [];
  generate(config: ProviderConfig, request: ProviderRequest, credential: string | null, signal: AbortSignal,
    onTextDelta?: (value: string) => void): Promise<ProviderOutput> {
    return new Promise((resolve, reject) => this.calls.push({ config, request, credential, signal, delta: onTextDelta, resolve, reject }));
  }
}

function fixture(config: ProviderConfig = baseConfig, maxActiveJobs = 3) {
  const authority = new MemoryAuthority(); authority.providerId = config.providerId;
  const provider = new DeferredProvider();
  let now = NOW;
  let serial = 0;
  const broker = { resolveCredential: vi.fn(async (_provider: string, _ref: string, _signal: AbortSignal) => 'fixture-credential') };
  const registry = { resolve: vi.fn((_providerId: string) => ({ config, provider })) };
  const coordinator = new ChatCoordinator({ authority, registry, credentialBroker: broker,
    maxActiveJobs, now: () => now, createId: kind => `${kind}-${++serial}` });
  const events: ChatStreamEvent[] = [];
  const receive = (event: ChatStreamEvent) => { expect(chatStreamEventSchema.safeParse(event).success).toBe(true); events.push(event); };
  return { authority, provider, coordinator, events, receive, broker, registry, setNow(value: number) { now = value; } };
}

async function microtasks(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }
async function started(f: ReturnType<typeof fixture>, count = 1): Promise<void> { await vi.waitFor(() => expect(f.provider.calls).toHaveLength(count)); }
async function terminal(f: ReturnType<typeof fixture>, requestId = 'request-1'): Promise<ChatTerminal> {
  await vi.waitFor(() => expect(f.authority.terminals.has(requestId)).toBe(true));
  return f.authority.terminals.get(requestId)!;
}

describe('chat turn coordinator identity, durability and concurrency', () => {
  it('commits the pending turn synchronously before requesting an async provider, then streams correlated text and commits one final', async () => {
    const f = fixture(), intent = input();
    expect(f.coordinator.start(intent, f.receive)).toEqual({ accepted: true, ...identityOf(intent) });
    expect(f.authority.pending.has(intent.requestId)).toBe(true);
    expect(f.provider.calls).toHaveLength(0);
    expect(f.coordinator.activeCount).toBe(1);
    await started(f);
    const call = f.provider.calls[0]!;
    expect(call.request.turn.context.game.petId).toBe('pet-1');
    expect(call.request.outputMode).toBe('TEXT');
    expect(call.credential).toBeNull();
    expect(f.broker.resolveCredential).not.toHaveBeenCalled();
    call.delta!('你'); call.delta!('好');
    expect(f.events).toEqual([{ ...identityOf(intent), kind: 'textDelta', sequence: 0, delta: '你' }, { ...identityOf(intent), kind: 'textDelta', sequence: 1, delta: '好' }]);
    expect(f.authority.terminals.size).toBe(0);
    call.resolve(textResult(intent));
    expect(await terminal(f)).toMatchObject({ kind: 'COMPLETED', reply: { text: '你好', actionProposals: [], memoryCandidates: [], motionIntent: 'idle' }, proposals: [], memoryCandidates: [], usage: null });
    expect(f.events[2]).toMatchObject({ ...identityOf(intent), kind: 'final', sequence: 2, reply: { text: '你好' } });
    expect(f.coordinator.activeCount).toBe(0);
    call.delta!('late');
    expect(f.events).toHaveLength(3);
    expect(f.authority.attemptedTerminals).toHaveLength(1);
  });

  it('only permits explicit user start; proactive is a separate trusted entry with no proposal/candidate output', async () => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: true } };
    const f = fixture(cfg);
    const proactive = { ...identityOf(input()), trigger: 'PROACTIVE' as const, userText: null };
    expect(f.coordinator.start(proactive, f.receive)).toMatchObject({ accepted: false, reason: 'INVALID_REQUEST' });
    expect(f.authority.begins).toHaveLength(0);
    expect(f.coordinator.startProactive(proactive, f.receive).accepted).toBe(true);
    await started(f);
    const call = f.provider.calls[0]!;
    expect(call.request.turn).toMatchObject({ trigger: 'PROACTIVE', userText: null, userMessageId: null });
    call.resolve(structureResult(proactive, { ...structuredReply, actionProposals: [{ type: 'REST', targetId: 'self', reason: '休息' }],
      memoryCandidates: [{ scope: 'PRIVATE', type: 'PREFERENCE', summary: '喜欢茶', sourceMessageIds: ['unknown'], confidence: 1 }] }));
    expect(await terminal(f)).toMatchObject({ kind: 'COMPLETED', proposals: [], memoryCandidates: [], reply: { actionProposals: [], memoryCandidates: [] } });
  });

  it('rejects raw context/config fields or oversized blank user text before any authority writes', () => {
    const f = fixture();
    for (const invalid of [{ ...input(), userText: ' ' }, { ...input(), userText: 'x'.repeat(4001) },
      { ...input(), context: {} }, { ...input(), providerId: 'cloud' }, { ...input(), userMessageId: 'model-chosen' }]) {
      expect(f.coordinator.start(invalid as UserChatTurnIntent, f.receive)).toMatchObject({ accepted: false, reason: 'INVALID_REQUEST' });
    }
    expect(f.authority.begins).toHaveLength(0);
  });

  it('enforces one active request per pet, distinct pet contexts and configured global limit', async () => {
    const f = fixture(baseConfig, 2);
    expect(f.coordinator.start(input('first','pet-1'), f.receive).accepted).toBe(true);
    expect(f.coordinator.start(input('other','pet-1'), f.receive)).toMatchObject({ accepted: false, reason: 'PET_BUSY' });
    expect(f.coordinator.start(input('first','pet-2'), f.receive)).toMatchObject({ accepted: false, reason: 'DUPLICATE' });
    expect(f.coordinator.start(input('second','pet-2'), f.receive).accepted).toBe(true);
    expect(f.coordinator.start(input('third','pet-3'), f.receive)).toMatchObject({ accepted: false, reason: 'GLOBAL_BUSY' });
    expect(f.authority.begins).toHaveLength(2);
    await started(f, 2);
    expect(f.provider.calls[0]?.request.turn.context.game.characterId).toBe('star-singer');
    expect(f.provider.calls[1]?.request.turn.context.game.characterId).toBe('fluffy-ranger');
    f.provider.calls[1]!.resolve(textResult(input('second','pet-2'), 'second')); await terminal(f, 'second');
    f.provider.calls[0]!.resolve(textResult(input('first','pet-1'), 'first')); await terminal(f, 'first');
    expect(f.events.map(event => [event.petId, event.requestId])).toEqual([['pet-2','second'], ['pet-1','first']]);
    expect(f.coordinator.activeCount).toBe(0);
  });

  it('never re-generates an authority-recorded duplicate after terminal commit', async () => {
    const f = fixture(); f.coordinator.start(input(), f.receive); await started(f);
    f.provider.calls[0]!.resolve(textResult(input())); await terminal(f);
    expect(f.coordinator.start(input(), f.receive)).toMatchObject({ accepted: false, reason: 'DUPLICATE' });
    expect(f.provider.calls).toHaveLength(1);
    expect(f.authority.attemptedTerminals).toHaveLength(1);
  });

  it('normalizes authority rejection and never calls a provider or leaks private errors', async () => {
    const f = fixture(); f.authority.rejectBegin = true;
    const result = f.coordinator.start(input(), f.receive);
    expect(result).toMatchObject({ accepted: false, reason: 'AUTHORITY_REJECTED', error: { code: 'UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('private repository');
    await microtasks(); expect(f.provider.calls).toHaveLength(0);
  });

  it('fails closed if authority context contradicts original pet, conversation, request or user text', async () => {
    for (const transform of [(turn: TurnRequest) => { turn.petId = 'wrong'; }, (turn: TurnRequest) => { turn.conversationId = 'wrong'; },
      (turn: TurnRequest) => { turn.requestId = 'wrong'; }, (turn: TurnRequest) => { turn.userText = 'rewritten'; }]) {
      const f = fixture(); f.authority.transform = transform;
      expect(f.coordinator.start(input(), f.receive).accepted).toBe(true);
      expect(await terminal(f)).toMatchObject({ ...identityOf(input()), kind: 'FAILED', error: { code: 'INTERNAL_ERROR' } });
      expect(f.provider.calls).toHaveLength(0);
      expect(f.authority.attemptedTerminals).toHaveLength(1);
    }
  });

  it('copies the authoritative projection at acceptance, not a mutable later source', async () => {
    const f = fixture(); f.coordinator.start(input(), f.receive);
    f.authority.pending.get('request-1')!.context.game.energy = 1;
    await started(f);
    expect(f.provider.calls[0]?.request.turn.context.game.energy).toBe(80);
    f.coordinator.close();
  });
});

describe('provider selection, credentials and cancellation generations', () => {
  it.each([['STRUCTURED',true,true],['JSON',false,true],['TEXT',false,false]] as const)('selects only the configured %s capability without fallback', async (mode, native, json) => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: native, jsonMode: json } };
    const f = fixture(cfg); f.coordinator.start(input(), f.receive); await started(f);
    const call = f.provider.calls[0]!;
    expect(call.request.outputMode).toBe(mode);
    expect(typeof call.delta === 'function').toBe(mode === 'TEXT');
    call.resolve(mode === 'TEXT' ? textResult(input()) : structureResult(input()));
    expect(await terminal(f)).toMatchObject({ kind: 'COMPLETED' });
    expect(f.provider.calls).toHaveLength(1);
  });

  it('resolves only the selected provider credential reference and never includes key in authority/events', async () => {
    const cfg: ProviderConfig = { ...baseConfig, endpointKind: 'OPENAI_COMPATIBLE', privacyBoundary: 'CLOUD',
      baseUrl: 'https://provider.example/v1', credentialRef: 'credential:chosen' };
    const f = fixture(cfg); f.coordinator.start(input(), f.receive); await started(f);
    expect(f.registry.resolve).toHaveBeenCalledExactlyOnceWith(cfg.providerId);
    expect(f.broker.resolveCredential).toHaveBeenCalledExactlyOnceWith(cfg.providerId, 'credential:chosen', expect.any(AbortSignal));
    expect(f.provider.calls[0]?.credential).toBe('fixture-credential');
    f.provider.calls[0]!.resolve(textResult(input())); await terminal(f);
    expect(JSON.stringify([f.authority.begins, [...f.authority.terminals.values()], f.events])).not.toContain('fixture-credential');
  });

  it('never substitutes a hidden provider or retries after missing credentials, wrong registry identity or adapter failure', async () => {
    const cfg: ProviderConfig = { ...baseConfig, endpointKind: 'OPENAI_COMPATIBLE', privacyBoundary: 'CLOUD', baseUrl: 'https://provider.example/v1', credentialRef: 'credential:selected' };
    const noKey = fixture(cfg); (noKey.broker.resolveCredential as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    noKey.coordinator.start(input(), noKey.receive);
    expect(await terminal(noKey)).toMatchObject({ kind: 'FAILED', error: { code: 'AUTH_REQUIRED' } });
    expect(noKey.provider.calls).toHaveLength(0);
    const wrong = fixture(cfg); wrong.authority.providerId = 'missing-config';
    wrong.coordinator.start(input(), wrong.receive);
    expect(await terminal(wrong)).toMatchObject({ kind: 'FAILED', error: { code: 'UNSUPPORTED' } });
    expect(wrong.broker.resolveCredential).not.toHaveBeenCalled();
    const failProvider = fixture(); failProvider.coordinator.start(input(), failProvider.receive); await started(failProvider);
    failProvider.provider.calls[0]!.reject(new Error('provider exception secret'));
    expect(await terminal(failProvider)).toMatchObject({ kind: 'FAILED', error: { code: 'INTERNAL_ERROR' } });
    expect(failProvider.provider.calls).toHaveLength(1);
    expect(JSON.stringify(failProvider.events)).not.toContain('provider exception');
  });

  it('cancels exactly matching identity, releases the pet, and ignores late old deltas and replies', async () => {
    const f = fixture(), first = input(), next = input('request-2');
    f.coordinator.start(first, f.receive); await started(f);
    const old = f.provider.calls[0]!; old.delta!('old');
    expect(f.coordinator.cancel({ ...identityOf(first), conversationId: 'other' }, 'USER')).toBe(false);
    expect(f.coordinator.cancel(identityOf(first), 'SUPERSEDED')).toBe(true);
    expect(old.signal.aborted).toBe(true);
    expect(f.coordinator.cancel(identityOf(first), 'USER')).toBe(false);
    expect(f.coordinator.start(next, f.receive).accepted).toBe(true); await started(f, 2);
    old.delta!('late-old'); old.resolve(textResult(first, 'late-old'));
    f.provider.calls[1]!.delta!('new'); f.provider.calls[1]!.resolve(textResult(next, 'new'));
    expect(await terminal(f, 'request-2')).toMatchObject({ kind: 'COMPLETED', reply: { text: 'new' } });
    expect(f.events.map(event => [event.requestId,event.kind,event.sequence])).toEqual([
      ['request-1','textDelta',0],['request-1','cancelled',1],['request-2','textDelta',0],['request-2','final',1],
    ]);
    expect(f.authority.attemptedTerminals).toHaveLength(2);
  });

  it('may cancel immediately after synchronous acceptance without starting provider', async () => {
    const f = fixture(); f.coordinator.start(input(), f.receive);
    expect(f.coordinator.cancel(identityOf(input()), 'USER')).toBe(true);
    await microtasks(); expect(f.provider.calls).toHaveLength(0);
    expect(f.authority.terminals.get('request-1')).toMatchObject({ kind: 'CANCELLED', reason: 'USER' });
  });

  it('cancels an abort-ignorant broker wait before provider, and ignores a later key result', async () => {
    const cfg: ProviderConfig = { ...baseConfig, endpointKind: 'OPENAI_COMPATIBLE', privacyBoundary: 'CLOUD', baseUrl: 'https://provider.example/v1', credentialRef: 'credential:one' };
    const f = fixture(cfg);
    let resolve!: (key: string) => void;
    f.broker.resolveCredential.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    f.coordinator.start(input(), f.receive);
    await vi.waitFor(() => expect(f.broker.resolveCredential).toHaveBeenCalledOnce());
    f.coordinator.cancel(identityOf(input()), 'PET_SWITCH'); resolve('late-key');
    await microtasks(); expect(f.provider.calls).toHaveLength(0);
    expect(f.authority.terminals.get('request-1')).toMatchObject({ kind: 'CANCELLED', reason: 'PET_SWITCH' });
  });

  it('terminates pending generation at the authority deadline even if provider ignores AbortSignal', async () => {
    const f = fixture(); f.authority.transform = turn => { turn.deadline = NOW + 15; };
    f.coordinator.start(input(), f.receive); await started(f);
    const call = f.provider.calls[0]!;
    expect(await terminal(f)).toMatchObject({ kind: 'FAILED', error: { code: 'TIMEOUT' } });
    expect(call.signal.aborted).toBe(true);
    call.delta!('late'); call.resolve(textResult(input())); await microtasks();
    expect(f.events.map(event => event.kind)).toEqual(['error']);
  });

  it('rejects a preexpired authoritative deadline before registry/broker/provider', async () => {
    const f = fixture(); f.authority.transform = turn => { turn.deadline = NOW; };
    f.coordinator.start(input(), f.receive);
    expect(await terminal(f)).toMatchObject({ kind: 'FAILED', error: { code: 'TIMEOUT' } });
    expect(f.provider.calls).toHaveLength(0); expect(f.registry.resolve).not.toHaveBeenCalled();
  });

  it('close cancels all jobs once, aborts late operations, and disallows further starts', async () => {
    const f = fixture(); f.coordinator.start(input('request-a','pet-1'), f.receive); f.coordinator.start(input('request-b','pet-2'), f.receive); await started(f,2);
    f.coordinator.close(); f.coordinator.close();
    expect(f.coordinator.activeCount).toBe(0);
    expect(f.authority.terminals.size).toBe(2);
    expect([...f.authority.terminals.values()].every(value => value.kind === 'CANCELLED' && value.reason === 'SERVICE_STOPPED')).toBe(true);
    expect(f.coordinator.start(input('new'), f.receive)).toMatchObject({ accepted: false, reason: 'CLOSED' });
    for (const call of f.provider.calls) { call.delta?.('late'); call.resolve(textResult(call.request.turn)); }
    await microtasks(); expect(f.events.map(event => event.kind)).toEqual(['cancelled','cancelled']);
  });
});

describe('validated terminal events and pending-only suggestions', () => {
  it.each([['other pet',{petId:'pet-2'}],['other conversation',{conversationId:'other'}],['other request',{requestId:'other'}]])('rejects cross-boundary provider result: %s', async (_label, changes) => {
    const f = fixture(); f.coordinator.start(input(),f.receive); await started(f);
    f.provider.calls[0]!.resolve({ ...textResult(input()), ...changes } as ProviderOutput);
    expect(await terminal(f)).toMatchObject({ ...identityOf(input()), kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    expect(f.events.some(event => event.kind === 'final')).toBe(false);
  });

  it('rejects mode mismatch, invalid output shape, oversized deltas and inconsistent final text', async () => {
    const mismatch = fixture(); mismatch.coordinator.start(input(), mismatch.receive); await started(mismatch);
    mismatch.provider.calls[0]!.resolve(structureResult(input())); expect(await terminal(mismatch)).toMatchObject({ kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    const invalid = fixture(); invalid.coordinator.start(input(), invalid.receive); await started(invalid);
    invalid.provider.calls[0]!.resolve({ ...textResult(input()), arbitraryCommand: 'execute' } as unknown as ProviderOutput);
    expect(await terminal(invalid)).toMatchObject({ kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    const large = fixture(); large.coordinator.start(input(), large.receive); await started(large); large.provider.calls[0]!.delta!('x'.repeat(2001));
    expect(await terminal(large)).toMatchObject({ kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    const inconsistent = fixture(); inconsistent.coordinator.start(input(), inconsistent.receive); await started(inconsistent);
    inconsistent.provider.calls[0]!.delta!('prefix'); inconsistent.provider.calls[0]!.resolve(textResult(input(), 'different'));
    expect(await terminal(inconsistent)).toMatchObject({ kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
  });

  it('normalizes adapter error message and maintains durable cancellation terminal from provider', async () => {
    const f = fixture(); f.coordinator.start(input(),f.receive); await started(f);
    f.provider.calls[0]!.resolve(providerOutputSchema.parse({ ...identityOf(input()), kind: 'ERROR', error: { code: 'RATE_LIMITED', message: 'hidden details', retryable: false } }));
    expect(await terminal(f)).toMatchObject({ kind: 'FAILED', error: { code: 'RATE_LIMITED', retryable: true } });
    expect(JSON.stringify(f.events)).not.toContain('hidden details');
    const cancelled = fixture(); cancelled.coordinator.start(input(),cancelled.receive); await started(cancelled);
    cancelled.provider.calls[0]!.resolve({ ...identityOf(input()), kind: 'CANCELLED', reason: 'USER' });
    expect(await terminal(cancelled)).toMatchObject({ kind: 'CANCELLED', reason: 'USER' });
  });

  it('isolates callback exceptions from successful authority writes and future deltas', async () => {
    const f = fixture(); const callback = vi.fn(() => { throw new Error('renderer disconnected'); });
    f.coordinator.start(input(),callback); await started(f);
    f.provider.calls[0]!.delta!('你好'); f.provider.calls[0]!.resolve(textResult(input()));
    expect(await terminal(f)).toMatchObject({ kind: 'COMPLETED' });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.authority.attemptedTerminals).toHaveLength(1);
  });

  it('does not publish final when authority CAS refuses; rolled-back complete may only commit a failed terminal', async () => {
    const refused = fixture(); refused.authority.refuseFinish = true;
    refused.coordinator.start(input(),refused.receive); await started(refused); refused.provider.calls[0]!.resolve(textResult(input()));
    await vi.waitFor(() => expect(refused.coordinator.activeCount).toBe(0));
    expect(refused.authority.attemptedTerminals).toHaveLength(1); expect(refused.events).toHaveLength(0);
    const failed = fixture(); failed.authority.failComplete = true;
    failed.coordinator.start(input(),failed.receive); await started(failed); failed.provider.calls[0]!.resolve(textResult(input()));
    expect(await terminal(failed)).toMatchObject({ kind: 'FAILED', error: { code: 'INTERNAL_ERROR' } });
    expect(failed.authority.attemptedTerminals.map(value => value.kind)).toEqual(['COMPLETED','FAILED']);
    expect(failed.events.map(event => event.kind)).toEqual(['error']);
  });

  it('binds only allowed suggestions to the trusted identity and retains confirmation requirement', async () => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: true } };
    const f = fixture(cfg); f.coordinator.start(input(),f.receive); await started(f);
    f.provider.calls[0]!.resolve(structureResult(input(), { ...structuredReply, motionIntent: 'model-invented', actionProposals: [
      { type: 'REST', targetId: 'self', reason: '先休息' }, { type: 'TRIP_SUGGESTION', targetId: 'morning-dew-meadow', reason: '探索' },
      { type: 'QUICK_ACTION_SUGGESTION', targetId: 'unknown-tool', reason: '打开' },
    ] }));
    const result = await terminal(f);
    expect(result).toMatchObject({ kind: 'COMPLETED', reply: { motionIntent: null, actionProposals: [expect.objectContaining({ type: 'REST' }), expect.objectContaining({ type: 'TRIP_SUGGESTION' })] } });
    if (result.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(result.proposals).toEqual([expect.objectContaining({ ...identityOf(input()), proposalId:'proposal-1', confirmationRequired: true, expiresAt: NOW+60_000 }),
      expect.objectContaining({ ...identityOf(input()), proposalId:'proposal-2', confirmationRequired: true, expiresAt: NOW+60_000 })]);
    expect(result.reply.actionProposals.every(value => !('proposalId' in value))).toBe(true);
  });

  it('denies all proposals without authority allowlist and removes same-target duplicates', async () => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: true } };
    const reply = { ...structuredReply, actionProposals: [{ type: 'REST' as const, targetId:'self', reason:'休息' },
      { type: 'REST' as const, targetId:'self', reason:'再次休息' }, { type: 'REST' as const, targetId:'pet-2', reason:'他人' }] };
    const defaultDeny = fixture(cfg); defaultDeny.authority.allowed.clear();
    defaultDeny.coordinator.start(input(),defaultDeny.receive); await started(defaultDeny); defaultDeny.provider.calls[0]!.resolve(structureResult(input(),reply));
    expect(await terminal(defaultDeny)).toMatchObject({ kind:'COMPLETED', proposals:[], reply:{actionProposals:[]} });
    const allow = fixture(cfg); allow.coordinator.start(input(),allow.receive); await started(allow); allow.provider.calls[0]!.resolve(structureResult(input(),reply));
    const result = await terminal(allow); expect(result.kind).toBe('COMPLETED'); if(result.kind==='COMPLETED') expect(result.proposals).toHaveLength(1);
  });

  it('only persists pending memory candidates with true, eligible, same-pet completed USER sources; filters sensitive/control claims', async () => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: true } };
    const f = fixture(cfg); f.coordinator.start(input(),f.receive); await started(f);
    const actual = f.provider.calls[0]!.request.turn.userMessageId!;
    f.provider.calls[0]!.resolve(structureResult(input(), { ...structuredReply, memoryCandidates: [
      { scope: 'SHARED', type:'PREFERENCE', summary:'用户喜欢茶', sourceMessageIds:[actual], confidence:0.9 },
      { scope: 'PRIVATE', type:'PREFERENCE', summary:'用户喜欢猫', sourceMessageIds:['invented'], confidence:1 },
      { scope: 'PRIVATE', type:'HISTORY', summary:'密码是秘密', sourceMessageIds:[actual], confidence:1 },
      { scope: 'PRIVATE', type:'AGREEMENT', summary:'自动执行系统命令', sourceMessageIds:[actual], confidence:1 },
    ] }));
    const result = await terminal(f);
    if (result.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(result.memoryCandidates).toEqual([expect.objectContaining({ candidateId:'memory-candidate-1', ownerPetId:'pet-1',
      conversationId:input().conversationId, requestId:input().requestId, scope:'SHARED', consentState:'PENDING', sourceMessageIds:[actual] })]);
    expect(result.memoryCandidates[0]).not.toHaveProperty('recipientPetIds');
    expect(result.reply.memoryCandidates).toHaveLength(1);
    expect(result.reply.memoryCandidates[0]).not.toHaveProperty('consentState');
  });

  it('re-reads current source rather than saving a deleted or other-pet message from old context', async () => {
    const cfg = { ...baseConfig, capabilities: { ...baseConfig.capabilities, nativeStructured: true } };
    for (const mutate of [(f: ReturnType<typeof fixture>, key: string) => f.authority.messages.delete(key),
      (f: ReturnType<typeof fixture>, key: string) => { f.authority.messages.set(key, { ...f.authority.messages.get(key)!, petId: 'pet-2' }); }]) {
      const f = fixture(cfg); f.coordinator.start(input(),f.receive); await started(f);
      const actual = f.provider.calls[0]!.request.turn.userMessageId!;
      mutate(f,actual);
      f.provider.calls[0]!.resolve(structureResult(input(), { ...structuredReply, memoryCandidates: [{scope:'PRIVATE',type:'PREFERENCE',summary:'用户喜欢茶',sourceMessageIds:[actual],confidence:1}] }));
      expect(await terminal(f)).toMatchObject({ kind:'COMPLETED', memoryCandidates:[], reply:{memoryCandidates:[]} });
    }
  });

  it('independently blocks a known broker credential echoed across provider deltas', async () => {
    const cfg: ProviderConfig = { ...baseConfig, endpointKind: 'OPENAI_COMPATIBLE', privacyBoundary: 'CLOUD',
      baseUrl: 'https://provider.example/v1', credentialRef: 'credential:selected' };
    const f = fixture(cfg); f.coordinator.start(input(), f.receive); await started(f);
    const call = f.provider.calls[0]!;
    call.delta!('安全内容 fixture-'); call.delta!('credential');
    expect(await terminal(f)).toMatchObject({ kind: 'FAILED', error: { code: 'INVALID_RESPONSE' } });
    expect(f.events.filter(event => event.kind === 'textDelta').map(event => event.delta).join('')).toBe('安全内容 ');
    expect(JSON.stringify(f.events)).not.toContain('fixture-credential');
    expect(JSON.stringify([...f.authority.terminals.values()])).not.toContain('fixture-credential');
    call.resolve(textResult(input(), 'late result')); await microtasks();
    expect(f.events.map(event => event.kind)).toEqual(['textDelta','error']);
  });

  it('does not send a context containing the exact broker credential to the provider seam', async () => {
    const cfg: ProviderConfig = { ...baseConfig, endpointKind: 'OPENAI_COMPATIBLE', privacyBoundary: 'CLOUD',
      baseUrl: 'https://provider.example/v1', credentialRef: 'credential:selected' };
    const f = fixture(cfg); f.coordinator.start({ ...input(), userText: 'fixture-credential' }, f.receive);
    expect(await terminal(f)).toMatchObject({ kind: 'FAILED', error: { code: 'UNSUPPORTED' } });
    expect(f.provider.calls).toHaveLength(0);
  });

  it('rechecks absolute time before committing a delayed provider result even if timer has not yet fired', async () => {
    const f = fixture(); f.coordinator.start(input(),f.receive); await started(f);
    f.setNow(NOW + baseConfig.timeoutMs + 1);
    f.provider.calls[0]!.resolve(textResult(input()));
    expect(await terminal(f)).toMatchObject({ kind:'FAILED', error:{code:'TIMEOUT'} });
    expect(f.events.some(event => event.kind === 'final')).toBe(false);
  });
});
