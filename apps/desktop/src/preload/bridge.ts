import {
  CONTRACT_SCHEMA_VERSION, appSnapshotSchema, charactersIpcResultSchema, galleryIpcResultSchema, inventoryIpcResultSchema, ipcRequestSchema,
  resultMatchesMethod, snapshotIpcResultSchema, travelCatalogIpcResultSchema, travelPreviewIpcResultSchema, travelReportsIpcResultSchema, eventsIpcResultSchema,
} from '@pet-desktop/contracts';
import type {
  AppSnapshot, CharactersIpcResult, DomainCommand, GalleryIpcResult, GalleryQuery, IpcErrorCode, IpcRequest,
  IpcResult, SnapshotIpcResult, InventoryIpcResult, TravelCatalogIpcResult, TravelPreviewIpcResult, TravelReportsIpcResult, EventsIpcResult,
} from '@pet-desktop/contracts';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import type { TripPreparationPayload, TravelReportsQuery } from '@pet-desktop/contracts/travel';
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

// Intentionally exhaustive: adding another authority method requires choosing
// its exact parser, not silently defaulting to a broad union or snapshot shape.
const requestResultParsers = {
  'snapshot/get': snapshotIpcResultSchema,
  'command/dispatch': snapshotIpcResultSchema,
  'gallery/list': galleryIpcResultSchema,
  'characters/list': charactersIpcResultSchema,
  'inventory/list': inventoryIpcResultSchema,
  'travel/catalog': travelCatalogIpcResultSchema,
  'travel/preview': travelPreviewIpcResultSchema,
  'travel/reports': travelReportsIpcResultSchema,
  'events/list': eventsIpcResultSchema,
} satisfies Record<IpcRequest['method'], Parser<IpcResult>>;

/** Request and reply shapes are correlated by both id and closed request method.
 * Catalog replies must not enter a different catalog or ordinary snapshot/command API. */
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'gallery/list', payload: unknown): Promise<GalleryIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'characters/list', payload: unknown): Promise<CharactersIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'inventory/list', payload: unknown): Promise<InventoryIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/catalog', payload: unknown): Promise<TravelCatalogIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/preview', payload: unknown): Promise<TravelPreviewIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'travel/reports', payload: unknown): Promise<TravelReportsIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'events/list', payload: unknown): Promise<EventsIpcResult>;
function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: 'snapshot/get' | 'command/dispatch', payload: unknown): Promise<SnapshotIpcResult>;
async function sendRequest(ipc: DesktopIpcPort, requestId: () => string, method: IpcRequest['method'], payload: unknown): Promise<IpcResult> {
  const id = requestId();
  const request = parse(ipcRequestSchema, {
    schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: id, method, payload,
  });
  if (request === undefined) return failure(id, 'INVALID_REQUEST', false);
  try {
    const response = await ipc.invoke(DESKTOP_IPC.request, request);
    // Catalog parsers additionally require coherence with the included
    // authority snapshot (revision, and wallet for the character catalog).
    const result = parse<IpcResult>(requestResultParsers[method], response);
    if (result === undefined || (result.ok ? result.requestId : result.error.requestId) !== id
      || !resultMatchesMethod(method, result)) {
      return failure(id, 'INTERNAL_ERROR', true);
    }
    if (result.ok) {
      if (request.method === 'gallery/list' && 'gallery' in result
        && (result.gallery.offset !== request.payload.offset || result.gallery.limit !== request.payload.limit)) {
        return failure(id, 'INTERNAL_ERROR', true);
      }
      if (request.method === 'inventory/list' && 'inventory' in result
        && result.inventory.legacyStackOffset !== (request.payload.legacyOffset ?? 0)) return failure(id, 'INTERNAL_ERROR', true);
      if (request.method === 'travel/preview' && 'travelPreview' in result) {
        const quote = result.travelPreview, intent = request.payload;
        if (quote.petId !== intent.petId || quote.requestedRouteId !== intent.routeId
          || quote.selectedSupplies.length !== intent.selectedSupplies.length
          || quote.selectedSupplies.some((entry) => !intent.selectedSupplies.some((other) => other.itemId === entry.itemId && other.quantity === entry.quantity))) return failure(id, 'INTERNAL_ERROR', true);
      }
      if (request.method === 'travel/reports' && 'travelReports' in result
        && (result.travelReports.offset !== request.payload.offset || result.travelReports.limit !== request.payload.limit
          || result.travelReports.petId !== (request.payload.petId ?? null))) return failure(id, 'INTERNAL_ERROR', true);
      if (request.method === 'events/list' && 'events' in result
        && (result.events.offset !== request.payload.offset || result.events.limit !== request.payload.limit
          || result.events.petId !== (request.payload.petId ?? null) || result.events.filter !== request.payload.filter)) return failure(id, 'INTERNAL_ERROR', true);
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
    async listCharacters(...args: unknown[]): Promise<CharactersIpcResult> {
      // This capability has no input. The rest parameter detects JS callers
      // trying to supply their own data even when bypassing TypeScript.
      if (args.length !== 0) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'characters/list', {});
    },
    async listInventory(...args: unknown[]): Promise<InventoryIpcResult> {
      if (args.length > 1 || (args.length === 1 && typeof args[0] !== 'number')) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'inventory/list', args.length === 0 ? {} : { legacyOffset: args[0] });
    },
    async listTravelCatalog(...args: unknown[]): Promise<TravelCatalogIpcResult> {
      if (args.length !== 0) return failure(requestId(), 'INVALID_REQUEST', false);
      return sendRequest(ipc, requestId, 'travel/catalog', {});
    },
    previewTravel: (input: TripPreparationPayload) => sendRequest(ipc, requestId, 'travel/preview', input),
    listTravelReports: (query: TravelReportsQuery) => sendRequest(ipc, requestId, 'travel/reports', query),
    listEvents: (query: EventListQuery) => sendRequest(ipc, requestId, 'events/list', query),
  });
}
