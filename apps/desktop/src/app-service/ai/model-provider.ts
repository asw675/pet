import {
  aiCancelReasonSchema, chatReplySchema, providerConfigSchema, providerOutputSchema, providerRequestSchema,
} from '@pet-desktop/contracts/ai';
import type {
  AiCancelReason, AiError, AiErrorCode, EndpointKind, ProviderConfig, ProviderOutput, ProviderRequest,
} from '@pet-desktop/contracts/ai';

/** Provider implementations receive trusted configuration and an ephemeral
 * broker-resolved credential. Neither is taken from model or user message text. */
export interface ModelProvider {
  generate(config: ProviderConfig, request: ProviderRequest, credential: string | null,
    signal: AbortSignal, onTextDelta?: (delta: string) => void): Promise<ProviderOutput>;
}

export interface TurnIdentity { requestId: string; petId: string; conversationId: string }

// No upstream error string, URL, stack or request body is exposed to a caller.
const publicErrors: Readonly<Record<AiErrorCode, { message: string; retryable: boolean }>> = Object.freeze({
  AUTH_REQUIRED: { message: 'Provider authentication is required or was rejected.', retryable: false },
  RATE_LIMITED: { message: 'Provider rate limit reached.', retryable: true },
  CONTEXT_LIMIT: { message: 'The conversation exceeds the allowed context budget.', retryable: false },
  TIMEOUT: { message: 'Provider response timed out.', retryable: true },
  NETWORK: { message: 'Provider network request failed.', retryable: true },
  UNAVAILABLE: { message: 'Provider is unavailable.', retryable: true },
  UNSUPPORTED: { message: 'The configured provider or response mode is unsupported.', retryable: false },
  INVALID_RESPONSE: { message: 'Provider returned an invalid response.', retryable: false },
  REFUSED: { message: 'Provider did not produce this response.', retryable: false },
  TRUNCATED: { message: 'The response ended before completion.', retryable: false },
  INTERNAL_ERROR: { message: 'The AI response could not be processed.', retryable: false },
});

export class ModelProviderError extends Error {
  constructor(readonly code: AiErrorCode) { super(code); this.name = 'ModelProviderError'; }
}

export function publicAiError(code: AiErrorCode): AiError { return { code, ...publicErrors[code] }; }

function safeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : fallback;
}

export function turnIdentity(request: unknown): TurnIdentity {
  const turn = request !== null && typeof request === 'object' && 'turn' in request ? request.turn : undefined;
  const fields = turn !== null && typeof turn === 'object' ? turn as Record<string, unknown> : {};
  return { requestId: safeId(fields.requestId, 'invalid-request'), petId: safeId(fields.petId, 'invalid-pet'),
    conversationId: safeId(fields.conversationId, 'invalid-conversation') };
}

export function providerFailure(identity: TurnIdentity, code: AiErrorCode): ProviderOutput {
  return providerOutputSchema.parse({ ...identity, kind: 'ERROR', error: publicAiError(code) });
}

export function cancellationReason(signal: AbortSignal): AiCancelReason {
  const parsed = aiCancelReasonSchema.safeParse(signal.reason);
  return parsed.success ? parsed.data : 'USER';
}

export function cancelledOutput(identity: TurnIdentity, signal: AbortSignal): ProviderOutput {
  return providerOutputSchema.parse({ ...identity, kind: 'CANCELLED', reason: cancellationReason(signal) });
}

export interface ValidatedInvocation {
  config: ProviderConfig;
  request: ProviderRequest;
  timeoutMs: number;
}

/** Independent defensive check at the actual network/provider boundary. A
 * stale model or response mode never silently switches provider or endpoint. */
export function validateInvocation(rawConfig: ProviderConfig, rawRequest: ProviderRequest, credential: string | null,
  kind: EndpointKind, now: number): ValidatedInvocation {
  const configResult = providerConfigSchema.safeParse(rawConfig), requestResult = providerRequestSchema.safeParse(rawRequest);
  if (!configResult.success || !requestResult.success) throw new ModelProviderError('UNSUPPORTED');
  const config = configResult.data, request = requestResult.data;
  if (config.endpointKind !== kind || config.providerId !== request.providerId || config.modelId !== request.modelId
    || request.maxOutputTokens > config.maxOutputTokens) throw new ModelProviderError('UNSUPPORTED');
  if (request.outputMode === 'STRUCTURED' && !config.capabilities.nativeStructured
    || request.outputMode === 'JSON' && !config.capabilities.jsonMode) throw new ModelProviderError('UNSUPPORTED');
  if (config.credentialRef === null) {
    // Never send a credential accidentally resolved for a different provider.
    if (credential !== null) throw new ModelProviderError('AUTH_REQUIRED');
  } else if (typeof credential !== 'string' || credential.length === 0 || credential.length > 8192
    || /[^\x21-\x7e]/u.test(credential)) throw new ModelProviderError('AUTH_REQUIRED');
  if (!Number.isFinite(now) || now < 0) throw new ModelProviderError('INTERNAL_ERROR');
  const timeoutMs = Math.min(config.timeoutMs, request.turn.deadline - now);
  if (timeoutMs <= 0) throw new ModelProviderError('TIMEOUT');
  return { config, request, timeoutMs };
}

/** Explicitly labeled local fixture. No hidden substitute for a failed cloud
 * provider, no estimated or invented actual model usage, and no game effects. */
export class MockModelProvider implements ModelProvider {
  constructor(private readonly now: () => number = Date.now) {}

  async generate(config: ProviderConfig, request: ProviderRequest, credential: string | null,
    signal: AbortSignal, onTextDelta?: (delta: string) => void): Promise<ProviderOutput> {
    const identity = turnIdentity(request);
    if (signal.aborted) return cancelledOutput(identity, signal);
    try {
      const validated = validateInvocation(config, request, credential, 'MOCK', this.now());
      const turn = validated.request.turn;
      const text = `【本地模拟回复】${turn.context.persona.displayName}在这里陪伴你。`;
      if (validated.request.outputMode === 'TEXT') {
        if (validated.config.capabilities.streamText) onTextDelta?.(text);
        if (signal.aborted) return cancelledOutput(identity, signal);
        return providerOutputSchema.parse({ ...identity, kind: 'TEXT', text, usage: null });
      }
      const reply = chatReplySchema.parse({ text, emotion: 'calm',
        motionIntent: turn.context.persona.allowedMotionIds.includes('idle') ? 'idle' : null,
        actionProposals: [], memoryCandidates: [] });
      return providerOutputSchema.parse({ ...identity, kind: 'STRUCTURED', reply, usage: null });
    } catch (error) {
      if (signal.aborted) return cancelledOutput(identity, signal);
      return providerFailure(identity, error instanceof ModelProviderError ? error.code : 'INTERNAL_ERROR');
    }
  }
}
