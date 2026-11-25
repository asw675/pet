import { randomUUID } from 'node:crypto';
import { idSchema, ipcRequestSchema, ipcResultSchema } from '@pet-desktop/contracts';
import type { IpcErrorCode, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import type { DesktopRole } from '../shared/protocol';

export type WindowBinding = {
  readonly senderId: number;
  readonly trustedUrl: string;
} & (
  | { readonly role: 'control-center' }
  | { readonly role: 'pet'; readonly petId: string }
);

export interface SenderContext {
  readonly senderId: number;
  readonly isMainFrame: boolean;
  readonly frameUrl: string;
  readonly documentUrl: string;
}

/** Hash routing changes only the control-center's same-document view. */
export function isTrustedDocument(binding: WindowBinding, actualUrl: string): boolean {
  return (binding.role === 'control-center' ? actualUrl.split('#', 1)[0] : actualUrl) === binding.trustedUrl;
}

export function authorizeSender(
  binding: WindowBinding | undefined,
  sender: SenderContext,
  role?: DesktopRole,
): binding is WindowBinding {
  return binding !== undefined
    && binding.senderId === sender.senderId
    && sender.isMainFrame
    && isTrustedDocument(binding, sender.frameUrl)
    && isTrustedDocument(binding, sender.documentUrl)
    && (role === undefined || binding.role === role);
}

export function authorizeRequest(binding: WindowBinding, request: IpcRequest): boolean {
  if (request.method === 'snapshot/get' || binding.role === 'control-center') return true;
  const { command } = request.payload;
  return (command.type === 'PET_INTERACT' || command.type === 'PET_SET_VISIBILITY')
    && command.payload.petId === binding.petId;
}

const publicMessages = {
  INVALID_REQUEST: 'Invalid request.',
  FORBIDDEN: 'Request is forbidden for this window.',
  SERVICE_UNAVAILABLE: 'The application service is not available.',
  INTERNAL_ERROR: 'The request could not be completed.',
} satisfies Partial<Record<IpcErrorCode, string>>;

function failure(requestId: string, code: keyof typeof publicMessages): IpcResult {
  return {
    schemaVersion: 1, ok: false,
    error: { requestId, code, message: publicMessages[code], retryable: code === 'SERVICE_UNAVAILABLE' },
  };
}

/** Only a schema-valid ID can be echoed from a rejected request. */
function recoverId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'requestId' in value) {
    const id = idSchema.safeParse(value.requestId);
    if (id.success) return id.data;
  }
  return randomUUID();
}

/** Each call has its own upstream correlation ID; a renderer cannot choose it. */
export async function routeRequest(
  binding: WindowBinding | undefined,
  sender: SenderContext,
  args: readonly unknown[],
  relay: (request: IpcRequest) => Promise<IpcResult>,
): Promise<IpcResult> {
  const requestId = recoverId(args[0]);
  if (!authorizeSender(binding, sender)) return failure(requestId, 'FORBIDDEN');
  const parsed = ipcRequestSchema.safeParse(args[0]);
  if (args.length !== 1 || !parsed.success) return failure(requestId, 'INVALID_REQUEST');
  if (!authorizeRequest(binding, parsed.data)) return failure(requestId, 'FORBIDDEN');

  const upstreamId = randomUUID();
  try {
    const raw = await relay({ ...parsed.data, requestId: upstreamId });
    const result = ipcResultSchema.safeParse(raw);
    if (!result.success) return failure(requestId, 'INTERNAL_ERROR');
    if (result.data.ok) {
      if (result.data.requestId !== upstreamId) return failure(requestId, 'INTERNAL_ERROR');
      return { ...result.data, requestId };
    }
    if (result.data.error.requestId !== upstreamId) return failure(requestId, 'INTERNAL_ERROR');
    return { ...result.data, error: { ...result.data.error, requestId } };
  } catch {
    return failure(requestId, 'SERVICE_UNAVAILABLE');
  }
}
