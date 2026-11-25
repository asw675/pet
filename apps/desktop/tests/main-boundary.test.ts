import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, DomainCommand, IpcRequest, IpcResult, PetSnapshot } from '@pet-desktop/contracts';
import { ipcResultSchema } from '@pet-desktop/contracts';
import { authorizeSender, routeRequest } from '../src/main/boundary';
import type { SenderContext, WindowBinding } from '../src/main/boundary';
import { clampBounds, InputLease, isCursorInBounds, rendererUrl, visibleHomePetIds } from '../src/main/window-policy';

const petUrl = 'file:///app/renderer/pet/index.html?petId=pet-a';
const centerUrl = 'file:///app/renderer/control-center/index.html';
const pet: WindowBinding = { senderId: 10, trustedUrl: petUrl, role: 'pet', petId: 'pet-a' };
const center: WindowBinding = { senderId: 11, trustedUrl: centerUrl, role: 'control-center' };
const sender = (binding: WindowBinding): SenderContext => ({
  senderId: binding.senderId, frameUrl: binding.trustedUrl, documentUrl: binding.trustedUrl, isMainFrame: true,
});
const getSnapshot: IpcRequest = { schemaVersion: 1, requestId: 'renderer-request', method: 'snapshot/get', payload: {} };
const common = { commandId: 'command-123', issuedAt: 1, expectedRevision: 1 };
const dispatch = (command: DomainCommand): IpcRequest => ({
  ...getSnapshot, method: 'command/dispatch', payload: { command },
});
const snapshot: AppSnapshot = {
  revision: 1, primaryPetId: null, pets: [], walletCoins: 1, doNotDisturb: false, pausedRender: false,
};
const relay = () => vi.fn(async (request: IpcRequest): Promise<IpcResult> => ({
  schemaVersion: 1, ok: true, requestId: request.requestId, snapshot,
}));

describe('Main window identity and URL boundary', () => {
  it('checks the registered window, role, sender ID, main frame and both URL views', () => {
    expect(authorizeSender(pet, sender(pet), 'pet')).toBe(true);
    expect(authorizeSender(center, sender(center), 'pet')).toBe(false);
    expect(authorizeSender(undefined, sender(pet))).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), senderId: 99 })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), isMainFrame: false })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), frameUrl: centerUrl })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), documentUrl: centerUrl })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), frameUrl: petUrl.replace('pet-a', 'pet-b') })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), frameUrl: `${petUrl}&other=1` })).toBe(false);
    expect(authorizeSender(pet, { ...sender(pet), frameUrl: `${petUrl}#a` })).toBe(false);
  });

  it('allows only same-document hashes for control-center router views', () => {
    const hash = { ...sender(center), frameUrl: `${centerUrl}#/home`, documentUrl: `${centerUrl}#/home` };
    expect(authorizeSender(center, hash)).toBe(true);
    expect(authorizeSender(center, { ...hash, frameUrl: `${centerUrl}?x=1#/home` })).toBe(false);
    expect(authorizeSender(center, { ...hash, frameUrl: `${centerUrl}.old#/home` })).toBe(false);
    expect(authorizeSender(center, { ...hash, documentUrl: 'https://example.invalid/#/home' })).toBe(false);
  });

  it('builds explicit packaged and loopback development entry URLs', () => {
    expect(rendererUrl('/app/renderer', 'pet', undefined, 'pet:a')).toMatch(/\/pet\/index\.html\?petId=pet%3Aa$/u);
    expect(rendererUrl('/app/renderer', 'control-center', 'http://localhost:5173')).toBe('http://localhost:5173/control-center/index.html');
    expect(rendererUrl('/app/renderer', 'pet', 'http://127.0.0.1:5173/', 'pet-a')).toBe('http://127.0.0.1:5173/pet/index.html?petId=pet-a');
    expect(() => rendererUrl('/app/renderer', 'pet', 'https://untrusted.invalid', 'pet-a')).toThrow();
    expect(() => rendererUrl('/app/renderer', 'pet', 'http://user@localhost:5173', 'pet-a')).toThrow();
  });
});

describe('Main request routing', () => {
  it('never forwards requests from an unregistered sender, child frame or mismatched URL', async () => {
    const forward = relay();
    for (const [binding, context] of [
      [undefined, sender(pet)],
      [pet, { ...sender(pet), isMainFrame: false }],
      [pet, { ...sender(pet), frameUrl: 'https://example.invalid' }],
    ] as const) {
      await expect(routeRequest(binding, context, [getSnapshot], forward, snapshot.revision)).resolves.toMatchObject({
        ok: false, error: { code: 'FORBIDDEN', requestId: getSnapshot.requestId },
      });
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects malformed, extra argument, extra field and unknown method/version payloads', async () => {
    const forward = relay();
    for (const args of [[], [getSnapshot, true], [null], [{ ...getSnapshot, other: true }], [
      { ...getSnapshot, method: 'host/run' },
    ], [{ ...getSnapshot, schemaVersion: 2 }], [{ ...getSnapshot, payload: { arbitrary: 'file' } }]]) {
      const result = await routeRequest(center, sender(center), args, forward, undefined);
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(ipcResultSchema.safeParse(result).success).toBe(true);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it('validates pet commands and ownership, reserving other commands for the control center', async () => {
    const forward = relay();
    const commands: DomainCommand[] = [
      { ...common, type: 'PET_INTERACT', payload: { petId: 'pet-a', interaction: 'PET' } },
      { ...common, type: 'PET_SET_VISIBILITY', payload: { petId: 'pet-a', visibility: 'HIDDEN' } },
      { ...common, type: 'PET_INTERACT', payload: { petId: 'pet-b', interaction: 'REST' } },
      { ...common, type: 'PET_SET_VISIBILITY', payload: { petId: 'pet-b', visibility: 'VISIBLE' } },
      { ...common, type: 'PET_SELECT', payload: { petId: 'pet-a' } },
      { ...common, type: 'TRIP_START', payload: { petId: 'pet-a', routeId: 'route-a' } },
      { ...common, type: 'TRIP_RECALL', payload: { petId: 'pet-a', tripId: 'trip-a' } },
      { ...common, type: 'TRIP_REPORT_READ', payload: { petId: 'pet-a', tripId: 'trip-a' } },
      { ...common, type: 'APP_SET_MODE', payload: { flag: 'pausedRender', enabled: true } },
    ];
    await expect(routeRequest(pet, sender(pet), [getSnapshot], forward, snapshot.revision)).resolves.toMatchObject({ ok: true });
    for (const command of commands.slice(0, 2)) {
      await expect(routeRequest(pet, sender(pet), [dispatch(command)], forward, snapshot.revision)).resolves.toMatchObject({ ok: true });
    }
    for (const command of commands.slice(2)) {
      await expect(routeRequest(pet, sender(pet), [dispatch(command)], forward, snapshot.revision)).resolves.toMatchObject({
        ok: false, error: { code: 'FORBIDDEN' },
      });
    }
    expect(forward).toHaveBeenCalledTimes(3);
    for (const command of commands) {
      await expect(routeRequest(center, sender(center), [dispatch(command)], forward, undefined)).resolves.toMatchObject({ ok: true });
    }
    expect(forward).toHaveBeenCalledTimes(3 + commands.length);
  });

  it('keeps staging/retiring windows read-only even for valid own-pet commands', async () => {
    const forward = relay();
    const own = dispatch({ ...common, type: 'PET_INTERACT', payload: { petId: 'pet-a', interaction: 'PET' } });
    const hide = dispatch({ ...common, type: 'PET_SET_VISIBILITY', payload: { petId: 'pet-a', visibility: 'HIDDEN' } });
    await expect(routeRequest(pet, sender(pet), [getSnapshot], forward, undefined)).resolves.toMatchObject({ ok: true });
    for (const request of [own, hide]) {
      await expect(routeRequest(pet, sender(pet), [request], forward, undefined)).resolves.toMatchObject({
        ok: false, error: { code: 'FORBIDDEN' },
      });
    }
    expect(forward).toHaveBeenCalledTimes(1);
    await expect(routeRequest(pet, sender(pet), [own], forward, snapshot.revision)).resolves.toMatchObject({ ok: true });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('requires the active window command revision and rejects missing or stale preconditions', async () => {
    const forward = relay();
    const base = { commandId: 'revision-command', issuedAt: 1, type: 'PET_INTERACT', payload: { petId: 'pet-a', interaction: 'PET' } } as const;
    const omitted = dispatch(base);
    await expect(routeRequest(pet, sender(pet), [omitted], forward, snapshot.revision)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_REQUEST' },
    });
    for (const expectedRevision of [0, 2]) {
      await expect(routeRequest(pet, sender(pet), [dispatch({ ...base, expectedRevision })], forward, snapshot.revision)).resolves.toMatchObject({
        ok: false, error: { code: 'REVISION_CONFLICT', retryable: true },
      });
    }
    expect(forward).not.toHaveBeenCalled();
    const matching = dispatch({ ...base, expectedRevision: snapshot.revision });
    await expect(routeRequest(pet, sender(pet), [matching], forward, snapshot.revision)).resolves.toMatchObject({ ok: true });
    expect(forward.mock.calls[0]?.[0].payload).toEqual(matching.payload);
    // Center remains a trusted command origin without a view precondition.
    await expect(routeRequest(center, sender(center), [omitted], forward, undefined)).resolves.toMatchObject({ ok: true });
  });

  it('isolates concurrent repeated renderer request IDs while preserving command ID and renderer correlation', async () => {
    const forward = relay();
    const request = dispatch({ ...common, type: 'PET_INTERACT', payload: { petId: 'pet-a', interaction: 'PET' } });
    const results = await Promise.all([
      routeRequest(pet, sender(pet), [request], forward, snapshot.revision),
      routeRequest(center, sender(center), [request], forward, undefined),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: true, requestId: 'renderer-request' });
    const [first, second] = forward.mock.calls.map(([call]) => call);
    expect(first?.requestId).not.toBe(second?.requestId);
    expect(first?.requestId).not.toBe(request.requestId);
    expect(second?.requestId).not.toBe(request.requestId);
    expect(first?.payload).toEqual(request.payload);
    expect(second?.payload).toEqual(request.payload);
  });

  it('maps upstream errors to the originating renderer ID and rejects mismatched results', async () => {
    const errorRelay = async (req: IpcRequest): Promise<IpcResult> => ({
      schemaVersion: 1, ok: false, error: { code: 'TIMEOUT', message: 'Timed out.', retryable: true, requestId: req.requestId },
    });
    const mismatchRelay = async (): Promise<IpcResult> => ({ schemaVersion: 1, ok: true, requestId: 'wrong-id', snapshot });
    await expect(routeRequest(center, sender(center), [getSnapshot], errorRelay, undefined)).resolves.toMatchObject({
      ok: false, error: { code: 'TIMEOUT', requestId: getSnapshot.requestId, retryable: true },
    });
    await expect(routeRequest(center, sender(center), [getSnapshot], mismatchRelay, undefined)).resolves.toMatchObject({
      ok: false, error: { code: 'INTERNAL_ERROR', requestId: getSnapshot.requestId },
    });
    const thrown = await routeRequest(center, sender(center), [getSnapshot], async () => { throw new Error('Private details'); }, undefined);
    expect(thrown).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(JSON.stringify(thrown)).not.toContain('Private details');
  });
});

describe('Main desktop window policy', () => {
  it('creates only visible, home pet windows irrespective of primary selection', () => {
    const home: PetSnapshot = {
      petId: 'pet-a', characterId: 'a', nickname: 'A', presence: 'HOME', activity: 'IDLE', mood: 'CALM',
      healthStatus: 'NORMAL', visibility: 'VISIBLE', moodScore: 50, healthPoints: 100, energy: 100, bond: 0,
      level: 1, xp: 0, revision: 0,
    };
    expect(visibleHomePetIds({ ...snapshot, primaryPetId: 'pet-b', pets: [home,
      { ...home, petId: 'pet-b', visibility: 'HIDDEN' },
      { ...home, petId: 'pet-c', presence: 'AWAY', activity: null,
        trip: { tripId: 'trip-a', routeId: 'route-a', status: 'TRAVELING', expectedReturnAt: 123 } },
      { ...home, petId: 'pet-d' },
    ] })).toEqual(['pet-a', 'pet-d']);
  });

  it('uses DIP workArea, handles negative display coordinates and clamps windows on a smaller display', () => {
    expect(clampBounds({ x: 50, y: -20, width: 260, height: 295 }, { x: -1920, y: 0, width: 1920, height: 1000 }))
      .toEqual({ x: -260, y: 0, width: 260, height: 295 });
    expect(clampBounds({ x: -1920, y: 500, width: 900, height: 680 }, { x: 0, y: 0, width: 640, height: 480 }))
      .toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });
});

describe('Main auto-mode pet input lease', () => {
  afterEach(() => vi.useRealTimers());
  const bounds = { x: -300, y: 20, width: 260, height: 295 };
  const cursor = { x: -100, y: 100 };

  it('checks screen DIP cursor within the same half-open rectangle, including negative coordinates', () => {
    expect(isCursorInBounds(cursor, bounds)).toBe(true);
    expect(isCursorInBounds({ x: -300, y: 20 }, bounds)).toBe(true);
    expect(isCursorInBounds({ x: -40, y: 100 }, bounds)).toBe(false);
    expect(isCursorInBounds({ x: -100, y: 315 }, bounds)).toBe(false);
    expect(isCursorInBounds({ x: 100, y: 100 }, bounds)).toBe(false);
  });

  it('expires after two seconds unless renewed with a cursor in bounds', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const expire = vi.fn();
    const lease = new InputLease(expire);
    expect(lease.active).toBe(false);
    expect(lease.renew(cursor, bounds)).toBe(true);
    vi.advanceTimersByTime(1_500);
    expect(lease.active).toBe(true);
    expect(lease.renew(cursor, bounds)).toBe(true);
    vi.advanceTimersByTime(1_999);
    expect(lease.active).toBe(true);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lease.active).toBe(false);
    expect(expire).toHaveBeenCalledOnce();
  });

  it('revokes an active lease on cursor mismatch or explicit clear and cancels its stale timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const expire = vi.fn();
    const lease = new InputLease(expire);
    expect(lease.renew(cursor, bounds)).toBe(true);
    expect(lease.renew({ x: 1, y: 0 }, bounds)).toBe(false);
    expect(lease.active).toBe(false);
    expect(lease.renew(cursor, bounds)).toBe(true);
    lease.clear();
    expect(lease.active).toBe(false);
    vi.advanceTimersByTime(4_000);
    expect(expire).not.toHaveBeenCalled();
  });
});
