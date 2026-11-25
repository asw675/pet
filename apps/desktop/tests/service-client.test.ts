import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, IpcRequest, IpcResult } from '@pet-desktop/contracts';
import { ServiceClient } from '../src/main/service-client.js';
import type { ServiceChild, ServiceClientOptions } from '../src/main/service-client.js';
import { serviceInputSchema } from '../src/shared/protocol.js';
import type { ServiceInput, ServiceStatus } from '../src/shared/protocol.js';

class FakeChild implements ServiceChild {
  readonly messages: ServiceInput[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  readonly kill = vi.fn(() => true);
  failPost = false;

  postMessage(message: unknown): void {
    if (this.failPost) throw new Error('sensitive internal details /path-to-user-data');
    this.messages.push(serviceInputSchema.parse(message));
  }

  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(...args: ['message', (message: unknown) => void] | ['exit', (code: number) => void]): this {
    if (args[0] === 'message') this.messageListeners.add(args[1]);
    else this.exitListeners.add(args[1]);
    return this;
  }

  message(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  ready(): void {
    this.message({ kind: 'ready', schemaVersion: 1, sqliteVersion: '3.53.0', driver: 'better-sqlite3' });
  }

  exit(code = 1): void {
    for (const listener of this.exitListeners) listener(code);
  }

  bootstrap(revision = 0): void {
    this.ready();
    const boot = this.messages.at(-1);
    if (boot?.kind !== 'request') throw new Error('Missing initial snapshot request.');
    expect(boot.request.method).toBe('snapshot/get');
    this.message({ kind: 'result', result: success(boot.request.requestId, revision) });
  }
}

function snapshot(revision: number): AppSnapshot {
  return { revision, primaryPetId: null, pets: [], walletCoins: 0, doNotDisturb: false, pausedRender: false };
}

function request(requestId: string): IpcRequest {
  return { schemaVersion: 1, method: 'snapshot/get', requestId, payload: {} };
}

function command(requestId: string): IpcRequest {
  return { schemaVersion: 1, method: 'command/dispatch', requestId, payload: { command: {
    type: 'APP_SET_MODE', commandId: 'command-1', issuedAt: 1, payload: { flag: 'doNotDisturb', enabled: true },
  } } };
}

function success(requestId: string, revision: number): IpcResult {
  return { schemaVersion: 1, ok: true, requestId, snapshot: snapshot(revision) };
}

function permanentFailure(requestId: string): IpcResult {
  return { schemaVersion: 1, ok: false, error: {
    requestId, code: 'SERVICE_UNAVAILABLE', message: 'Storage requires restart.', retryable: false,
  } };
}

function setup(options: Omit<ServiceClientOptions, 'spawn'> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const client = new ServiceClient({ spawn, requestTimeoutMs: 50, startupTimeoutMs: 100,
    shutdownTimeoutMs: 20, restartDelayMs: 10, maxRestarts: 2, ...options });
  const current = () => {
    const child = children.at(-1);
    if (!child) throw new Error('No spawned child.');
    return child;
  };
  return { client, spawn, current };
}

describe('ServiceClient', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('correlates a gallery query by ID and method before publishing its snapshot', async () => {
    const { client, current } = setup();
    const revisions: number[] = [];
    client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    const child = current();
    child.bootstrap(1);
    const request: IpcRequest = { schemaVersion: 1, requestId: 'gallery', method: 'gallery/list', payload: { filter: 'ALL', offset: 0, limit: 10 } };
    const list = client.request(request);
    const galleryResult: IpcResult = { schemaVersion: 1, ok: true, requestId: 'gallery', snapshot: snapshot(2),
      gallery: { revision: 2, rows: [], total: 0, offset: 0, limit: 10 } };
    child.message({ kind: 'result', result: galleryResult });
    expect(await list).toEqual(galleryResult);
    expect(revisions).toEqual([1, 2]);
    const wrong = client.request({ ...request, requestId: 'wrong-method' });
    child.message({ kind: 'result', result: success('wrong-method', 50) });
    expect(await wrong).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(revisions).toEqual([1, 2]);
    expect(client.getStatus().stage).not.toBe('READY');
  });

  it('does not complete bootstrap from a gallery-shaped success result', () => {
    const { client, current } = setup();
    const revisions: number[] = [];
    client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    const child = current();
    child.ready();
    const bootstrap = child.messages.at(-1);
    if (bootstrap?.kind !== 'request') throw new Error('Missing bootstrap');
    child.message({ kind: 'result', result: { schemaVersion: 1, ok: true, requestId: bootstrap.request.requestId,
      snapshot: snapshot(5), gallery: { revision: 5, rows: [], total: 0, offset: 0, limit: 10 } } });
    expect(revisions).toEqual([]);
    expect(client.getStatus().stage).not.toBe('READY');
  });

  it('initializes once, waits for a valid ready handshake and loads an authoritative snapshot', async () => {
    const { client, current, spawn } = setup();
    const stages: ServiceStatus[] = [];
    const revisions: number[] = [];
    const offStatus = client.subscribeStatus((status) => stages.push(status));
    const offSnapshot = client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    client.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toEqual({ stage: 'STARTING', generation: 1 });
    const child = current();
    expect(await client.request(command('too-early'))).toMatchObject({ ok: false, error: {
      code: 'SERVICE_UNAVAILABLE', requestId: 'too-early', retryable: true,
    } });
    expect(child.messages).toEqual([]);
    child.ready();
    const bootstrap = child.messages.at(-1);
    expect(bootstrap?.kind).toBe('request');
    if (bootstrap?.kind !== 'request') throw new Error('Missing initial snapshot request.');
    expect(bootstrap.request.method).toBe('snapshot/get');
    expect(client.getStatus().stage).toBe('STARTING');
    child.message({ kind: 'result', result: success('unknown', 99) });
    expect(revisions).toEqual([]);
    child.message({ kind: 'result', result: success(bootstrap.request.requestId, 2) });
    expect(revisions).toEqual([2]);
    expect(stages).toEqual([{ stage: 'STARTING', generation: 1 }, { stage: 'READY', generation: 1 }]);
    offStatus();
    offSnapshot();
    child.message({ kind: 'snapshot', snapshot: snapshot(3) });
    child.exit();
    expect(revisions).toEqual([2]);
    expect(stages).toHaveLength(2);
  });

  it('routes concurrent results by ID, drops uncorrelated results and emits only newer revisions', async () => {
    const { client, current } = setup();
    const revisions: number[] = [];
    client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    const child = current();
    child.bootstrap(10);
    const a = client.request(request('a'));
    const b = client.request(request('b'));
    expect(child.messages.slice(1)).toEqual([{ kind: 'request', request: request('a') },
      { kind: 'request', request: request('b') }]);
    child.message({ kind: 'result', result: success('b', 12) });
    child.message({ kind: 'result', result: success('unknown', 99) });
    child.message({ kind: 'result', result: success('a', 11) });
    child.message({ kind: 'snapshot', snapshot: snapshot(12) });
    child.message({ kind: 'snapshot', snapshot: snapshot(13) });
    child.message({ kind: 'snapshot', snapshot: snapshot(3) });
    expect(await a).toEqual(success('a', 11));
    expect(await b).toEqual(success('b', 12));
    expect(revisions).toEqual([10, 12, 13]);
  });

  it('rejects duplicate/invalid request IDs; expired requests can never resolve new work', async () => {
    const { client, current } = setup();
    const revisions: number[] = [];
    client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    const child = current();
    child.bootstrap();
    const pending = client.request(request('x'));
    const duplicate = await client.request(request('x'));
    expect(ipcResultSchema.safeParse(duplicate).success).toBe(true);
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', requestId: 'x' } });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TIMEOUT', requestId: 'x', retryable: true } });
    child.message({ kind: 'result', result: success('x', 50) });
    expect(revisions).toEqual([0]);
    expect(await client.request(request('x'))).toEqual(duplicate);
    expect(await client.request(request('/private/path'))).toMatchObject({ ok: false, error: {
      code: 'INVALID_REQUEST', requestId: 'invalid-request',
    } });
    expect(child.messages).toHaveLength(2);
    const fresh = client.request(request('y'));
    child.message({ kind: 'result', result: success('y', 1) });
    expect(await fresh).toEqual(success('y', 1));
    expect(await client.request(request('y'))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(revisions).toEqual([0, 1]);
  });

  it('fails in-flight requests on exit, never replays commands, and starts a new revision waterline', async () => {
    const { client, current, spawn } = setup();
    const revisions: number[] = [];
    client.subscribeSnapshot((view) => revisions.push(view.revision));
    client.start();
    const old = current();
    old.bootstrap(5);
    const pending = client.request(command('dispatch'));
    old.exit();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', requestId: 'dispatch' } });
    expect(client.getStatus()).toEqual({ stage: 'RESTARTING', generation: 1 });
    await vi.advanceTimersByTimeAsync(9);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getStatus()).toEqual({ stage: 'RESTARTING', generation: 2 });
    const replacement = current();
    expect(replacement.messages).toEqual([]);
    replacement.bootstrap(4);
    expect(revisions).toEqual([5, 4]);
    expect(client.getStatus()).toEqual({ stage: 'READY', generation: 2 });
    expect(replacement.messages).toHaveLength(1); // Bootstrap only; no replay.
    const fresh = client.request(command('dispatch'));
    old.message({ kind: 'result', result: success('dispatch', 100) });
    old.message({ kind: 'fatal', code: 'SERVICE_FAILED' });
    old.exit();
    expect(revisions).toEqual([5, 4]);
    expect(client.getStatus().stage).toBe('READY');
    replacement.message({ kind: 'result', result: success('dispatch', 6) });
    expect(await fresh).toEqual(success('dispatch', 6));
    expect(revisions).toEqual([5, 4, 6]);
  });

  it('requires exit before replacing a failed or unresponsive writer and enforces the restart budget', async () => {
    const { client, current, spawn } = setup({ maxRestarts: 1 });
    client.start();
    const old = current();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getStatus().stage).toBe('RESTARTING');
    expect(old.messages).toEqual([{ kind: 'shutdown' }]);
    old.message({ kind: 'stopped' });
    await vi.advanceTimersByTimeAsync(200);
    expect(old.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    old.exit();
    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(2);
    const second = current();
    second.ready(); // Ready but no response to bootstrap, same startup deadline.
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 2 });
    expect(second.messages.at(-1)).toEqual({ kind: 'shutdown' });
    second.exit();
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(client.getStatus().stage).toBe('UNAVAILABLE');
  });

  it('treats malformed outputs and permanent service-unavailable errors as controlled faults', async () => {
    const { client, current, spawn } = setup();
    client.start();
    const first = current();
    first.message({ kind: 'ready', schemaVersion: 2, driver: 'better-sqlite3', sqliteVersion: '3.53.0' });
    expect(first.messages).toEqual([{ kind: 'shutdown' }]);
    expect(client.getStatus().stage).toBe('RESTARTING');
    first.exit();
    await vi.advanceTimersByTimeAsync(10);
    const second = current();
    second.bootstrap();
    const error = client.request(request('storage-fault'));
    const unrelated = client.request(request('pending'));
    second.message({ kind: 'result', result: permanentFailure('storage-fault') });
    expect(await error).toEqual(permanentFailure('storage-fault'));
    expect(await unrelated).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(second.messages.at(-1)).toEqual({ kind: 'shutdown' });
    await vi.advanceTimersByTimeAsync(200);
    expect(spawn).toHaveBeenCalledTimes(2);
    second.exit();
    await vi.advanceTimersByTimeAsync(19);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('sanitizes a transport post failure without leaking exception details', async () => {
    const { client, current } = setup();
    client.start();
    const child = current();
    child.bootstrap();
    child.failPost = true;
    const failed = await client.request(request('transport-fault'));
    expect(failed).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', requestId: 'transport-fault' } });
    expect(JSON.stringify(failed)).not.toContain('sensitive');
    expect(client.getStatus().stage).toBe('RESTARTING');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('stops idempotently, refusing requests and waiting for exit after acknowledgement or kill', async () => {
    const { client, current, spawn } = setup();
    client.start();
    const child = current();
    child.bootstrap();
    const pending = client.request(request('pending'));
    const stopped = vi.fn();
    const stop = client.stop();
    void stop.then(stopped);
    expect(client.stop()).toBe(stop);
    expect(client.getStatus().stage).toBe('STOPPING');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(await client.request(request('new'))).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(child.messages.at(-1)).toEqual({ kind: 'shutdown' });
    child.message({ kind: 'result', result: success('pending', 1) });
    child.message({ kind: 'stopped' });
    await vi.advanceTimersByTimeAsync(19);
    expect(stopped).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.kill.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
    child.exit(0);
    await stop;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(client.getStatus().stage).toBe('UNAVAILABLE');
    client.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled restart and handles synchronous spawn failure', async () => {
    const spawn = vi.fn(() => { throw new Error('secret spawn details'); });
    const failed = new ServiceClient({ spawn, maxRestarts: 1, restartDelayMs: 10 });
    failed.start();
    expect(failed.getStatus().stage).toBe('RESTARTING');
    await vi.advanceTimersByTimeAsync(10);
    expect(failed.getStatus()).toEqual({ stage: 'UNAVAILABLE', generation: 2 });
    expect(spawn).toHaveBeenCalledTimes(2);
    await failed.stop();

    const next = setup();
    next.client.start();
    next.current().exit();
    await next.client.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(next.spawn).toHaveBeenCalledTimes(1);
  });
});
