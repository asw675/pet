import {
  CONTRACT_SCHEMA_VERSION, appSnapshotSchema, galleryIpcResultSchema, ipcRequestSchema,
  resultMatchesMethod, snapshotIpcResultSchema,
} from '@pet-desktop/contracts';
import type {
  AppSnapshot, DomainCommand, GalleryIpcResult, GalleryQuery, IpcErrorCode, IpcRequest,
  IpcResult, SnapshotIpcResult,
} from '@pet-desktop/contracts';
import {
  DESKTOP_IPC, hostActionResultSchema, petVisualReadySchema, serviceStatusSchema,
} from '../shared/protocol.js';
import type {
  ControlCenterBridge, DesktopBridgeBase, HostActionResult, PetDesktopBridge, PetVisualReady, ServiceStatus,
} from '../shared/protocol.js';

type InvokeChannel = typeof DESKTOP_IPC.request | typeof DESKTOP_IPC.getStatus
  | typeof DESKTOP_IPC.openControlCenter | typeof DESKTOP_IPC.petInteractive
  | typeof DESKTOP_IPC.petVisualReady;
type PushChannel = typeof DESKTOP_IPC.snapshot | typeof DESKTOP_IPC.status;
type PushListener = (event: unknown, ...args: unknown[]) => void;

/** Internal transport seam; only the explicit bridge below crosses contextBridge. */
export interface DesktopIpcPort {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>;
  on(channel: PushChannel, listener: PushListener): unknown;
  removeListener(channel: PushChannel, listener: PushListener): unknown;
}

type Parser<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
};

function parse<T>(schema: Parser<T>, value: unknown): T | undefined {
  try {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** WebCrypto works in a sandboxed preload without loading a Node builtin. */
function newRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `request-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const publicMessages: Record<IpcErrorCode, string> = {
  INVALID_REQUEST: 'Invalid application request.',
  FORBIDDEN: 'This operation is not permitted.',
  NOT_FOUND: 'The requested resource does not exist.',
  REVISION_CONFLICT: 'Game state has changed. Refresh the snapshot first.',
  COMMAND_CONFLICT: 'This command ID has already been used.',
  BUSINESS_RULE: 'The operation is not allowed in the current game state.',
  SERVICE_UNAVAILABLE: 'The application service is unavailable.',
  TIMEOUT: 'The application request timed out.',
  INTERNAL_ERROR: 'The application could not complete the operation.',
};

function failure(requestId: string, code: IpcErrorCode, retryable: boolean): Extract<IpcResult, { ok: false }> {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    ok: false,
    error: { requestId, code, retryable, message: publicMessages[code] },
  };
}

/** Each subscription owns its own wrapper and can be disposed independently. */
function subscribe<T>(ipc: DesktopIpcPort, channel: PushChannel, schema: Parser<T>,
  listener: (value: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
  let notify: ((value: T) => void) | undefined = listener;
  const wrapped: PushListener = (_event, ...args) => {
    if (!notify || args.length !== 1) return;
    const value = parse(schema, args[0]);
    if (value === undefined) return;
    // Never forward the Electron event, and isolate renderer callback failures.
    try { notify(value); } catch { /* Other subscriptions must still receive the update. */ }
  };
  const unsubscribe = () => {
    if (!notify) return;
    notify = undefined;
    ipc.removeListener(channel, wrapped);
  };
  ipc.on(channel, wrapped);
  return unsubscribe;
}

/** Request and reply shapes are correlated by both id and closed request method.
 * In particular a gallery reply must not enter an ordinary snapshot/command API. */
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'gallery/list', payload: unknown): Promise<GalleryIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: Exclude<IpcRequest['method'], 'gallery/list'>, payload: unknown): Promise<SnapshotIpcResult>;
async function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: IpcRequest['method'], payload: unknown): Promise<IpcResult> {
  const id = requestId();
  const request = parse(ipcRequestSchema, {
    schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: id, method, payload,
  });
  if (request === undefined) return failure(id, 'INVALID_REQUEST', false);
  try {
    const response = await ipc.invoke(DESKTOP_IPC.request, request);
    // Both parsers are strict; the gallery parser additionally checks that the
    // gallery page and included snapshot use the same authority revision.
    const result = parse<IpcResult>(method === 'gallery/list' ? galleryIpcResultSchema : snapshotIpcResultSchema, response);
    if (result === undefined || (result.ok ? result.requestId : result.error.requestId) !== id
      || !resultMatchesMethod(method, result)) {
      return failure(id, 'INTERNAL_ERROR', true);
    }
    if (result.ok) {
      if (request.method === 'gallery/list' && 'gallery' in result
        && (result.gallery.offset !== request.payload.offset || result.gallery.limit !== request.payload.limit)) {
        return failure(id, 'INTERNAL_ERROR', true);
      }
      return result;
    }
    // The error code and retryability are contractual; free-text errors are not trusted.
    return failure(id, result.error.code, result.error.retryable);
  } catch {
    return failure(id, 'SERVICE_UNAVAILABLE', true);
  }
}

function baseBridge(ipc: DesktopIpcPort, requestId: () => string): DesktopBridgeBase {
  let lastGeneration = 0;
  const observeStatus = (status: ServiceStatus): ServiceStatus => {
    lastGeneration = Math.max(lastGeneration, status.generation);
    return status;
  };

  return {
    getSnapshot: () => sendRequest(ipc, requestId, 'snapshot/get', {}),
    dispatch: (command: DomainCommand) => sendRequest(ipc, requestId, 'command/dispatch', { command }),
    subscribeSnapshot: (listener: (snapshot: AppSnapshot) => void) =>
      subscribe(ipc, DESKTOP_IPC.snapshot, appSnapshotSchema, listener),
    async getServiceStatus() {
      try {
        const status = parse(serviceStatusSchema, await ipc.invoke(DESKTOP_IPC.getStatus));
        if (status !== undefined) return observeStatus(status);
      } catch { /* An unavailable transport has no status payload. */ }
      return { stage: 'UNAVAILABLE', generation: lastGeneration };
    },
    subscribeServiceStatus(listener) {
      if (typeof listener !== 'function') throw new TypeError('A listener function is required.');
      return subscribe(ipc, DESKTOP_IPC.status, serviceStatusSchema, (status) => listener(observeStatus(status)));
    },
    openControlCenter: () => hostAction(ipc, DESKTOP_IPC.openControlCenter),
  };
}

type HostActionInvoke =
  | [channel: typeof DESKTOP_IPC.openControlCenter]
  | [channel: typeof DESKTOP_IPC.petInteractive, interactive: boolean]
  | [channel: typeof DESKTOP_IPC.petVisualReady, report: PetVisualReady];

async function hostAction(ipc: DesktopIpcPort, ...call: HostActionInvoke): Promise<HostActionResult> {
  const [channel, ...args] = call;
  try {
    const result = parse(hostActionResultSchema, await ipc.invoke(channel, ...args));
    if (result !== undefined) return result;
  } catch { /* Do not expose transport exceptions or internal stack traces. */ }
  return { ok: false, code: 'SERVICE_UNAVAILABLE' };
}

export function createPetBridge(ipc: DesktopIpcPort, requestId = newRequestId): PetDesktopBridge {
  return Object.freeze({
    role: 'pet',
    ...baseBridge(ipc, requestId),
    async setInteractive(interactive: boolean): Promise<HostActionResult> {
      if (typeof interactive !== 'boolean') return { ok: false, code: 'INVALID_REQUEST' };
      return hostAction(ipc, DESKTOP_IPC.petInteractive, interactive);
    },
    async reportVisualReady(report: PetVisualReady): Promise<HostActionResult> {
      const parsed = parse(petVisualReadySchema, report);
      if (parsed === undefined) return { ok: false, code: 'INVALID_REQUEST' };
      return hostAction(ipc, DESKTOP_IPC.petVisualReady, parsed);
    },
  });
}

export function createControlCenterBridge(ipc: DesktopIpcPort, requestId = newRequestId): ControlCenterBridge {
  return Object.freeze({
    role: 'control-center',
    ...baseBridge(ipc, requestId),
    listGallery: (query: GalleryQuery) => sendRequest(ipc, requestId, 'gallery/list', query),
  });
}
