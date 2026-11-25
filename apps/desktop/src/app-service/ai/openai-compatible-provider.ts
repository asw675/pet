import { aiLimits, aiUsageSchema, chatReplySchema, providerOutputSchema } from '@pet-desktop/contracts/ai';
import type { AiErrorCode, AiUsage, ProviderConfig, ProviderOutput, ProviderRequest } from '@pet-desktop/contracts/ai';
import {
  ModelProviderError, cancelledOutput, providerFailure, turnIdentity, validateInvocation,
} from './model-provider';
import type { ModelProvider, TurnIdentity } from './model-provider';
import { compilePrompt, providerReplyJsonSchema } from './prompt-context';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface OpenAiCompatibleProviderOptions {
  fetch?: Fetcher;
  now?: () => number;
  idleTimeoutMs?: number;
}

export const providerTransportLimits = Object.freeze({ responseBytes: 256 * 1024, structuredChars: 64 * 1024,
  sseEventChars: 64 * 1024, sseEvents: 4096 });
const ABORTED = Symbol('request aborted');

function fail(code: AiErrorCode): never { throw new ModelProviderError(code); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return fail('INVALID_RESPONSE'); }
}

/** A known broker credential may not be echoed in prompt or model output.
 * This is an exact-value guard, not a general sensitive-data classifier. */
function includesCredential(value: unknown, credential: string | null): boolean {
  if (credential === null) return false;
  if (typeof value === 'string') return value.includes(credential);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(entry => includesCredential(entry, credential));
}

/** The cancellation race is on the consumer side too, even if a transport or
 * test double fails to settle promptly when its AbortSignal is aborted. */
function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const complete = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = () => complete(() => reject(ABORTED));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => complete(() => resolve(value)), error => complete(() => reject(error)));
    if (signal.aborted) abort();
  });
}

class Lifetime {
  readonly controller = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  timedOut = false;
  private readonly externalAbort = () => this.controller.abort();

  constructor(private readonly external: AbortSignal, timeoutMs: number, private readonly idleTimeoutMs: number) {
    external.addEventListener('abort', this.externalAbort, { once: true });
    if (external.aborted) this.externalAbort();
    this.deadlineTimer = setTimeout(() => this.expire(), timeoutMs);
    this.progress();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  check(): void { if (this.signal.aborted) throw ABORTED; }
  private expire(): void {
    if (this.signal.aborted) return;
    this.timedOut = true;
    this.controller.abort();
  }
  progress(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    if (!this.signal.aborted) this.idleTimer = setTimeout(() => this.expire(), this.idleTimeoutMs);
  }
  close(): void {
    clearTimeout(this.deadlineTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.external.removeEventListener('abort', this.externalAbort);
  }
}

function discardBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* resource cleanup is best effort */ }
}

/** Reads bounded UTF-8 incrementally, including partial multibyte characters
 * spanning network chunks. `consume` returns true for a complete terminal. */
async function readBody(response: Response, lifetime: Lifetime, consume: (chunk: string) => boolean): Promise<void> {
  if (response.body === null) return fail('INVALID_RESPONSE');
  const advertised = response.headers.get('content-length');
  if (advertised !== null && /^\d+$/u.test(advertised) && Number(advertised) > providerTransportLimits.responseBytes) {
    discardBody(response);
    return fail('TRUNCATED');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, eof = false;
  try {
    while (true) {
      lifetime.check();
      let read: Awaited<ReturnType<typeof reader.read>>;
      try { read = await raceAbort(reader.read(), lifetime.signal); }
      catch (error) { if (lifetime.signal.aborted) throw ABORTED; throw new ModelProviderError('NETWORK'); }
      lifetime.check();
      if (read.done) {
        eof = true;
        let tail: string;
        try { tail = decoder.decode(); } catch { return fail('INVALID_RESPONSE'); }
        if (tail.length > 0) consume(tail);
        return;
      }
      if (!(read.value instanceof Uint8Array)) return fail('INVALID_RESPONSE');
      if (read.value.byteLength > 0) lifetime.progress();
      bytes += read.value.byteLength;
      if (bytes > providerTransportLimits.responseBytes) return fail('TRUNCATED');
      let chunk: string;
      try { chunk = decoder.decode(read.value, { stream: true }); } catch { return fail('INVALID_RESPONSE'); }
      if (chunk.length > 0 && consume(chunk)) return;
    }
  } finally {
    if (!eof) { try { void reader.cancel().catch(() => undefined); } catch { /* a cancelled read must not delay reply */ } }
    try { reader.releaseLock(); } catch { /* pending underlying read may not yet settle on abort */ }
  }
}

async function readJsonBody(response: Response, lifetime: Lifetime): Promise<unknown> {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'application/json' && !mime?.endsWith('+json')) { discardBody(response); return fail('INVALID_RESPONSE'); }
  let json = '';
  await readBody(response, lifetime, chunk => { json += chunk; return false; });
  return parseJson(json);
}

function providerCode(raw: unknown): AiErrorCode | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const code = typeof fields.code === 'string' ? fields.code : typeof fields.type === 'string' ? fields.type : '';
  if (['context_length_exceeded', 'context_window_exceeded', 'max_tokens_exceeded'].includes(code)) return 'CONTEXT_LIMIT';
  if (['rate_limit_exceeded', 'rate_limit_error'].includes(code)) return 'RATE_LIMITED';
  if (['invalid_api_key', 'authentication_error'].includes(code)) return 'AUTH_REQUIRED';
  return null;
}

async function httpFailure(response: Response, lifetime: Lifetime): Promise<never> {
  const status = response.status;
  if (status === 400) {
    try {
      const result = object(await readJsonBody(response, lifetime));
      return fail(providerCode(result.error) ?? 'INVALID_RESPONSE');
    } catch (error) {
      if (lifetime.signal.aborted) throw ABORTED;
      if (error instanceof ModelProviderError) throw error;
      return fail('INVALID_RESPONSE');
    }
  }
  discardBody(response);
  if (status === 401 || status === 403) return fail('AUTH_REQUIRED');
  if (status === 429) return fail('RATE_LIMITED');
  if (status === 408 || status === 504) return fail('TIMEOUT');
  if (status === 413) return fail('CONTEXT_LIMIT');
  if (status === 404 || status === 405) return fail('UNSUPPORTED');
  if (status >= 500 && status <= 599) return fail('UNAVAILABLE');
  return fail(status >= 300 && status < 400 ? 'NETWORK' : 'INVALID_RESPONSE');
}

function readUsage(raw: unknown, config: ProviderConfig, request: ProviderRequest): AiUsage | null {
  if (!config.capabilities.usage || raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.completion_tokens === 'number' && Number.isSafeInteger(value.completion_tokens)
    && value.completion_tokens > request.maxOutputTokens) return fail('TRUNCATED');
  const result = aiUsageSchema.safeParse({ inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens });
  if (!result.success) return null; // Never substitute an estimated token count.
  if (result.data.outputTokens > request.maxOutputTokens) return fail('TRUNCATED');
  return result.data;
}

function checkNoToolsOrRefusal(message: Record<string, unknown>): void {
  if (message.refusal !== undefined && message.refusal !== null && message.refusal !== '') return fail('REFUSED');
  if (message.function_call !== undefined && message.function_call !== null) return fail('INVALID_RESPONSE');
  if (message.tool_calls !== undefined && message.tool_calls !== null
    && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) return fail('INVALID_RESPONSE');
}

function checkFinish(reason: unknown, streaming: boolean): boolean {
  if (streaming && reason === null) return false;
  if (reason === 'stop') return true;
  if (reason === 'length') return fail('TRUNCATED');
  if (reason === 'content_filter') return fail('REFUSED');
  if (reason === 'tool_calls' || reason === 'function_call') return fail('INVALID_RESPONSE');
  return fail(streaming ? 'INVALID_RESPONSE' : 'TRUNCATED');
}

function validUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Delimit SSE lines without assuming chunk boundaries; CR/LF/CRLF and
 * comments/multi-line data are accepted. Never dispatch an unfinished event. */
class SseParser {
  private line = '';
  private data: string[] = [];
  private aggregateChars = 0;
  private events = 0;
  private skipLf = false;
  private terminal = false;

  constructor(private readonly handle: (data: string) => boolean) {}

  consume(chunk: string): boolean {
    for (const char of chunk) {
      if (this.skipLf) { this.skipLf = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') {
        this.finishLine();
        this.skipLf = char === '\r';
        if (this.terminal) return true;
      } else {
        this.line += char;
        if (this.line.length > providerTransportLimits.sseEventChars) return fail('TRUNCATED');
      }
    }
    return this.terminal;
  }

  private finishLine(): void {
    const line = this.line;
    this.line = '';
    if (line.length === 0) {
      if (this.data.length === 0) return;
      if (++this.events > providerTransportLimits.sseEvents) return fail('TRUNCATED');
      const payload = this.data.join('\n');
      this.data = [];
      this.aggregateChars = 0;
      this.terminal = this.handle(payload);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.aggregateChars += value.length + 1;
    if (this.aggregateChars > providerTransportLimits.sseEventChars) return fail('TRUNCATED');
    this.data.push(value);
  }
}

/** JSON can carry escaped UTF-16 halves in adjacent deltas. Do not present an
 * unmatched surrogate or split a valid pair when limiting public fragments. */
class TextStream {
  private text = '';
  private highTail = '';
  private emittedChars = 0;
  constructor(private readonly lifetime: Lifetime, private readonly credential: string | null,
    private readonly emit?: (delta: string) => void) {}

  append(fragment: string): void {
    let next = this.highTail + fragment;
    this.highTail = '';
    const last = next.charCodeAt(next.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { this.highTail = next.slice(-1); next = next.slice(0, -1); }
    if (!validUtf16(next)) return fail('INVALID_RESPONSE');
    if (this.text.length + next.length + this.highTail.length > aiLimits.replyText) return fail('TRUNCATED');
    this.text += next;
    if (includesCredential(this.text, this.credential)) return fail('INVALID_RESPONSE');
    if (!this.emit || next.length === 0) return;
    // Keep only a suffix that *could* complete the actual key in a later
    // delta. Other text remains immediately streamable. The total reply is
    // bounded to 8,000 UTF-16 units, and the credential is ASCII-only.
    let hold = 0;
    if (this.credential !== null) {
      for (let length = Math.min(this.text.length, this.credential.length - 1); length > 0; length--) {
        if (this.credential.startsWith(this.text.slice(-length))) { hold = length; break; }
      }
    }
    this.emitThrough(this.text.length - hold);
  }

  private emitThrough(end: number): void {
    if (!this.emit || end <= this.emittedChars) return;
    const next = this.text.slice(this.emittedChars, end);
    this.emittedChars = end;
    let delta = '';
    const send = (value: string) => {
      this.lifetime.check();
      try { this.emit?.(value); } catch { return fail('INTERNAL_ERROR'); }
      this.lifetime.check();
    };
    for (const char of next) {
      if (delta.length + char.length > aiLimits.deltaText) { send(delta); delta = ''; }
      delta += char;
    }
    if (delta.length > 0) send(delta);
  }

  finish(): string {
    if (this.highTail.length > 0 || this.text.trim().length === 0) return fail('INVALID_RESPONSE');
    this.emitThrough(this.text.length);
    return this.text;
  }
}

async function readStream(response: Response, config: ProviderConfig, request: ProviderRequest, identity: TurnIdentity,
  lifetime: Lifetime, credential: string | null, onTextDelta?: (delta: string) => void): Promise<ProviderOutput> {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'text/event-stream') { discardBody(response); return fail('INVALID_RESPONSE'); }
  const text = new TextStream(lifetime, credential, onTextDelta);
  let finished = false, done = false;
  let usage: AiUsage | null = null;
  const parser = new SseParser(payload => {
    lifetime.check();
    if (payload === '[DONE]') {
      if (!finished) return fail('TRUNCATED');
      done = true;
      return true;
    }
    const result = object(parseJson(payload));
    if (result.error !== undefined && result.error !== null) return fail(providerCode(result.error) ?? 'UNAVAILABLE');
    if (!Array.isArray(result.choices)) return fail('INVALID_RESPONSE');
    const nextUsage = readUsage(result.usage, config, request);
    if (nextUsage !== null) usage = nextUsage;
    if (result.choices.length === 0) {
      if (!finished || result.usage === undefined || result.usage === null) return fail('INVALID_RESPONSE');
      return false;
    }
    if (finished || result.choices.length !== 1) return fail('INVALID_RESPONSE');
    const choice = object(result.choices[0]);
    if (choice.index !== 0) return fail('INVALID_RESPONSE');
    const delta = object(choice.delta);
    if (delta.role !== undefined && delta.role !== 'assistant') return fail('INVALID_RESPONSE');
    checkNoToolsOrRefusal(delta);
    // Refusal/truncation/tool claims take precedence over this event's text.
    const last = checkFinish(choice.finish_reason, true);
    const content = delta.content;
    if (content !== undefined && content !== null) {
      if (typeof content !== 'string') return fail('INVALID_RESPONSE');
      text.append(content);
    }
    finished = last;
    return false;
  });
  await readBody(response, lifetime, chunk => parser.consume(chunk));
  lifetime.check();
  if (!done) return fail('TRUNCATED');
  return providerOutputSchema.parse({ ...identity, kind: 'TEXT', text: text.finish(), usage });
}

async function readCompletion(response: Response, config: ProviderConfig, request: ProviderRequest, identity: TurnIdentity,
  lifetime: Lifetime, credential: string | null): Promise<ProviderOutput> {
  const result = object(await readJsonBody(response, lifetime));
  lifetime.check();
  if (result.error !== undefined && result.error !== null) return fail(providerCode(result.error) ?? 'INVALID_RESPONSE');
  if (!Array.isArray(result.choices) || result.choices.length !== 1) return fail('INVALID_RESPONSE');
  const choice = object(result.choices[0]);
  if (choice.index !== 0) return fail('INVALID_RESPONSE');
  const message = object(choice.message);
  if (message.role !== 'assistant') return fail('INVALID_RESPONSE');
  checkNoToolsOrRefusal(message);
  checkFinish(choice.finish_reason, false);
  const content = message.content;
  if (typeof content !== 'string' || !validUtf16(content) || content.trim().length === 0) return fail('INVALID_RESPONSE');
  if (includesCredential(content, credential)) return fail('INVALID_RESPONSE');
  const usage = readUsage(result.usage, config, request);
  if (request.outputMode === 'TEXT') {
    if (content.length > aiLimits.replyText) return fail('TRUNCATED');
    return providerOutputSchema.parse({ ...identity, kind: 'TEXT', text: content, usage });
  }
  if (content.length > providerTransportLimits.structuredChars) return fail('TRUNCATED');
  const reply = chatReplySchema.safeParse(parseJson(content));
  if (!reply.success || includesCredential(reply.data, credential)) return fail('INVALID_RESPONSE');
  return providerOutputSchema.parse({ ...identity, kind: 'STRUCTURED', reply: reply.data, usage });
}

/** Small Chat Completions REST subset. It deliberately is not the official
 * Responses endpoint or SDK and never switches to another provider on error. */
export class OpenAiCompatibleProvider implements ModelProvider {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    const idleTimeout = options.idleTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 60_000) throw new RangeError('Invalid provider idle timeout');
    this.idleTimeoutMs = idleTimeout;
  }

  async generate(rawConfig: ProviderConfig, rawRequest: ProviderRequest, credential: string | null,
    signal: AbortSignal, onTextDelta?: (delta: string) => void): Promise<ProviderOutput> {
    const identity = turnIdentity(rawRequest);
    if (signal.aborted) return cancelledOutput(identity, signal);
    let lifetime: Lifetime | undefined;
    try {
      const start = this.now();
      const { config, request, timeoutMs } = validateInvocation(rawConfig, rawRequest, credential, 'OPENAI_COMPATIBLE', start);
      if (config.baseUrl === null) return fail('UNSUPPORTED');
      const prompt = compilePrompt(config, request);
      const remaining = Math.min(timeoutMs - Math.max(0, this.now() - start), request.turn.deadline - this.now());
      if (!Number.isFinite(remaining) || remaining <= 0) return fail('TIMEOUT');
      const streaming = request.outputMode === 'TEXT' && config.capabilities.streamText;
      const body = { model: config.modelId, messages: prompt.messages, max_completion_tokens: request.maxOutputTokens,
        stream: streaming, ...(streaming && config.capabilities.usage ? { stream_options: { include_usage: true } } : {}),
        ...(request.outputMode === 'JSON' ? { response_format: { type: 'json_object' } } : {}),
        ...(request.outputMode === 'STRUCTURED' ? { response_format: { type: 'json_schema',
          json_schema: { name: 'pet_chat_reply', strict: true, schema: providerReplyJsonSchema() } } } : {}),
      };
      if (includesCredential(body, credential)) return fail('UNSUPPORTED');
      lifetime = new Lifetime(signal, remaining, Math.min(this.idleTimeoutMs, remaining));
      lifetime.check();
      const endpoint = config.baseUrl.replace(/\/$/u, '') + '/chat/completions';
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: streaming ? 'text/event-stream' : 'application/json' };
      if (credential !== null) headers.Authorization = `Bearer ${credential}`;
      let response: Response;
      try {
        const requestSignal = lifetime.signal;
        const responsePromise = this.fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(body),
          signal: requestSignal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
          .then(value => { if (requestSignal.aborted) discardBody(value); return value; });
        response = await raceAbort(responsePromise, requestSignal);
      } catch {
        if (lifetime.signal.aborted) throw ABORTED;
        return fail('NETWORK');
      }
      lifetime.check();
      lifetime.progress();
      if (response.redirected) { discardBody(response); return fail('NETWORK'); }
      if (!response.ok) return await httpFailure(response, lifetime);
      const output = streaming ? await readStream(response, config, request, identity, lifetime, credential, onTextDelta)
        : await readCompletion(response, config, request, identity, lifetime, credential);
      lifetime.check();
      return output;
    } catch (error) {
      if (lifetime?.timedOut) return providerFailure(identity, 'TIMEOUT');
      if (signal.aborted) return cancelledOutput(identity, signal);
      return providerFailure(identity, error instanceof ModelProviderError ? error.code : 'INTERNAL_ERROR');
    } finally {
      lifetime?.close();
    }
  }
}
