import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, DomainCommand, IpcResult } from '@pet-desktop/contracts';
import type { ControlCenterBridge, HostActionResult, ServiceStatus } from '../src/shared/protocol';
import { useAppStore } from '../src/renderer/shared/store';
import { createInteractionLease } from '../src/renderer/shared/interaction-lease';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function snapshot(revision: number, walletCoins = 0): AppSnapshot {
  return {
    revision, primaryPetId: 'pet-1', walletCoins, doNotDisturb: false, pausedRender: false,
    pets: [{
      petId: 'pet-1', characterId: 'star-singer', nickname: '星咏', presence: 'HOME', activity: 'IDLE',
      mood: 'CALM', healthStatus: 'NORMAL', visibility: 'VISIBLE', moodScore: 50, healthPoints: 100,
      energy: 100, bond: 0, xp: 0, level: 1, revision: 0,
    }],
  };
}

function success(app: AppSnapshot): IpcResult {
  return { schemaVersion: 1, ok: true, requestId: 'transport-1', snapshot: app };
}

function testBridge() {
  const snapshots = new Set<(snapshot: AppSnapshot) => void>();
  const statuses = new Set<(status: ServiceStatus) => void>();
  const getServiceStatus = vi.fn<ControlCenterBridge['getServiceStatus']>().mockResolvedValue({ stage: 'READY', generation: 1 });
  const getSnapshot = vi.fn<ControlCenterBridge['getSnapshot']>().mockResolvedValue(success(snapshot(0)));
  const dispatch = vi.fn<ControlCenterBridge['dispatch']>().mockResolvedValue(success(snapshot(1)));
  const listGallery = vi.fn<ControlCenterBridge['listGallery']>().mockImplementation(async (query) => ({
    schemaVersion: 1, ok: true, requestId: 'gallery-request', snapshot: snapshot(0),
    gallery: { revision: 0, rows: [], total: 0, offset: query.offset, limit: query.limit },
  }));
  const listCharacters = vi.fn<ControlCenterBridge['listCharacters']>().mockResolvedValue({
    schemaVersion: 1, ok: true, requestId: 'characters-request', snapshot: snapshot(0),
    characters: { revision: 0, catalogVersion: 1, settledTrips: 0, walletCoins: 0, rows: [] },
  });
  const bridge: ControlCenterBridge = {
    role: 'control-center', getServiceStatus, getSnapshot, dispatch, listGallery, listCharacters,
    openControlCenter: () => Promise.resolve({ ok: true }),
    subscribeSnapshot: (listener) => {
      snapshots.add(listener);
      return () => { snapshots.delete(listener); };
    },
    subscribeServiceStatus: (listener) => {
      statuses.add(listener);
      return () => { statuses.delete(listener); };
    },
  };
  return {
    bridge, getServiceStatus, getSnapshot, dispatch, listGallery, listCharacters, snapshots, statuses,
    emitSnapshot(app: AppSnapshot) { for (const listener of snapshots) listener(app); },
    emitStatus(status: ServiceStatus) { for (const listener of statuses) listener(status); },
  };
}

const interact = { type: 'PET_INTERACT', payload: { petId: 'pet-1', interaction: 'PET' } } as const;

describe('renderer snapshot projection', () => {
  it('subscribes first and rejects older initial, duplicate, and command result snapshots', async () => {
    const mock = testBridge();
    const first = deferred<IpcResult>();
    mock.getSnapshot.mockReturnValueOnce(first.promise);
    const store = useAppStore(createPinia());
    store.connect(mock.bridge);
    expect(mock.snapshots.size).toBe(1);
    expect(mock.statuses.size).toBe(1);
    expect(store.ready).toBe(false);
    await vi.waitFor(() => expect(mock.getSnapshot).toHaveBeenCalled());
    mock.emitSnapshot(snapshot(5, 12));
    expect(store.snapshot?.revision).toBe(5);
    expect(store.loading).toBe(true);
    first.resolve(success(snapshot(3, 2)));
    await vi.waitFor(() => expect(store.loading).toBe(false));
    mock.emitSnapshot(snapshot(5, 100));
    expect(store.snapshot?.walletCoins).toBe(12);
    expect(store.ready).toBe(true);

    const firstCommand = deferred<IpcResult>();
    mock.dispatch.mockReturnValueOnce(firstCommand.promise);
    const pending = store.dispatch(interact);
    expect(store.busy).toBe(true);
    expect(store.snapshot?.walletCoins).toBe(12); // no speculative business write
    expect(await store.dispatch(interact)).toBe(false);
    mock.emitSnapshot(snapshot(8, 15));
    firstCommand.resolve(success(snapshot(6, 13)));
    expect(await pending).toBe(true);
    expect(store.snapshot?.revision).toBe(8);
    expect(store.snapshot?.walletCoins).toBe(15);

    mock.dispatch.mockResolvedValueOnce(success(snapshot(9, 15)));
    expect(await store.dispatch(interact)).toBe(true);
    const commands: DomainCommand[] = mock.dispatch.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.commandId).not.toBe(commands[1]?.commandId);
    expect(commands[0]?.expectedRevision).toBe(5);
    expect(commands[1]?.expectedRevision).toBe(8);
    store.disconnect();
    expect(mock.snapshots.size).toBe(0);
    expect(mock.statuses.size).toBe(0);
  });

  it('accepts a lower revision after a restart and ignores outstanding old-generation replies', async () => {
    const mock = testBridge();
    mock.getSnapshot.mockResolvedValueOnce(success(snapshot(30, 20)));
    const store = useAppStore(createPinia());
    store.connect(mock.bridge);
    await vi.waitFor(() => expect(store.ready && !store.loading).toBe(true));
    const oldCommand = deferred<IpcResult>();
    mock.dispatch.mockReturnValueOnce(oldCommand.promise);
    const pending = store.dispatch(interact);
    expect(store.busy).toBe(true);

    mock.emitStatus({ stage: 'RESTARTING', generation: 2 });
    expect(store.ready).toBe(false);
    expect(store.busy).toBe(false);
    mock.emitSnapshot(snapshot(31, 21));
    expect(store.snapshot?.revision).toBe(30);
    expect(await store.dispatch(interact)).toBe(false);

    const newRead = deferred<IpcResult>();
    mock.getSnapshot.mockReturnValueOnce(newRead.promise);
    mock.emitStatus({ stage: 'READY', generation: 2 });
    expect(store.ready).toBe(false);
    mock.emitSnapshot(snapshot(1, 4));
    expect(store.ready).toBe(true);
    newRead.resolve(success(snapshot(2, 5)));
    await vi.waitFor(() => expect(store.loading).toBe(false));
    oldCommand.resolve(success(snapshot(32, 22)));
    expect(await pending).toBe(false);
    expect(store.snapshot?.revision).toBe(2);
    expect(store.snapshot?.walletCoins).toBe(5);
    expect(store.notice).toBeNull();

    // A status from the retired generation can't reset the projection.
    mock.emitStatus({ stage: 'UNAVAILABLE', generation: 1 });
    expect(store.serviceStatus).toEqual({ stage: 'READY', generation: 2 });
    expect(store.ready).toBe(true);
    store.disconnect();
  });

  it('does not let late status or snapshot queries revert a newer connection', async () => {
    const mock = testBridge();
    const initialStatus = deferred<ServiceStatus>();
    const previousSnapshot = deferred<IpcResult>();
    mock.getServiceStatus.mockReturnValueOnce(initialStatus.promise);
    mock.getSnapshot.mockReturnValueOnce(previousSnapshot.promise);
    const store = useAppStore(createPinia());
    store.connect(mock.bridge);
    mock.emitStatus({ stage: 'READY', generation: 1 });
    mock.emitStatus({ stage: 'RESTARTING', generation: 2 });
    mock.getSnapshot.mockResolvedValue(success(snapshot(1, 9)));
    mock.emitStatus({ stage: 'READY', generation: 2 });
    initialStatus.resolve({ stage: 'STARTING', generation: 0 });
    previousSnapshot.resolve(success(snapshot(800)));
    await vi.waitFor(() => expect(store.ready && !store.loading).toBe(true));
    expect(store.serviceStatus).toEqual({ stage: 'READY', generation: 2 });
    expect(store.snapshot?.revision).toBe(1);
    expect(store.snapshot?.walletCoins).toBe(9);

    const staleListener = [...mock.snapshots][0];
    store.disconnect();
    staleListener?.(snapshot(100));
    expect(store.snapshot).toBeNull();
  });

  it('surfaces errors, refreshes on revision conflict, and never retries a command automatically', async () => {
    const mock = testBridge();
    mock.getServiceStatus.mockResolvedValueOnce({ stage: 'UNAVAILABLE', generation: 0 });
    const store = useAppStore(createPinia());
    store.connect(mock.bridge);
    await vi.waitFor(() => expect(store.loading).toBe(false));
    expect(store.ready).toBe(false);
    expect(await store.dispatch(interact)).toBe(false);
    expect(mock.dispatch).not.toHaveBeenCalled();
    await store.refresh();
    expect(store.ready).toBe(true);
    mock.dispatch.mockResolvedValueOnce({
      schemaVersion: 1, ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'Conflicting revision.', retryable: true, requestId: 'transport-2' },
    });
    mock.getSnapshot.mockResolvedValueOnce(success(snapshot(4, 8)));
    expect(await store.dispatch(interact)).toBe(false);
    expect(store.error).toContain('刷新');
    expect(store.snapshot?.revision).toBe(4);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    expect(store.busy).toBe(false);
    store.disconnect();
  });

  it('requires authoritative refresh after an ambiguous timeout', async () => {
    const mock = testBridge();
    const store = useAppStore(createPinia());
    store.connect(mock.bridge);
    await vi.waitFor(() => expect(store.ready && !store.loading).toBe(true));
    mock.dispatch.mockResolvedValueOnce({ schemaVersion: 1, ok: false,
      error: { code: 'TIMEOUT', message: 'Timed out.', retryable: true, requestId: 'transport-3' } });
    expect(await store.dispatch(interact)).toBe(false);
    expect(store.ready).toBe(false);
    expect(await store.dispatch(interact)).toBe(false);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    mock.getSnapshot.mockResolvedValueOnce(success(snapshot(1, 9)));
    await store.refresh();
    expect(store.ready).toBe(true);
    expect(store.snapshot?.walletCoins).toBe(9);
    expect(store.error).toBeNull();
    store.disconnect();
  });
});

describe('renderer native input intent', () => {
  it('renews a stationary valid hit, but does not keep renewing a transparent hit', async () => {
    const request = vi.fn<(interactive: boolean) => Promise<HostActionResult>>().mockResolvedValue({ ok: true });
    const report = vi.fn();
    const lease = createInteractionLease(request, report);
    lease.set(true);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    lease.set(true);
    expect(request.mock.calls).toEqual([[true]]);
    lease.set(true, true);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    lease.set(false);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
    lease.set(false, true);
    expect(request.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('forces the latest hit intent after a stale response, suppressing its error', async () => {
    const old = deferred<HostActionResult>();
    const request = vi.fn<(interactive: boolean) => Promise<HostActionResult>>()
      .mockResolvedValue({ ok: true }).mockReturnValueOnce(old.promise);
    const report = vi.fn();
    const lease = createInteractionLease(request, report);
    lease.set(true);
    lease.reset(); // mouseleave, visibility or readiness loss
    expect(request.mock.calls).toEqual([[true]]);
    old.resolve({ ok: false, code: 'FORBIDDEN' });
    await vi.waitFor(() => expect(request.mock.calls).toEqual([[true], [false]]));
    await vi.waitFor(() => expect(report.mock.calls).toEqual([[true]]));

    // A fresh trusted pointer move can re-enter after clearing the prior lease.
    lease.set(true);
    await vi.waitFor(() => expect(report.mock.calls).toEqual([[true], [true]]));
    expect(request.mock.calls).toEqual([[true], [false], [true]]);
  });
});
