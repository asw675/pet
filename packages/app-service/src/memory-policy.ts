import {
  aiLimits, authorizedMemoryContextSchema, chatMessageSchema, memoryCandidateDraftSchema,
  memoryRecordSchema, pendingMemoryCandidateSchema,
} from '@pet-desktop/contracts/ai';
import type {
  AuthorizedMemoryContext, ChatMessage, MemoryCandidateDraft, MemoryRecord, MemoryScope,
  MemoryType, PendingMemoryCandidate,
} from '@pet-desktop/contracts/ai';

/** Bounded policy, not a persistence store, model, FTS index or authority to
 * confirm/modify/grant a memory. The caller must authenticate user decisions,
 * load current records/grants transactionally and invalidate deleted sources. */
export const memoryPolicyLimits = Object.freeze({
  candidateTtlMs: 7 * 24 * 60 * 60 * 1000,
  recordsToConsider: 512,
  pendingToConsider: 512,
  sourceMessages: 16,
  ownedPets: 100,
  lexicalTerms: 128,
});

export type MemorySourceLookup = (messageId: string) => ChatMessage | null | undefined;
export type MemoryTextRejection = 'INVALID_TEXT' | 'SENSITIVE' | 'CONTROL_INSTRUCTION';
export type MemoryScreening = { readonly ok: true } | { readonly ok: false; readonly reason: MemoryTextRejection };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const validId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function parse<T>(schema: Parser<T>, value: unknown): T | undefined {
  try { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}

// Intentionally conservative, bounded lexical screening. A valid result is
// NOT a guarantee of de-identification, fact entailment, or prompt safety.
// All memories remain untrusted text even after user consent. Do not execute
// them or use them as instructions. The heuristic may over/under-block.
const sensitivePatterns: readonly RegExp[] = [
  /\b(?:password|passphrase|passcode|pin\s*code|api[\s_-]*key|access[\s_-]*key|secret[\s_-]*key|private[\s_-]*key|token|credential|bearer|otp|one[\s-]*time[\s-]*code|recovery[\s-]*phrase|seed[\s-]*phrase|session[\s_-]*cookie)\b/iu,
  /密码|口令|密钥|秘钥|私钥|令牌|验证码|助记词|种子词|恢复短语|访问凭据|登录凭据|身份验证|二步验证|双重验证|会话凭据/u,
  /\b(?:social\s+security|passport|national\s+id|credit\s+card|debit\s+card|bank\s+account|routing\s+number|cvv|cvc|serial\s+number|phone\s+number|home\s+address|email\s+address|date\s+of\s+birth|medical\s+record|diagnosis|sexual\s+orientation|political\s+affiliation|religious\s+affiliation|salary|financial\s+account)\b/iu,
  /身份证|证件号|护照号|社保号|银行卡|信用卡|卡号|银行账号|银行账户|手机号|手机号码|电话号码|联系电话|联系方式|邮箱地址|电子邮箱|家庭住址|地址|住在|出生日期|病历|病情|诊断|性取向|宗教信仰|政治立场|工资|收入/u,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu,
  /\d{6,}/u, // conservative: long identifiers/verification codes also catch dates
  /(?:\d[\s()-]?){10,19}\d/u,
  /\b(?:sk|rk|ghp|gho|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /[A-Za-z0-9+/_-]{32,}/u,
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/u,
  /clipboard|剪贴板|文件内容|窗口内容|音频原文件|录音原文件/iu,
  /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/u,
];
const controlPatterns: readonly RegExp[] = [
  /\b(?:system|developer)\s+(?:prompt|instructions?|rules?)\b|\b(?:prompt\s+injection|jailbreak)\b/iu,
  /\b(?:ignore|disregard|bypass|override|disable|modify|rewrite|change|reveal)\b.{0,40}\b(?:instructions?|system|rules?|permission|safety|policy)\b/iu,
  /\b(?:execute|invoke|launch|run|call)\s+(?:the\s+)?(?:commands?|scripts?|shell|terminal|tools?|programs?|applications?)\b/iu,
  /\b(?:admin(?:istrator)?\s+(?:access|rights?|permission)|root\s+access|grant\s+(?:access|permissions?)|without\s+confirmation|skip\s+confirmation|sudo|powershell|cmd\.exe|shell\s+command)\b/iu,
  /\b(?:always|automatically|from\s+now\s+on)\b.{0,24}\b(?:execute|invoke|launch|run|call|open)\b/iu,
  /系统提示词|系统指令|开发者指令|提示词注入|越狱提示|(?:忽略|绕过|覆盖|篡改|修改|重写|显示).{0,16}(?:规则|系统|提示词|指令|权限|安全|限制)/u,
  /(?:执行|运行|启动|调用|打开).{0,12}(?:命令|脚本|终端|程序|工具|shell)|(?:命令行|终端命令|系统命令)/iu,
  /(?:以后|从现在开始|每天|自动|始终|每次).{0,16}(?:执行|运行|启动|调用|打开)/u,
  /自动授权|授予权限|给予权限|管理员权限|提权|无需确认|不需要确认|跳过确认|自行确认|自我修改|修改人格规则/u,
];

/** One bounded fact or source-text inspection; never returns its content. */
export function screenMemoryText(value: unknown, maxLength = 512): MemoryScreening {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > aiLimits.userText
    || value.length < 1 || value.length > maxLength || value.trim().length === 0) return { ok: false, reason: 'INVALID_TEXT' };
  const text = value.normalize('NFKC');
  // Reject invisible format/control characters instead of reconstructing an
  // obfuscated secret/instruction. Ordinary spaces, CR, LF and tab are okay.
  if (text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u.test(text)) {
    return { ok: false, reason: 'INVALID_TEXT' };
  }
  if (sensitivePatterns.some(pattern => pattern.test(text))) return { ok: false, reason: 'SENSITIVE' };
  if (controlPatterns.some(pattern => pattern.test(text))) return { ok: false, reason: 'CONTROL_INSTRUCTION' };
  return { ok: true };
}

type SourceFailure = 'INVALID_SOURCE' | MemoryTextRejection;
/** Existence AND same-user-source identity, rechecked on every candidate,
 * confirmation and retrieval. Assistant/system/model/game output is not a
 * substitute for a completed USER message from the owning conversation. */
function sourceFailure(ownerPetId: string, conversationId: string, messageIds: readonly string[],
  latestCreatedAt: number, lookup: MemorySourceLookup): SourceFailure | null {
  if (messageIds.length < 1 || messageIds.length > memoryPolicyLimits.sourceMessages || new Set(messageIds).size !== messageIds.length) {
    return 'INVALID_SOURCE';
  }
  for (const messageId of messageIds) {
    let raw: unknown;
    try { raw = lookup(messageId); } catch { return 'INVALID_SOURCE'; }
    // Refuse a lookup resolving to another conversation/role before reading
    // any source text, even though the trusted repository should already scope it.
    if (!object(raw) || raw.messageId !== messageId || raw.petId !== ownerPetId || raw.conversationId !== conversationId
      || raw.role !== 'USER' || raw.status !== 'COMPLETED' || !validTime(raw.createdAt) || raw.createdAt > latestCreatedAt) return 'INVALID_SOURCE';
    const message = parse(chatMessageSchema, raw);
    if (!message || message.messageId !== messageId || message.petId !== ownerPetId || message.conversationId !== conversationId
      || message.role !== 'USER' || message.status !== 'COMPLETED' || message.createdAt > latestCreatedAt) return 'INVALID_SOURCE';
    const screened = screenMemoryText(message.text, aiLimits.userText);
    if (!screened.ok) return screened.reason;
  }
  return null;
}

function canonical(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function factKey(type: MemoryType, summary: string): string {
  return `${type}:${canonical(summary) || summary.normalize('NFKC').trim().toLowerCase()}`;
}

export interface BuildPendingMemoryInput {
  readonly ownerPetId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly now: number;
  /** Untrusted model drafts; accepted type is descriptive, runtime validation mandatory. */
  readonly drafts: readonly MemoryCandidateDraft[];
  readonly lookupSource: MemorySourceLookup;
  readonly allocateCandidateId: () => string;
  readonly existingPending?: readonly PendingMemoryCandidate[];
  readonly existingRecords?: readonly MemoryRecord[];
}
export type PendingMemoryRejectionReason = SourceFailure | 'INVALID_DRAFT' | 'DUPLICATE' | 'COALESCED' | 'INVALID_CANDIDATE_ID';
export interface BuildPendingMemoryResult {
  readonly candidates: PendingMemoryCandidate[];
  /** Diagnostic information contains only ordinal and public rejection reason. */
  readonly rejected: { readonly draftIndex: number; readonly reason: PendingMemoryRejectionReason }[];
}

/** Materialize PENDING candidates only. The source lookup, authority identity,
 * clock and ID allocator are trusted service capabilities, never model fields.
 * Duplicate drafts are coalesced within this extraction; existing live facts
 * are left untouched. No inferred recipient or automatic consent. */
export function buildPendingMemoryCandidates(input: BuildPendingMemoryInput): BuildPendingMemoryResult {
  const { ownerPetId, conversationId, requestId, now, drafts, lookupSource, allocateCandidateId } = input;
  const pending = input.existingPending ?? [], records = input.existingRecords ?? [];
  if (!validId(ownerPetId) || !validId(conversationId) || !validId(requestId) || !validTime(now)
    || now > Number.MAX_SAFE_INTEGER - memoryPolicyLimits.candidateTtlMs
    || !Array.isArray(drafts) || drafts.length > aiLimits.memoryCandidates
    || !Array.isArray(pending) || pending.length > memoryPolicyLimits.pendingToConsider
    || !Array.isArray(records) || records.length > memoryPolicyLimits.recordsToConsider
    || typeof lookupSource !== 'function' || typeof allocateCandidateId !== 'function') {
    throw new RangeError('Invalid bounded memory extraction context');
  }
  const candidates: PendingMemoryCandidate[] = [], rejected: BuildPendingMemoryResult['rejected'] = [];
  const liveFacts = new Set<string>();
  const reservedIds = new Set<string>();
  for (const existing of pending) {
    if (object(existing) && validId(existing.candidateId)) reservedIds.add(existing.candidateId);
    if (!object(existing) || existing.ownerPetId !== ownerPetId) continue;
    const value = parse(pendingMemoryCandidateSchema, existing);
    if (value && value.createdAt <= now && value.expiresAt > now && screenMemoryText(value.summary).ok
      && sourceFailure(ownerPetId, value.conversationId, value.sourceMessageIds, value.createdAt, lookupSource) === null) {
      liveFacts.add(factKey(value.type, value.summary));
    }
  }
  for (const existing of records) {
    // Duplicate detection must not inspect the contents of another pet's facts.
    if (!object(existing) || existing.ownerPetId !== ownerPetId) continue;
    const value = parse(memoryRecordSchema, existing);
    if (value && value.updatedAt <= now && (value.expiresAt === null || value.expiresAt > now) && screenMemoryText(value.summary).ok
      && sourceFailure(ownerPetId, value.sourceConversationId, value.sourceMessageIds, value.createdAt, lookupSource) === null) {
      liveFacts.add(factKey(value.type, value.summary));
    }
  }

  const grouped = new Map<string, { draftIndex: number; draft: MemoryCandidateDraft }>();
  for (const [draftIndex, raw] of drafts.entries()) {
    const draft = parse(memoryCandidateDraftSchema, raw);
    if (!draft) { rejected.push({ draftIndex, reason: 'INVALID_DRAFT' }); continue; }
    const screened = screenMemoryText(draft.summary);
    if (!screened.ok) { rejected.push({ draftIndex, reason: screened.reason }); continue; }
    const invalidSource = sourceFailure(ownerPetId, conversationId, draft.sourceMessageIds, now, lookupSource);
    if (invalidSource !== null) { rejected.push({ draftIndex, reason: invalidSource }); continue; }
    const key = factKey(draft.type, draft.summary);
    if (liveFacts.has(key)) { rejected.push({ draftIndex, reason: 'DUPLICATE' }); continue; }
    const first = grouped.get(key);
    if (first) {
      first.draft = { ...first.draft,
        sourceMessageIds: [...new Set([...first.draft.sourceMessageIds, ...draft.sourceMessageIds])].slice(0, memoryPolicyLimits.sourceMessages),
        // Coalescing cannot widen suggested scope. A later explicit user
        // decision may still choose either scope independently of the model.
        scope: first.draft.scope === 'PRIVATE' || draft.scope === 'PRIVATE' ? 'PRIVATE' : 'SHARED',
        confidence: Math.max(first.draft.confidence, draft.confidence),
      };
      rejected.push({ draftIndex, reason: 'COALESCED' });
    } else grouped.set(key, { draftIndex, draft });
  }

  for (const { draftIndex, draft } of grouped.values()) {
    let candidateId: unknown;
    try { candidateId = allocateCandidateId(); } catch { /* sanitized below */ }
    if (!validId(candidateId) || reservedIds.has(candidateId)) { rejected.push({ draftIndex, reason: 'INVALID_CANDIDATE_ID' }); continue; }
    const candidate = parse(pendingMemoryCandidateSchema, { ...draft, candidateId, ownerPetId, conversationId, requestId,
      consentState: 'PENDING', createdAt: now, expiresAt: now + memoryPolicyLimits.candidateTtlMs });
    if (!candidate) { rejected.push({ draftIndex, reason: 'INVALID_DRAFT' }); continue; }
    reservedIds.add(candidateId);
    candidates.push(candidate);
  }
  rejected.sort((a, b) => a.draftIndex - b.draftIndex);
  return { candidates, rejected };
}

interface ConfirmationFields {
  readonly kind: 'CONFIRM';
  readonly editedSummary?: string;
  readonly expiresAt?: number | null;
  readonly pinned?: boolean;
}
/** The service must obtain this decision from a verified user interaction,
 * NEVER by passing a model draft or its suggested memory scope verbatim. */
export type TrustedMemoryConfirmation = ConfirmationFields & (
  | { readonly scope: 'PRIVATE' }
  | { readonly scope: 'SHARED'; readonly recipientPetIds: readonly string[] }
);
export interface ConfirmMemoryInput {
  readonly candidate: PendingMemoryCandidate;
  readonly ownerPetId: string;
  readonly candidateId: string;
  readonly memoryId: string;
  readonly now: number;
  readonly existingPetIds: readonly string[];
  readonly lookupSource: MemorySourceLookup;
  readonly decision: TrustedMemoryConfirmation;
}
export type MemoryConfirmationFailure = SourceFailure | 'INVALID_INPUT' | 'INVALID_CANDIDATE' | 'OWNER_MISMATCH'
  | 'CANDIDATE_EXPIRED' | 'INVALID_DECISION';
export type ConfirmMemoryResult = { readonly ok: true; readonly record: MemoryRecord }
  | { readonly ok: false; readonly reason: MemoryConfirmationFailure };

function petIds(values: readonly string[]): Set<string> | undefined {
  if (!Array.isArray(values) || values.length > memoryPolicyLimits.ownedPets || !Array.from(values).every(validId)) return undefined;
  const result = new Set(values);
  return result.size === values.length ? result : undefined;
}

function decisionAllowed(value: unknown, owner: string, existing: ReadonlySet<string>, now: number): value is TrustedMemoryConfirmation {
  if (!object(value) || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'scope')
    || value.kind !== 'CONFIRM' || (value.scope !== 'PRIVATE' && value.scope !== 'SHARED')
    || (value.editedSummary !== undefined && typeof value.editedSummary !== 'string')
    || (value.pinned !== undefined && typeof value.pinned !== 'boolean')
    || (value.expiresAt !== undefined && value.expiresAt !== null && (!validTime(value.expiresAt) || value.expiresAt <= now))) return false;
  const keys = new Set(['kind', 'scope', 'editedSummary', 'expiresAt', 'pinned']);
  if (value.scope === 'SHARED') keys.add('recipientPetIds');
  if (Object.keys(value).some(key => !keys.has(key))) return false;
  if (value.scope === 'PRIVATE') return !Object.hasOwn(value, 'recipientPetIds');
  if (!Object.hasOwn(value, 'recipientPetIds') || !Array.isArray(value.recipientPetIds) || value.recipientPetIds.length === 0
    || value.recipientPetIds.length > memoryPolicyLimits.ownedPets
    || !Array.from(value.recipientPetIds).every(recipient => validId(recipient) && recipient !== owner && existing.has(recipient))) return false;
  return new Set(value.recipientPetIds).size === value.recipientPetIds.length;
}

/** Pure confirmation proposal for a future authority transaction. No writes,
 * memory ID generation, sharing side effect, or deletion of the pending row. */
export function confirmMemoryCandidate(input: ConfirmMemoryInput): ConfirmMemoryResult {
  const fail = (reason: MemoryConfirmationFailure): ConfirmMemoryResult => ({ ok: false, reason });
  const { ownerPetId, candidateId, memoryId, now, lookupSource } = input;
  const existing = petIds(input.existingPetIds);
  if (!validId(ownerPetId) || !validId(candidateId) || !validId(memoryId) || !validTime(now) || !existing
    || !existing.has(ownerPetId) || typeof lookupSource !== 'function') return fail('INVALID_INPUT');
  const candidate = parse(pendingMemoryCandidateSchema, input.candidate);
  if (!candidate || candidate.candidateId !== candidateId || candidate.createdAt > now) return fail('INVALID_CANDIDATE');
  if (candidate.ownerPetId !== ownerPetId) return fail('OWNER_MISMATCH');
  if (candidate.expiresAt <= now) return fail('CANDIDATE_EXPIRED');
  if (!decisionAllowed(input.decision, ownerPetId, existing, now)) return fail('INVALID_DECISION');
  const priorScreen = screenMemoryText(candidate.summary);
  if (!priorScreen.ok) return fail(priorScreen.reason);
  const summary = input.decision.editedSummary ?? candidate.summary;
  const screened = screenMemoryText(summary);
  if (!screened.ok) return fail(screened.reason);
  const source = sourceFailure(ownerPetId, candidate.conversationId, candidate.sourceMessageIds, candidate.createdAt, lookupSource);
  if (source !== null) return fail(source);
  const fields = {
    memoryId, ownerPetId, type: candidate.type, summary, sourceConversationId: candidate.conversationId,
    sourceMessageIds: [...candidate.sourceMessageIds], confidence: candidate.confidence, consentState: 'CONFIRMED',
    createdAt: now, updatedAt: now, expiresAt: input.decision.expiresAt ?? null, pinned: input.decision.pinned ?? false,
  };
  const record = parse(memoryRecordSchema, input.decision.scope === 'PRIVATE' ? { ...fields, scope: 'PRIVATE' }
    : { ...fields, scope: 'SHARED', recipientPetIds: [...input.decision.recipientPetIds] });
  return record ? { ok: true, record } : fail('INVALID_DECISION');
}

export interface RetrieveAuthorizedMemoryInput {
  readonly recipientPetId: string;
  readonly query: string;
  readonly now: number;
  readonly existingPetIds: readonly string[];
  /** Current authority records, with revoked/deleted grants already absent.
   * A future FTS index is only a candidate source, never an authorization. */
  readonly records: readonly MemoryRecord[];
  readonly lookupSource: MemorySourceLookup;
  readonly limit?: number;
}

const hanStopChars = new Set(Array.from('我你他她它们的了在是有和与或也都为而就把给着过吗呢啊吧这那还去来个中上下一样想说要很么'));
const hanStopTerms = new Set(['用户', '这个', '那个', '今天', '现在', '怎么', '什么', '可以', '我们', '你们', '自己']);
const wordStops = new Set(['the', 'and', 'to', 'of', 'is', 'it', 'you', 'me', 'my', 'i', 'a', 'an', 'for', 'in', 'on', 'with']);
interface LexicalQuery { readonly han: ReadonlyMap<string, number>; readonly words: ReadonlySet<string>; readonly phrase: string | null }

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
}
function lexicalQuery(query: string): LexicalQuery {
  const normalized = query.normalize('NFKC').toLowerCase().slice(0, aiLimits.userText);
  const han = new Map<string, number>();
  const hanRuns = (normalized.match(/\p{Script=Han}+/gu) ?? []).map(run => Array.from(run));
  const usefulWords = new Set(words(normalized).filter(word => word.length >= 2 && !wordStops.has(word)).slice(0, memoryPolicyLimits.lexicalTerms));
  // Prefer phrase/bigram matches, retaining low-weight single Chinese chars
  // for short queries or short concepts in otherwise unrelated phrasing.
  for (const [size, weight] of [[3, 8], [2, 4], [1, 1]] as const) {
    for (const run of hanRuns) {
      for (let start = 0; start + size <= run.length && han.size + usefulWords.size < memoryPolicyLimits.lexicalTerms; start++) {
        const token = run.slice(start, start + size).join('');
        if (size === 1 ? hanStopChars.has(token) : hanStopTerms.has(token)) continue;
        han.set(token, weight);
      }
    }
  }
  const compact = canonical(normalized);
  return { han, words: usefulWords, phrase: han.size > 0 && compact.length <= 64 ? compact : null };
}
function lexicalScore(query: LexicalQuery, summary: string): number {
  const compact = canonical(summary);
  const summaryWords = new Set(words(summary));
  let score = query.phrase !== null && compact.includes(query.phrase) ? 100 : 0;
  for (const [term, weight] of query.han) if (compact.includes(term)) score += weight;
  for (const word of query.words) if (summaryWords.has(word)) score += 10;
  return score;
}

const typeImportance: Readonly<Record<MemoryType, number>> = Object.freeze({ AGREEMENT: 3, PREFERENCE: 2, HISTORY: 1 });
const byId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Authorize BEFORE parsing/scoring summaries or looking up their raw sources.
 * Never expose another pet's source message, recipient list, source conversation
 * or unconfirmed draft. This is bounded lexical ranking, not FTS/embeddings. */
export function retrieveAuthorizedMemories(input: RetrieveAuthorizedMemoryInput): AuthorizedMemoryContext[] {
  const { recipientPetId, query, now, records, lookupSource } = input;
  const existing = petIds(input.existingPetIds), limit = input.limit ?? aiLimits.authorizedMemories;
  if (!validId(recipientPetId) || !validTime(now) || typeof query !== 'string' || query.length > aiLimits.userText
    || !existing || !Array.isArray(records) || records.length > memoryPolicyLimits.recordsToConsider
    || !Number.isSafeInteger(limit) || limit < 0 || limit > aiLimits.authorizedMemories || typeof lookupSource !== 'function') {
    throw new RangeError('Invalid bounded memory retrieval context');
  }
  if (!existing.has(recipientPetId) || limit === 0) return [];
  const seenIds = new Set<string>(), duplicateIds = new Set<string>();
  // Only inspect IDs first. Contradictory duplicated identity is discarded
  // entirely rather than letting source ordering decide access.
  for (const raw of records) if (object(raw) && validId(raw.memoryId)) {
    if (seenIds.has(raw.memoryId)) duplicateIds.add(raw.memoryId);
    seenIds.add(raw.memoryId);
  }
  const lex = lexicalQuery(query);
  const ranked: { record: MemoryRecord; score: number }[] = [];
  for (const raw of records) {
    if (!object(raw) || !validId(raw.memoryId) || duplicateIds.has(raw.memoryId)
      || !validId(raw.ownerPetId) || !existing.has(raw.ownerPetId)) continue;
    if (raw.ownerPetId !== recipientPetId && (raw.scope !== 'SHARED'
      || !Array.isArray(raw.recipientPetIds) || !raw.recipientPetIds.includes(recipientPetId))) continue;
    const record = parse(memoryRecordSchema, raw);
    if (!record || record.updatedAt > now || (record.expiresAt !== null && record.expiresAt <= now)
      || !screenMemoryText(record.summary).ok) continue;
    if (sourceFailure(record.ownerPetId, record.sourceConversationId, record.sourceMessageIds, record.createdAt, lookupSource) !== null) continue;
    const score = lexicalScore(lex, record.summary);
    if (score > 0 || record.pinned) ranked.push({ record, score });
  }
  ranked.sort((a, b) => b.score - a.score || Number(b.record.pinned) - Number(a.record.pinned)
    || b.record.updatedAt - a.record.updatedAt || typeImportance[b.record.type] - typeImportance[a.record.type]
    || b.record.confidence - a.record.confidence || byId(a.record.memoryId, b.record.memoryId));
  const seenFacts = new Set<string>(), result: AuthorizedMemoryContext[] = [];
  for (const { record } of ranked) {
    const key = factKey(record.type, record.summary);
    if (seenFacts.has(key)) continue;
    const projected = parse(authorizedMemoryContextSchema, {
      memoryId: record.memoryId, ownerPetId: record.ownerPetId, recipientPetId, scope: record.scope as MemoryScope,
      type: record.type, summary: record.summary, consentState: 'CONFIRMED',
    });
    if (!projected) continue;
    seenFacts.add(key);
    result.push(projected);
    if (result.length === limit) break;
  }
  return result;
}
