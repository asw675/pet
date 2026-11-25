import { describe, expect, it, vi } from 'vitest';
import { galleryIpcResultSchema, ipcRequestSchema, ipcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, DomainCommand, GalleryIpcResult, GalleryQuery, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import { createControlCenterBridge, createPetBridge } from '../src/preload/bridge.js';
import type { DesktopIpcPort } from '../src/preload/bridge.js';
import { DESKTOP_IPC } from '../src/shared/protocol.js';
import type { PetVisualReady, ServiceStatus } from '../src/shared/protocol.js';

type PushListener = Parameters<DesktopIpcPort['on']>[1];
type InvokeChannel = Parameters<DesktopIpcPort['invoke']>[0];
type PushChannel = Parameters<DesktopIpcPort['on']>[0];

const snapshot = {
  revision: 8, primaryPetId: null, pets: [], walletCoins: 10,
  doNotDisturb: false, pausedRender: false,
} satisfies AppSnapshot;

const status = { stage: 'READY', generation: 3 } satisfies ServiceStatus;
const ready = { characterId: 'star-singer', generation: status.generation, result: 'READY' } satisfies PetVisualReady;
const command = {
  type: 'PET_INTERACT', commandId: 'command-42', issuedAt: 1234,
  payload: { petId: 'pet-1', interaction: 'PET' },
} satisfies DomainCommand;
const galleryQuery = { filter: 'UNLOCKED', petId: 'pet-1', offset: 20, limit: 10 } satisfies GalleryQuery;

function gallerySuccess(requestId: string, query: GalleryQuery = galleryQuery) {
  return {
    schemaVersion: 1, ok: true, requestId, snapshot,
    gallery: { revision: snapshot.revision, total: 0, rows: [], offset: query.offset, limit: query.limit },
  } satisfies GalleryIpcResult;
}

const privateDetail = '/Users/test/private.sqlite: database error';

class FakeIpc implements DesktopIpcPort {
  readonly listeners = new Map<PushChannel, Set<PushListener>>();
  readonly calls: Array<[InvokeChannel, ...unknown[]]> = [];
  handle: (channel: InvokeChannel, ...args: unknown[]) => unknown = (channel, raw) => {
    if (channel === DESKTOP_IPC.request) {
      const request = ipcRequestSchema.parse(raw);
      if (request.method === 'gallery/list') return gallerySuccess(request.requestId, request.payload);
      return { schemaVersion: 1, ok: true, requestId: request.requestId, snapshot } satisfies IpcResult;
    }
    if (channel === DESKTOP_IPC.getStatus) return status;
    return { ok: true };
  };

  async invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    this.calls.push([channel, ...args]);
    return this.handle(channel, ...args);
  }

  on(channel: PushChannel, listener: PushListener): void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)?.add(listener);
  }

  removeListener(channel: PushChannel, listener: PushListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: PushChannel, ...args: unknown[]): void {
    // This object must never be passed to the renderer callback.
    const event = { sender: this, privateData: privateDetail };
    for (const listener of Array.from(this.listeners.get(channel) ?? [])) listener(event, ...args);
  }
}

function requestIds(): () => string {
  let count = 0;
  return () => `request-${++count}`;
}

describe('role-specific preload bridges', () => {
  it('only exposes the closed public API for each role', () => {
    const ipc = new FakeIpc();
    const commonKeys = [
      'role', 'getSnapshot', 'dispatch', 'subscribeSnapshot', 'getServiceStatus',
      'subscribeServiceStatus', 'openControlCenter',
    ];
    const pet = createPetBridge(ipc);
    const center = createControlCenterBridge(ipc);
    expect(Object.keys(pet).sort()).toEqual([...commonKeys, 'setInteractive', 'reportVisualReady'].sort());
    expect(Object.keys(center).sort()).toEqual([...commonKeys, 'listGallery'].sort());
    expect('reportVisualReady' in center).toBe(false);
    expect('listGallery' in pet).toBe(false);
    expect(pet.role).toBe('pet');
    expect(center.role).toBe('control-center');
    expect(Object.isFrozen(pet)).toBe(true);
    expect(Object.isFrozen(center)).toBe(true);
  });

  it('validates, wraps and correlates requests without changing the command ID', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc, requestIds());
    const request: IpcRequest = { schemaVersion: 1, requestId: 'request-1', method: 'snapshot/get', payload: {} };
    expect(await bridge.getSnapshot()).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.dispatch(command)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-2', snapshot });
    expect(await bridge.dispatch(command)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-3', snapshot });
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, request],
      [DESKTOP_IPC.request, { ...request, requestId: 'request-2', method: 'command/dispatch', payload: { command } }],
      [DESKTOP_IPC.request, { ...request, requestId: 'request-3', method: 'command/dispatch', payload: { command } }],
    ]);
  });

  it('generates distinct schema-valid request IDs by default', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const a = ipcResultSchema.parse(await bridge.getSnapshot());
    const b = ipcResultSchema.parse(await bridge.getSnapshot());
    expect(a.ok && b.ok && a.requestId !== b.requestId).toBe(true);
  });

  it.each([
    null, { ...command, type: 'shell/execute' }, { ...command, channel: 'debug' },
    { ...command, payload: { ...command.payload, secret: privateDetail } },
    { ...command, payload: { petId: 123, interaction: 'PET' } },
  ])('rejects malformed commands before transport: case %#', async (input) => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const result = await bridge.dispatch(input as DomainCommand);
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: {
      requestId: 'request-1', code: 'INVALID_REQUEST', retryable: false,
    } });
    expect(ipcResultSchema.safeParse(result).success).toBe(true);
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('only invokes the fixed host actions and rejects non-boolean interactive input', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const center = createControlCenterBridge(ipc);
    expect(await pet.setInteractive(true)).toEqual({ ok: true });
    expect(await pet.setInteractive(false)).toEqual({ ok: true });
    expect(await pet.setInteractive('true' as unknown as boolean)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.setInteractive({ channel: 'debug' } as unknown as boolean)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await pet.openControlCenter()).toEqual({ ok: true });
    expect(await center.openControlCenter()).toEqual({ ok: true });
    expect(await center.getServiceStatus()).toEqual(status);
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.petInteractive, true], [DESKTOP_IPC.petInteractive, false],
      [DESKTOP_IPC.openControlCenter], [DESKTOP_IPC.openControlCenter], [DESKTOP_IPC.getStatus],
    ]);
  });

  it('reports ready/fallback only through the pet-specific visual channel', async () => {
    const ipc = new FakeIpc();
    const pet = createPetBridge(ipc);
    const fallback = { ...ready, generation: 4, result: 'FALLBACK' } satisfies PetVisualReady;
    expect(await pet.reportVisualReady(ready)).toEqual({ ok: true });
    expect(await pet.reportVisualReady(fallback)).toEqual({ ok: true });
    expect(ipc.calls).toEqual([[DESKTOP_IPC.petVisualReady, ready], [DESKTOP_IPC.petVisualReady, fallback]]);
  });

  it.each([
    null, undefined, '', [], {}, { ...ready, characterId: '' },
    { ...ready, characterId: '../private' },
    { ...ready, characterId: 'x'.repeat(129) },
    { ...ready, generation: -1 }, { ...ready, generation: 1.1 },
    { ...ready, generation: '3' }, { ...ready, generation: Infinity },
    { ...ready, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...ready, result: 'FAILED' }, { ...ready, result: true },
    { ...ready, petId: 'another-pet' }, { ...ready, path: privateDetail },
    { ...ready, data: privateDetail }, { ...ready, channel: 'debug' },
    Object.defineProperty({}, 'characterId', { enumerable: true, get() { throw new Error(privateDetail); } }),
  ])('rejects malformed visual reports before invoking IPC: case %#', async (input) => {
    const ipc = new FakeIpc();
    const result = await createPetBridge(ipc).reportVisualReady(input as PetVisualReady);
    expect(result).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });
});

describe('control-center-only gallery requests', () => {
  it('validates the closed query and returns its authority-coherent page on the existing correlated request channel', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const snapshotReply = await bridge.getSnapshot();
    const reply = await bridge.listGallery(galleryQuery);
    expect(snapshotReply).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(reply).toEqual(gallerySuccess('request-2'));
    expect(galleryIpcResultSchema.safeParse(reply).success).toBe(true);
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'snapshot/get', payload: {} }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'gallery/list', payload: galleryQuery }],
    ]);
  });

  it.each([
    undefined, null, '', [], {}, { ...galleryQuery, filter: 'UNKNOWN' }, { ...galleryQuery, rarity: 'UNKNOWN' },
    { ...galleryQuery, petId: '../private' }, { ...galleryQuery, characterId: 123 },
    { ...galleryQuery, offset: -1 }, { ...galleryQuery, offset: 10_001 }, { ...galleryQuery, offset: 1.1 },
    { ...galleryQuery, limit: 0 }, { ...galleryQuery, limit: 51 }, { ...galleryQuery, limit: '10' },
    { ...galleryQuery, path: privateDetail }, { ...galleryQuery, method: 'snapshot/get' },
  ])('rejects invalid gallery arguments before IPC: case %#', async (input) => {
    const ipc = new FakeIpc();
    const result = await createControlCenterBridge(ipc, requestIds()).listGallery(input as GalleryQuery);
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: { code: 'INVALID_REQUEST', requestId: 'request-1', retryable: false } });
    expect(galleryIpcResultSchema.safeParse(result).success).toBe(true);
    expect(ipc.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('allows closed gallery preference commands through the ordinary command method without returning gallery data', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    const favorite: DomainCommand = {
      type: 'CG_SET_FAVORITE', commandId: 'favorite-1', issuedAt: 1234,
      payload: { petId: 'pet-1', cgId: 'cg-1', variant: 'default', favorite: true },
    };
    const viewed: DomainCommand = {
      type: 'CG_MARK_VIEWED', commandId: 'viewed-1', issuedAt: 1234,
      payload: { petId: 'pet-1', cgId: 'cg-1', variant: 'default', characterId: 'star-singer',
        eventDefId: 'def-1', assetVersion: '1.0.0', assetHash: 'a'.repeat(64) },
    };
    expect(await bridge.dispatch(favorite)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-1', snapshot });
    expect(await bridge.dispatch(viewed)).toEqual({ schemaVersion: 1, ok: true, requestId: 'request-2', snapshot });
    expect(ipc.calls).toEqual([
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-1', method: 'command/dispatch', payload: { command: favorite } }],
      [DESKTOP_IPC.request, { schemaVersion: 1, requestId: 'request-2', method: 'command/dispatch', payload: { command: viewed } }],
    ]);
  });

  it('rejects gallery success replies through ordinary snapshot and dispatch methods even with a valid request ID', async () => {
    for (const role of ['pet', 'control-center'] as const) {
      const ipc = new FakeIpc();
      const bridge = role === 'pet' ? createPetBridge(ipc, requestIds()) : createControlCenterBridge(ipc, requestIds());
      ipc.handle = (_channel, raw) => {
        const reply = gallerySuccess(ipcRequestSchema.parse(raw).requestId);
        expect(ipcResultSchema.safeParse(reply).success).toBe(true);
        return reply;
      };
      expect(await bridge.getSnapshot()).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'INTERNAL_ERROR' } });
      expect(await bridge.dispatch(command)).toMatchObject({ ok: false, error: { requestId: 'request-2', code: 'INTERNAL_ERROR' } });
    }
  });

  it.each([
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot }, // snapshot-only success
    gallerySuccess('other-id'),
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, revision: snapshot.revision + 1 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, offset: 0 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, limit: 50 } },
    { ...gallerySuccess('request-1'), gallery: { ...gallerySuccess('request-1').gallery, path: privateDetail } },
  ])('rejects invalid or mismatched gallery replies: case %#', async (reply) => {
    const ipc = new FakeIpc();
    ipc.handle = () => reply;
    const result = await createControlCenterBridge(ipc, requestIds()).listGallery(galleryQuery);
    expect(result).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'INTERNAL_ERROR', retryable: true } });
    expect(galleryIpcResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('sanitizes gallery transport failures and correlates legitimate errors', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc, requestIds());
    ipc.handle = () => ({ schemaVersion: 1, ok: false, error: {
      requestId: 'request-1', code: 'NOT_FOUND', retryable: false, message: privateDetail,
    } });
    const first = await bridge.listGallery(galleryQuery);
    expect(first).toMatchObject({ ok: false, error: { requestId: 'request-1', code: 'NOT_FOUND', retryable: false } });
    expect(JSON.stringify(first)).not.toContain(privateDetail);
    const mismatched = await bridge.listGallery(galleryQuery);
    expect(mismatched).toMatchObject({ ok: false, error: { requestId: 'request-2', code: 'INTERNAL_ERROR', retryable: true } });
    expect(JSON.stringify(mismatched)).not.toContain(privateDetail);
    ipc.handle = () => { throw new Error(privateDetail); };
    const rejected = await bridge.listGallery(galleryQuery);
    expect(rejected).toMatchObject({ ok: false, error: { requestId: 'request-3', code: 'SERVICE_UNAVAILABLE', retryable: true } });
    expect(JSON.stringify(rejected)).not.toContain(privateDetail);
  });
});

describe('runtime response validation and error isolation', () => {
  it.each([
    null, { schemaVersion: 2, ok: true, requestId: 'request-1', snapshot },
    { schemaVersion: 1, ok: true, requestId: 'different-id', snapshot },
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot: { ...snapshot, secret: privateDetail } },
    { schemaVersion: 1, ok: true, requestId: 'request-1', snapshot: { ...snapshot, walletCoins: -1 } },
    { schemaVersion: 1, ok: false, error: { code: 'FORBIDDEN', message: privateDetail, retryable: false, requestId: 'other-id' } },
  ])('rejects invalid or mismatched responses: case %#', async (response) => {
    const ipc = new FakeIpc();
    ipc.handle = () => response;
    const result = await createPetBridge(ipc, requestIds()).getSnapshot();
    expect(result).toMatchObject({ schemaVersion: 1, ok: false, error: {
      code: 'INTERNAL_ERROR', requestId: 'request-1', retryable: true,
    } });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('preserves legitimate codes but not free-text IPC error details', async () => {
    const ipc = new FakeIpc();
    ipc.handle = () => ({ schemaVersion: 1, ok: false, error: {
      code: 'FORBIDDEN', message: privateDetail, retryable: false, requestId: 'request-1',
    } });
    const response = await createPetBridge(ipc, requestIds()).dispatch(command);
    expect(response).toMatchObject({ schemaVersion: 1, ok: false, error: {
      code: 'FORBIDDEN', retryable: false, requestId: 'request-1',
    } });
    expect(JSON.stringify(response)).not.toContain(privateDetail);
  });

  it('never forwards rejected invoke exceptions, invalid host responses or invalid status', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc, requestIds());
    ipc.handle = () => ({ ok: true, message: privateDetail });
    expect(await bridge.openControlCenter()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 0 });
    ipc.handle = () => ({ ok: false, code: 'FORBIDDEN' });
    expect(await bridge.setInteractive(false)).toEqual({ ok: false, code: 'FORBIDDEN' });
    ipc.handle = () => { throw new Error(privateDetail); };
    const result = await bridge.getSnapshot();
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', requestId: 'request-1', retryable: true } });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(await bridge.openControlCenter()).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 0 });
  });

  it('sanitizes visual readiness reply errors without leaking host details', async () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc);
    ipc.handle = () => ({ ok: false, code: 'FORBIDDEN' });
    expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'FORBIDDEN' });
    for (const reply of [null, { ok: true, path: privateDetail }, { ok: false, code: 'FORBIDDEN', message: privateDetail },
      { ok: false, code: privateDetail }]) {
      ipc.handle = () => reply;
      expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    }
    ipc.handle = () => { throw new Error(privateDetail); };
    expect(await bridge.reportVisualReady(ready)).toEqual({ ok: false, code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('subscriptions', () => {
  it('does not leak IPC events, rejects malformed payloads and unsubscribes duplicate listeners independently', () => {
    const ipc = new FakeIpc();
    const bridge = createPetBridge(ipc);
    const listener = vi.fn();
    const unsubscribeFirst = bridge.subscribeSnapshot(listener);
    const unsubscribeSecond = bridge.subscribeSnapshot(listener);
    const captured = Array.from(ipc.listeners.get(DESKTOP_IPC.snapshot) ?? []);
    expect(captured).toHaveLength(2);
    for (const payload of [null, { ...snapshot, secret: privateDetail }, { ...snapshot, revision: -1 }]) {
      ipc.emit(DESKTOP_IPC.snapshot, payload);
    }
    ipc.emit(DESKTOP_IPC.snapshot, snapshot, privateDetail);
    expect(listener).not.toHaveBeenCalled();
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(listener.mock.calls).toEqual([[snapshot], [snapshot]]);
    unsubscribeFirst();
    unsubscribeFirst();
    captured[0]?.({}, snapshot); // even a late callback captured before removal is inactive
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(listener.mock.calls).toEqual([[snapshot], [snapshot], [snapshot]]);
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(1);
    unsubscribeSecond();
    ipc.emit(DESKTOP_IPC.snapshot, snapshot);
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('only delivers validated status DTOs and retains the latest known generation on failure', async () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const listener = vi.fn();
    const dispose = bridge.subscribeServiceStatus(listener);
    expect(await bridge.getServiceStatus()).toEqual(status);
    ipc.emit(DESKTOP_IPC.status, { ...status, stage: 'INVALID' });
    ipc.emit(DESKTOP_IPC.status, { ...status, generation: -1 });
    ipc.emit(DESKTOP_IPC.status, { ...status, secret: privateDetail });
    expect(listener).not.toHaveBeenCalled();
    const next = { stage: 'RESTARTING', generation: 4 } satisfies ServiceStatus;
    ipc.emit(DESKTOP_IPC.status, next);
    expect(listener.mock.calls).toEqual([[next]]);
    ipc.handle = () => { throw new Error(privateDetail); };
    expect(await bridge.getServiceStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 4 });
    dispose();
    dispose();
    ipc.emit(DESKTOP_IPC.status, status);
    expect(ipc.listeners.get(DESKTOP_IPC.status)?.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects a nonfunction subscriber and isolates a throwing subscriber from other listeners', () => {
    const ipc = new FakeIpc();
    const bridge = createControlCenterBridge(ipc);
    const invalid = 'not a callback' as unknown as () => void;
    expect(() => bridge.subscribeSnapshot(invalid)).toThrow('A listener function is required.');
    expect(() => bridge.subscribeServiceStatus(invalid)).toThrow('A listener function is required.');
    expect(ipc.listeners.size).toBe(0);

    const second = vi.fn();
    const firstDispose = bridge.subscribeSnapshot(() => { throw new Error(privateDetail); });
    const secondDispose = bridge.subscribeSnapshot(second);
    expect(() => ipc.emit(DESKTOP_IPC.snapshot, snapshot)).not.toThrow();
    expect(second.mock.calls).toEqual([[snapshot]]);
    firstDispose();
    secondDispose();
    expect(ipc.listeners.get(DESKTOP_IPC.snapshot)?.size).toBe(0);
  });
});
