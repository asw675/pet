import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  actionProposalSchema, aiCancelReasonSchema, aiErrorSchema, aiLimits, chatReplySchema, chatStreamEventSchema,
  providerConfigSchema, providerOutputSchema, providerRequestSchema, turnRequestSchema,
} from '@pet-desktop/contracts/ai';
import type {
  ActionProposal, ActionProposalDraft, AiCancelReason, AiError, AiErrorCode, AiUsage, ChatMessage, ChatReply,
  ChatStreamEvent, PendingMemoryCandidate, ProviderConfig, ProviderOutputMode, TurnRequest,
} from '@pet-desktop/contracts/ai';
import { buildPendingMemoryCandidates } from '@pet-desktop/app-service/memory-policy';
import { ModelProviderError, publicAiError } from './model-provider';
import type { ModelProvider, TurnIdentity } from './model-provider';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const identityFields = { requestId: id, petId: id, conversationId: id };
const identitySchema = z.strictObject(identityFields);
const userTurnIntentSchema = z.strictObject({ ...identityFields, trigger: z.literal('USER'),
  userText: z.string().min(1).max(aiLimits.userText).refine(value => value.trim().length > 0) });
const proactiveTurnIntentSchema = z.strictObject({ ...identityFields, trigger: z.literal('PROACTIVE'), userText: z.null() });
export type UserChatTurnIntent = z.infer<typeof userTurnIntentSchema>;
export type ProactiveChatTurnIntent = z.infer<typeof proactiveTurnIntentSchema>;
export type ChatTurnIntent = UserChatTurnIntent | ProactiveChatTurnIntent;

/** Authority begins an actual conversation turn in one synchronous operation:
 * it validates ownership, appends the completed user input (if any), creates
 * exactly one pending assistant response, freezes the authorized context and
 * chooses the provider ID from durable settings. No caller-supplied context. */
export type ChatBeginResult =
  | { kind: 'STARTED'; turn: TurnRequest; providerId: string }
  | { kind: 'DUPLICATE' }
  | { kind: 'REJECTED'; error: AiError };

type TerminalFields = TurnIdentity & { completedAt: number };
export type ChatTerminal =
  | (TerminalFields & { kind: 'COMPLETED'; reply: ChatReply; usage: AiUsage | null;
    proposals: ActionProposal[]; memoryCandidates: PendingMemoryCandidate[] })
  | (TerminalFields & { kind: 'FAILED'; error: AiError })
  | (TerminalFields & { kind: 'CANCELLED'; reason: AiCancelReason });

export interface ChatAuthorityPort {
  beginTurn(intent: ChatTurnIntent, at: number): ChatBeginResult;
  /** Synchronous compare-and-set from pending. The authority must re-check
   * current source existence, proposal allowlists and ownership, committing
   * the terminal and pending candidates atomically, never confirmed memory or
   * gameplay/OS execution. `false` denotes no new committed terminal. */
  finishTurn(terminal: ChatTerminal): boolean;
  /** Current durable record, not model-supplied historical content. */
  lookupMessage(messageId: string): ChatMessage | null;
  /** Optional authority-owned proposal allowlist. Absent/failing means deny. */
  isProposalAllowed?(identity: TurnIdentity, draft: ActionProposalDraft): boolean;
}

export interface ResolvedChatProvider { config: ProviderConfig; provider: ModelProvider }
export interface ChatProviderRegistry { resolve(providerId: string): ResolvedChatProvider | undefined }
export interface ChatCredentialBroker {
  resolveCredential(providerId: string, credentialRef: string, signal: AbortSignal): Promise<string | null>;
}
export interface ChatCoordinatorOptions {
  authority: ChatAuthorityPort;
  registry: ChatProviderRegistry;
  credentialBroker: ChatCredentialBroker;
  maxActiveJobs?: number;
  now?: () => number;
  createId?: (kind: 'proposal' | 'memory-candidate') => string;
}
export type ChatStartRejection = 'INVALID_REQUEST' | 'DUPLICATE' | 'PET_BUSY' | 'GLOBAL_BUSY' | 'AUTHORITY_REJECTED' | 'CLOSED';
export type ChatStartResult =
  | ({ accepted: true } & TurnIdentity)
  | { accepted: false; reason: ChatStartRejection; error: AiError };

interface Job {
  identity: TurnIdentity;
  intent: ChatTurnIntent;
  begun: Extract<ChatBeginResult, { kind: 'STARTED' }>;
  startedAt: number;
  deadline: number;
  controller: AbortController;
  onEvent: (event: ChatStreamEvent) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
  sequence: number;
  deltaText: string;
  emittedDeltaChars: number;
}

const MAX_GLOBAL_JOBS = 3;
const PROPOSAL_TTL_MS = 60_000;
const aborted = Symbol('chat job aborted');

function sameIdentity(a: TurnIdentity, b: TurnIdentity): boolean {
  return a.requestId === b.requestId && a.petId === b.petId && a.conversationId === b.conversationId;
}
function copyIdentity(value: TurnIdentity): TurnIdentity {
  return { requestId: value.requestId, petId: value.petId, conversationId: value.conversationId };
}
function publicError(error: unknown, fallback: AiErrorCode = 'INTERNAL_ERROR'): AiError {
  const parsed = aiErrorSchema.safeParse(error);
  return publicAiError(parsed.success ? parsed.data.code : fallback);
}
function reject(reason: ChatStartRejection, code: AiErrorCode): ChatStartResult {
  return { accepted: false, reason, error: publicAiError(code) };
}

/** Stop waiting even if an injected broker/provider does not honor abort.
 * Its eventual Promise settlement is consumed without any further effects. */
function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => rejectPromise(aborted));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(() => resolve(value)), error => finish(() => rejectPromise(error)));
    if (signal.aborted) onAbort();
  });
}

function chooseMode(config: ProviderConfig): ProviderOutputMode {
  return config.capabilities.nativeStructured ? 'STRUCTURED' : config.capabilities.jsonMode ? 'JSON' : 'TEXT';
}

/** Exact broker value only; this is not general sensitive-data detection. */
function hasKnownCredential(value: unknown, credential: string | null): boolean {
  if (credential === null) return false;
  if (typeof value === 'string') return value.includes(credential);
  return value !== null && typeof value === 'object' && Object.values(value).some(entry => hasKnownCredential(entry, credential));
}

function wellFormedText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Process-local jobs around synchronous authoritative repository calls. No
 * database transaction is kept open while awaiting credentials or inference. */
export class ChatCoordinator {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;
  private readonly createId: (kind: 'proposal' | 'memory-candidate') => string;
  private readonly maxActiveJobs: number;
  private closed = false;

  constructor(private readonly options: ChatCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (kind => `${kind}-${randomUUID()}`);
    const limit = options.maxActiveJobs ?? MAX_GLOBAL_JOBS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GLOBAL_JOBS) throw new RangeError('Invalid chat concurrency limit');
    this.maxActiveJobs = limit;
  }

  get activeCount(): number { return this.jobs.size; }

  /** Public chat entry: only USER, never an arbitrary proactive trigger. */
  start(intent: ChatTurnIntent, onEvent: (event: ChatStreamEvent) => void): ChatStartResult {
    const parsed = userTurnIntentSchema.safeParse(intent);
    return parsed.success ? this.begin(parsed.data, onEvent) : reject('INVALID_REQUEST', 'UNSUPPORTED');
  }

  /** Separate trusted internal entry for local proactive rules, not exposed to
   * renderer calls. Such turns never create action or memory candidates. */
  startProactive(intent: ProactiveChatTurnIntent, onEvent: (event: ChatStreamEvent) => void): ChatStartResult {
    const parsed = proactiveTurnIntentSchema.safeParse(intent);
    return parsed.success ? this.begin(parsed.data, onEvent) : reject('INVALID_REQUEST', 'UNSUPPORTED');
  }

  private clock(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new ModelProviderError('INTERNAL_ERROR');
    return at;
  }

  private begin(intent: ChatTurnIntent, onEvent: (event: ChatStreamEvent) => void): ChatStartResult {
    if (typeof onEvent !== 'function') return reject('INVALID_REQUEST', 'UNSUPPORTED');
    if (this.closed) return reject('CLOSED', 'UNAVAILABLE');
    if ([...this.jobs.values()].some(job => job.identity.requestId === intent.requestId)) return reject('DUPLICATE', 'UNSUPPORTED');
    if (this.jobs.has(intent.petId)) return reject('PET_BUSY', 'UNAVAILABLE');
    if (this.jobs.size >= this.maxActiveJobs) return reject('GLOBAL_BUSY', 'UNAVAILABLE');
    let at: number, begun: ChatBeginResult;
    const frozenIntent = { ...intent };
    try {
      at = this.clock();
      begun = this.options.authority.beginTurn({ ...intent }, at);
    } catch { return reject('AUTHORITY_REJECTED', 'INTERNAL_ERROR'); }
    if (!begun || typeof begun !== 'object') return reject('AUTHORITY_REJECTED', 'INTERNAL_ERROR');
    if (begun.kind === 'DUPLICATE') return reject('DUPLICATE', 'UNSUPPORTED');
    if (begun.kind === 'REJECTED') return { accepted: false, reason: 'AUTHORITY_REJECTED', error: publicError(begun.error) };
    if (begun.kind !== 'STARTED') return reject('AUTHORITY_REJECTED', 'INTERNAL_ERROR');
    // The authority has already committed the pending turn here, before any
    // provider/credential wait. Even malformed trusted output is terminated
    // against the original request identity, never re-attributed elsewhere.
    const clonedTurn = turnRequestSchema.safeParse(begun.turn);
    const frozenBegun = { kind: 'STARTED' as const, providerId: begun.providerId,
      turn: clonedTurn.success ? clonedTurn.data : begun.turn };
    const job: Job = { identity: copyIdentity(frozenIntent), intent: frozenIntent, begun: frozenBegun, startedAt: at,
      deadline: Math.min(Number.MAX_SAFE_INTEGER, at + aiLimits.timeoutMs), controller: new AbortController(),
      onEvent, timer: undefined, settled: false, sequence: 0, deltaText: '', emittedDeltaChars: 0 };
    this.jobs.set(intent.petId, job);
    // Schedule only after returning acceptance; a synchronous mock cannot emit
    // a delta or terminal before callers know which pending request owns it.
    void Promise.resolve().then(() => this.run(job)).catch(() => {
      if (this.isActive(job)) this.fail(job, 'INTERNAL_ERROR');
    });
    return { accepted: true, ...job.identity };
  }

  private isActive(job: Job): boolean { return !job.settled && this.jobs.get(job.identity.petId) === job; }

  private armDeadline(job: Job, absoluteDeadline: number): void {
    job.deadline = Math.min(job.deadline, absoluteDeadline);
    if (job.timer !== undefined) clearTimeout(job.timer);
    const remaining = job.deadline - this.clock();
    if (remaining <= 0) throw new ModelProviderError('TIMEOUT');
    job.timer = setTimeout(() => { if (this.isActive(job)) this.fail(job, 'TIMEOUT'); }, remaining);
  }

  private emit(job: Job, event: ChatStreamEvent): void {
    const parsed = chatStreamEventSchema.safeParse(event);
    if (!parsed.success) return;
    // A disconnected renderer or callback throwing cannot disrupt the
    // provider or already-committed authoritative terminal state.
    try { job.onEvent(parsed.data); } catch { /* notification is not authority */ }
  }

  private checkDeadline(job: Job): boolean {
    if (!this.isActive(job)) return false;
    try {
      if (this.clock() >= job.deadline) { this.fail(job, 'TIMEOUT'); return false; }
    } catch { this.fail(job, 'INTERNAL_ERROR'); return false; }
    return true;
  }

  private delta(job: Job, value: string, credential: string | null): void {
    if (!this.checkDeadline(job)) return;
    if (typeof value !== 'string' || value.length === 0 || value.length > aiLimits.deltaText || !wellFormedText(value)) {
      this.fail(job, 'INVALID_RESPONSE'); return;
    }
    if (job.deltaText.length + value.length > aiLimits.replyText) { this.fail(job, 'TRUNCATED'); return; }
    const aggregate = job.deltaText + value;
    if (hasKnownCredential(aggregate, credential)) { this.fail(job, 'INVALID_RESPONSE'); return; }
    job.deltaText = aggregate;
    // Hold only a suffix that might complete a known key on the next delta.
    // The adapter also enforces this; keep the independent boundary here for
    // future provider implementations and untrusted transport mistakes.
    let hold = 0;
    if (credential !== null) {
      for (let length = Math.min(credential.length - 1, aggregate.length); length > 0; length--) {
        if (credential.startsWith(aggregate.slice(-length))) { hold = length; break; }
      }
    }
    this.emitTextThrough(job, aggregate.length - hold);
  }

  private emitTextThrough(job: Job, end: number): void {
    if (end <= job.emittedDeltaChars || !this.isActive(job)) return;
    const next = job.deltaText.slice(job.emittedDeltaChars, end);
    job.emittedDeltaChars = end;
    let delta = '';
    const publish = (value: string) => {
      if (!this.isActive(job)) return;
      this.emit(job, { ...job.identity, sequence: job.sequence++, kind: 'textDelta', delta: value });
    };
    for (const char of next) {
      if (delta.length + char.length > aiLimits.deltaText) { publish(delta); delta = ''; }
      delta += char;
    }
    if (delta.length > 0) publish(delta);
  }

  private completedAt(job: Job): number {
    // Monotonic per turn; if the clock becomes unavailable during failure
    // handling, retain the last known authority timestamp instead of guessing.
    try { return Math.max(job.startedAt, this.clock()); } catch { return job.startedAt; }
  }

  private fail(job: Job, code: AiErrorCode): boolean {
    return this.finish(job, { ...job.identity, completedAt: this.completedAt(job), kind: 'FAILED', error: publicAiError(code) });
  }

  /** Seal before persisting to prevent reentrancy or late provider callbacks.
   * A failed/duplicate CAS never publishes a success or a second terminal. */
  private finish(job: Job, terminal: ChatTerminal): boolean {
    if (!this.isActive(job)) return false;
    job.settled = true;
    if (job.timer !== undefined) clearTimeout(job.timer);
    if (terminal.kind !== 'COMPLETED') job.controller.abort(terminal.kind === 'CANCELLED' ? terminal.reason : 'SERVICE_STOPPED');
    let committed = false;
    let published = terminal;
    try {
      committed = this.options.authority.finishTurn(terminal) === true;
    } catch {
      // A transactional failure must not publish the proposed reply or
      // candidates. One best-effort FAILED CAS closes a rolled-back pending
      // record. If it already committed or storage is unavailable, suppress
      // duplicate notification and leave reconciliation to the authority.
      published = { ...job.identity, completedAt: terminal.completedAt, kind: 'FAILED', error: publicAiError('INTERNAL_ERROR') };
      if (terminal.kind !== 'FAILED') {
        job.controller.abort('SERVICE_STOPPED');
        try { committed = this.options.authority.finishTurn(published) === true; } catch { /* recovery boundary */ }
      }
    } finally {
      if (this.jobs.get(job.identity.petId) === job) this.jobs.delete(job.identity.petId);
    }
    if (!committed) return false;
    const fields = { ...job.identity, sequence: job.sequence++ };
    switch (published.kind) {
      case 'COMPLETED': this.emit(job, { ...fields, kind: 'final', reply: published.reply, usage: published.usage }); break;
      case 'FAILED': this.emit(job, { ...fields, kind: 'error', error: published.error }); break;
      case 'CANCELLED': this.emit(job, { ...fields, kind: 'cancelled', reason: published.reason }); break;
    }
    return true;
  }

  private async run(job: Job): Promise<void> {
    if (!this.isActive(job)) return;
    try {
      const parsed = turnRequestSchema.safeParse(job.begun.turn);
      if (!parsed.success || !sameIdentity(parsed.data, job.identity) || parsed.data.trigger !== job.intent.trigger
        || parsed.data.userText !== job.intent.userText || !id.safeParse(job.begun.providerId).success) {
        throw new ModelProviderError('INTERNAL_ERROR');
      }
      const turn = parsed.data;
      this.armDeadline(job, turn.deadline);
      const resolved = this.options.registry.resolve(job.begun.providerId);
      const checked = providerConfigSchema.safeParse(resolved?.config);
      if (!resolved || !checked.success || checked.data.providerId !== job.begun.providerId
        || typeof resolved.provider?.generate !== 'function') throw new ModelProviderError('UNSUPPORTED');
      const config = checked.data;
      this.armDeadline(job, Math.min(Number.MAX_SAFE_INTEGER, job.startedAt + config.timeoutMs));
      let credential: string | null = null;
      if (config.credentialRef !== null) {
        try {
          credential = await abortable(this.options.credentialBroker.resolveCredential(config.providerId, config.credentialRef, job.controller.signal), job.controller.signal);
        } catch { if (!this.isActive(job)) return; throw new ModelProviderError('AUTH_REQUIRED'); }
        if (typeof credential !== 'string' || credential.length === 0 || credential.length > 8192 || /[^\x21-\x7e]/u.test(credential)) {
          throw new ModelProviderError('AUTH_REQUIRED');
        }
      }
      if (!this.checkDeadline(job)) return;
      const outputMode = chooseMode(config);
      const request = providerRequestSchema.parse({ providerId: config.providerId, modelId: config.modelId,
        outputMode, maxOutputTokens: config.maxOutputTokens, turn: { ...turn, deadline: job.deadline } });
      if (hasKnownCredential(request, credential)) throw new ModelProviderError('UNSUPPORTED');
      // No credential is persisted in a job or emitted. The trusted provider
      // receives only this one broker result, never a cross-provider fallback.
      const output = await abortable(resolved.provider.generate(config, request, credential, job.controller.signal,
        outputMode === 'TEXT' && config.capabilities.streamText ? value => this.delta(job, value, credential) : undefined), job.controller.signal);
      if (!this.checkDeadline(job)) return;
      const normalized = providerOutputSchema.safeParse(output);
      if (!normalized.success || !sameIdentity(normalized.data, job.identity)) throw new ModelProviderError('INVALID_RESPONSE');
      const result = normalized.data;
      if (result.kind === 'ERROR') { this.fail(job, result.error.code); return; }
      if (result.kind === 'CANCELLED') {
        this.finish(job, { ...job.identity, completedAt: this.completedAt(job), kind: 'CANCELLED', reason: result.reason }); return;
      }
      if ((outputMode === 'TEXT') !== (result.kind === 'TEXT')
        || (result.usage !== null && result.usage.outputTokens > request.maxOutputTokens)) throw new ModelProviderError('INVALID_RESPONSE');
      if (hasKnownCredential(result, credential) || !wellFormedText(result.kind === 'TEXT' ? result.text : result.reply.text)) {
        throw new ModelProviderError('INVALID_RESPONSE');
      }
      credential = null;
      if (result.kind === 'TEXT' && job.deltaText.length > 0 && job.deltaText !== result.text) throw new ModelProviderError('INVALID_RESPONSE');
      if (result.kind === 'TEXT' && job.deltaText.length > 0) this.emitTextThrough(job, job.deltaText.length);
      if (!this.isActive(job)) return;
      const reply: ChatReply = result.kind === 'STRUCTURED' ? result.reply : {
        text: result.text, emotion: 'neutral', motionIntent: turn.context.persona.allowedMotionIds.includes('idle') ? 'idle' : null,
        actionProposals: [], memoryCandidates: [],
      };
      const completedAt = this.completedAt(job);
      const suggestions = this.filterDrafts(job, turn, reply, completedAt);
      if (!this.checkDeadline(job)) return;
      this.finish(job, { ...job.identity, completedAt, kind: 'COMPLETED',
        reply: suggestions.reply, usage: config.capabilities.usage ? result.usage : null,
        proposals: suggestions.proposals, memoryCandidates: suggestions.memoryCandidates });
    } catch (error) {
      if (this.isActive(job)) this.fail(job, error instanceof ModelProviderError ? error.code : 'INTERNAL_ERROR');
    }
  }

  private filterDrafts(job: Job, turn: TurnRequest, rawReply: ChatReply, at: number): {
    reply: ChatReply; proposals: ActionProposal[]; memoryCandidates: PendingMemoryCandidate[];
  } {
    const proposals: ActionProposal[] = [];
    const memoryCandidates: PendingMemoryCandidate[] = [];
    const seenProposals = new Set<string>(), seenProposalIds = new Set<string>();
    if (turn.trigger === 'USER') {
      for (const draft of rawReply.actionProposals) {
        if ((draft.type === 'REST' || draft.type === 'TRIP_SUGGESTION') && turn.context.game.presence !== 'HOME') continue;
        if (draft.type === 'REST' && draft.targetId !== 'self' && draft.targetId !== job.identity.petId) continue;
        const key = JSON.stringify([draft.type, draft.targetId]);
        if (seenProposals.has(key) || at > Number.MAX_SAFE_INTEGER - PROPOSAL_TTL_MS) continue;
        seenProposals.add(key);
        try {
          if (!this.options.authority.isProposalAllowed?.(job.identity, draft)) continue;
          const checked = actionProposalSchema.safeParse({ ...draft, ...job.identity, proposalId: this.createId('proposal'),
            expiresAt: at + PROPOSAL_TTL_MS, confirmationRequired: true });
          if (checked.success && !seenProposalIds.has(checked.data.proposalId)) {
            seenProposalIds.add(checked.data.proposalId);
            proposals.push(checked.data);
          }
        } catch { /* a failed or unknown allowlist never authorizes a suggestion */ }
      }
      const eligible = new Set(turn.context.recentMessages.filter(message => message.role === 'USER').map(message => message.messageId));
      if (turn.userMessageId !== null) eligible.add(turn.userMessageId);
      try {
        const result = buildPendingMemoryCandidates({ ownerPetId: job.identity.petId, conversationId: job.identity.conversationId,
          requestId: job.identity.requestId, now: at, drafts: rawReply.memoryCandidates,
          lookupSource: messageId => eligible.has(messageId) ? this.options.authority.lookupMessage(messageId) : null,
          allocateCandidateId: () => this.createId('memory-candidate') });
        memoryCandidates.push(...result.candidates);
      } catch { /* memory extraction cannot block valid conversational text */ }
    }
    const reply = chatReplySchema.parse({ text: rawReply.text, emotion: rawReply.emotion,
      motionIntent: rawReply.motionIntent !== null && turn.context.persona.allowedMotionIds.includes(rawReply.motionIntent) ? rawReply.motionIntent : null,
      actionProposals: proposals.map(proposal => ({ type: proposal.type, targetId: proposal.targetId, reason: proposal.reason })),
      memoryCandidates: memoryCandidates.map(candidate => ({ scope: candidate.scope, type: candidate.type, summary: candidate.summary,
        sourceMessageIds: candidate.sourceMessageIds, confidence: candidate.confidence })) });
    return { reply, proposals, memoryCandidates };
  }

  cancel(identity: TurnIdentity, reason: AiCancelReason): boolean {
    const parsed = identitySchema.safeParse(identity), validReason = aiCancelReasonSchema.safeParse(reason);
    if (!parsed.success || !validReason.success) return false;
    const job = this.jobs.get(parsed.data.petId);
    if (!job || !sameIdentity(job.identity, parsed.data)) return false;
    return this.finish(job, { ...job.identity, completedAt: this.completedAt(job), kind: 'CANCELLED', reason: validReason.data });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.jobs.values()]) this.cancel(job.identity, 'SERVICE_STOPPED');
  }
}
