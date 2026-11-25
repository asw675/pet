import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSnapshot, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import type { SqliteConnection } from '@pet-desktop/app-service';
import { openPersistentService } from '../src/app-service/database';
import { SNAPSHOT_TICK_MS, startUtilityTransport } from '../src/app-service/transport';
import { serviceOutputSchema } from '../src/shared/protocol';
import type { ServiceOutput } from '../src/shared/protocol';

const DB = '/trusted/user-data/game.sqlite3';

function projection(revision: number): AppSnapshot {
  return { revision, primaryPetId: null, pets: [], walletCoins: 0, doNotDisturb: false, pausedRender: false };
}

const command: IpcRequest = {
  schemaVersion: 1, requestId: 'req-1', method: 'command/dispatch',
  payload: { command: { commandId: 'cmd-1', issuedAt: 1, type: 'APP_SET_MODE', payload: { flag: 'doNotDisturb', enabled: true } } },
};

function result(snapshot: AppSnapshot): Extract<IpcResult, { ok: true }> {
  return { schemaVersion: 1, ok: true, requestId: command.requestId, snapshot };
}

function fixture() {
  const outputs: ServiceOutput[] = [];
  let current = projection(0);
  const service = {
    getSnapshot: vi.fn(() => current),
    handleRequest: vi.fn((_raw: unknown): IpcResult => result(current)),
    close: vi.fn(),
  };
  const options = {
    args: [DB],
    start: vi.fn((_path: string) => ({ service, sqliteVersion: '3.51.3' })),
    send: vi.fn((message: ServiceOutput) => {
      expect(serviceOutputSchema.safeParse(message).success).toBe(true);
      outputs.push(message);
    }),
    exit: vi.fn(),
  };
  return { service, outputs, options, setProjection: (revision: number) => { current = projection(revision); } };
}

describe('app-service utility transport', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('advertises readiness only after initialization and publishes only changed revisions', () => {
    const f = fixture();
    startUtilityTransport(f.options);
    expect(f.options.start).toHaveBeenCalledExactlyOnceWith(DB);
    expect(f.outputs).toEqual([
      { kind: 'ready', schemaVersion: 1, driver: 'better-sqlite3', sqliteVersion: '3.51.3' },
      { kind: 'snapshot', snapshot: projection(0) },
    ]);
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS * 2);
    expect(f.service.getSnapshot).toHaveBeenCalledTimes(3);
    expect(f.outputs).toHaveLength(2);
    f.setProjection(1);
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS * 2);
    expect(f.outputs.at(-1)).toEqual({ kind: 'snapshot', snapshot: projection(1) });
    expect(f.outputs).toHaveLength(3);
  });

  it('returns the historical command receipt without pushing its stale revision', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    f.service.handleRequest.mockImplementationOnce(() => {
      f.setProjection(1);
      return result(projection(1));
    });
    transport.receive({ kind: 'request', request: command });
    expect(f.service.handleRequest).toHaveBeenCalledExactlyOnceWith(command);
    expect(f.outputs.slice(2)).toEqual([
      { kind: 'result', result: result(projection(1)) },
      { kind: 'snapshot', snapshot: projection(1) },
    ]);

    f.setProjection(2);
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS);
    f.service.handleRequest.mockReturnValueOnce(result(projection(1)));
    transport.receive({ kind: 'request', request: { ...command, requestId: command.requestId } });
    expect(f.outputs.slice(4)).toEqual([
      { kind: 'snapshot', snapshot: projection(2) },
      { kind: 'result', result: result(projection(1)) },
    ]);
  });

  it('pushes the authoritative revision after a command denial if catch-up committed', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    const denied: IpcResult = { schemaVersion: 1, ok: false, error: {
      requestId: command.requestId, code: 'INVALID_REQUEST', message: 'Invalid game command.', retryable: false,
    } };
    f.service.handleRequest.mockImplementationOnce(() => {
      f.setProjection(1);
      return denied;
    });
    transport.receive({ kind: 'request', request: command });
    expect(f.outputs.slice(2)).toEqual([
      { kind: 'result', result: denied }, { kind: 'snapshot', snapshot: projection(1) },
    ]);
  });

  it.each([{ args: [] }, { args: ['relative.sqlite3'] }, { args: [DB, 'extra'] }, { args: [`${DB}\u0000`] }])('rejects malformed startup argv: %j', ({ args }) => {
    const f = fixture();
    startUtilityTransport({ ...f.options, args });
    expect(f.options.start).not.toHaveBeenCalled();
    expect(f.outputs).toEqual([{ kind: 'fatal', code: 'INVALID_STARTUP' }]);
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('redacts startup errors and never reports readiness after recovery failure', () => {
    const f = fixture();
    f.service.getSnapshot.mockImplementationOnce(() => { throw new Error(DB); });
    startUtilityTransport(f.options);
    expect(f.service.close).toHaveBeenCalledTimes(1);
    expect(f.outputs).toEqual([{ kind: 'fatal', code: 'STARTUP_FAILED' }]);
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('fails closed on an extra field or unsupported method in the private protocol', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    transport.receive({ kind: 'request', request: { ...command, databasePath: DB } });
    expect(f.service.handleRequest).not.toHaveBeenCalled();
    expect(f.outputs.at(-1)).toEqual({ kind: 'fatal', code: 'PROTOCOL_ERROR' });
    expect(f.service.close).toHaveBeenCalledTimes(1);
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(1);
    transport.receive({ kind: 'shutdown' });
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  it('rejects result correlation errors without forwarding the mismatched response', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    f.service.handleRequest.mockReturnValueOnce({ ...result(projection(0)), requestId: 'another-id' });
    transport.receive({ kind: 'request', request: command });
    expect(f.outputs.slice(2)).toEqual([{ kind: 'fatal', code: 'PROTOCOL_ERROR' }]);
  });

  it('redacts a tick exception, closes storage and cancels further ticks', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    f.service.getSnapshot.mockImplementationOnce(() => { throw new Error('sensitive row / path'); });
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS * 5);
    expect(f.outputs.at(-1)).toEqual({ kind: 'fatal', code: 'SERVICE_FAILED' });
    expect(f.service.getSnapshot).toHaveBeenCalledTimes(2);
    expect(f.service.close).toHaveBeenCalledTimes(1);
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(1);
    transport.receive({ kind: 'request', request: command });
    expect(f.service.handleRequest).not.toHaveBeenCalled();
  });

  it('does not publish an authoritative revision regression', () => {
    const f = fixture();
    f.setProjection(2);
    startUtilityTransport(f.options);
    f.setProjection(1);
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS);
    expect(f.outputs.slice(2)).toEqual([{ kind: 'fatal', code: 'SERVICE_FAILED' }]);
  });

  it('closes the service before acknowledging shutdown or exiting, then ignores queued requests', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    transport.receive({ kind: 'shutdown' });
    expect(f.outputs.at(-1)).toEqual({ kind: 'stopped' });
    expect(f.service.close.mock.invocationCallOrder[0]!).toBeLessThan(f.options.send.mock.invocationCallOrder.at(-1)!);
    expect(f.options.send.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.options.exit.mock.invocationCallOrder[0]!);
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(0);
    vi.advanceTimersByTime(SNAPSHOT_TICK_MS * 2);
    transport.receive({ kind: 'request', request: command });
    transport.receive({ kind: 'shutdown' });
    transport.abort();
    expect(f.service.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.service.handleRequest).not.toHaveBeenCalled();
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a successful shutdown if the database close fails', () => {
    const f = fixture();
    const transport = startUtilityTransport(f.options);
    f.service.close.mockImplementationOnce(() => { throw new Error(DB); });
    transport.receive({ kind: 'shutdown' });
    expect(f.outputs.at(-1)).toEqual({ kind: 'fatal', code: 'CLOSE_FAILED' });
    expect(f.options.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('SQLite engine preflight', () => {
  function probe(version: unknown): SqliteConnection {
    return { exec: vi.fn(), close: vi.fn(), prepare: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0 })), get: vi.fn(() => ({ version })), all: vi.fn(() => []),
    })) };
  }

  it.each(['3.51.2', '3.9.99', '2.99.99', 'invalid', null])('closes the probe and does not open a save on %j', (version) => {
    const memory = probe(version);
    const open = vi.fn((_filename: string) => memory);
    expect(() => openPersistentService(DB, open)).toThrow();
    expect(open).toHaveBeenCalledExactlyOnceWith(':memory:');
    expect(memory.close).toHaveBeenCalledTimes(1);
  });

  it('closes the supported engine probe before opening the only persistent connection', () => {
    const order: string[] = [];
    const memory = probe('3.51.3');
    const persistent = probe('3.51.3'); // intentionally lacks migration/pragmas
    memory.close = () => { order.push('close:memory'); };
    persistent.close = () => { order.push('close:persistent'); };
    const open = vi.fn((filename: string) => {
      order.push(`open:${filename}`);
      return filename === ':memory:' ? memory : persistent;
    });
    expect(() => openPersistentService(DB, open)).toThrow();
    expect(order).toEqual(['open::memory:', 'close:memory', `open:${DB}`, 'close:persistent']);
  });
});
