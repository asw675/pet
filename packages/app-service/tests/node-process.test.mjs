import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ipcResultSchema } from '@pet-desktop/contracts';

const entry = fileURLToPath(new URL('../src/node-process-entry.mjs', import.meta.url));
const waitMs = 6_000;
const testMs = 25_000;
// Match the conservative repository version floor. The process itself must
// still verify the actual driver version and WAL before sending ready.
const sqliteVersion = process.versions.sqlite ?? '';
const [major = 0, minor = 0, patch = 0] = sqliteVersion.split('.').map(Number);
const patchedSqlite = major > 3 || major === 3 &&
  (minor > 51 || minor === 51 && patch >= 3);

function forkService(filename) {
  const child = fork(entry, [filename], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
    execArgv: process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')
      ? ['--experimental-strip-types']
      : [],
  });
  const changes = new EventEmitter();
  const messages = [];
  let failure;
  let exited;
  child.on('message', (message) => {
    messages.push(message);
    changes.emit('changed');
  });
  child.on('error', (error) => {
    failure = error;
    changes.emit('changed');
  });
  const recordExit = (code, signal) => {
    exited ??= { code, signal };
    changes.emit('changed');
  };
  // For parent-initiated disconnect, Node 26 emits 'exit' but can omit the
  // ChildProcess 'close' event. 'exit' confirms that this OS writer is gone;
  // 'close' is only a fallback for a failed spawn.
  child.on('exit', recordExit);
  child.on('close', recordExit);
  child.on('disconnect', () => changes.emit('changed'));

  function waitFor(read, description) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        clearTimeout(timer);
        changes.off('changed', changed);
      }
      function changed() {
        try {
          const value = read();
          if (value !== undefined) {
            cleanup();
            resolve(value);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${description}`));
      }, waitMs);
      changes.on('changed', changed);
      changed();
    });
  }

  return {
    async receive(kind) {
      const message = await waitFor(() => {
        if (messages.length > 0) return messages.shift();
        if (failure) throw failure;
        if (exited && !child.connected) throw new Error(`Child exited before ${kind} (code ${exited.code}, signal ${exited.signal})`);
        return undefined;
      }, kind);
      expect(message?.kind, message?.kind === 'fatal' ? `Child fatal: ${message.code}` : `Expected ${kind} frame`).toBe(kind);
      return message;
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out sending request')), waitMs);
        try {
          child.send(message, (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    disconnect() {
      child.disconnect();
    },
    exit() {
      return waitFor(() => exited, 'child exit');
    },
    async cleanup() {
      // A timeout or a failed assertion must never leave a writer running.
      if (!exited) child.kill('SIGKILL');
      await this.exit();
    },
  };
}

async function withDatabase(test) {
  const directory = mkdtempSync(join(tmpdir(), 'pet-desktop-process-'));
  const filename = join(directory, '用户 pets.sqlite3');
  const children = [];
  const start = (file = filename) => {
    const child = forkService(file);
    children.push(child);
    return child;
  };
  try {
    await test(start, filename);
  } finally {
    // Wait for every child before removing only the directory created above.
    // If cleanup itself fails, leave the temporary database intact.
    const cleanupResults = await Promise.allSettled(children.map((child) => child.cleanup()));
    const failures = cleanupResults.filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Child cleanup failed');
    rmSync(directory, { recursive: true, force: true });
  }
}

function snapshotRequest(requestId) {
  return { schemaVersion: 1, requestId, method: 'snapshot/get', payload: {} };
}

function commandRequest(requestId, command) {
  return { schemaVersion: 1, requestId, method: 'command/dispatch', payload: { command } };
}

async function request(child, raw) {
  await child.send({ kind: 'request', request: raw });
  const response = await child.receive('result');
  return ipcResultSchema.parse(response.result);
}

function expectSuccess(result, requestId) {
  expect(result).toMatchObject({ ok: true, requestId, schemaVersion: 1 });
  return result.snapshot;
}

async function ready(child) {
  expect(await child.receive('ready')).toEqual({ kind: 'ready', schemaVersion: 1, sqliteVersion });
}

async function shutdown(child) {
  await child.send({ kind: 'shutdown' });
  expect(await child.receive('stopped')).toEqual({ kind: 'stopped' });
  expect(await child.exit()).toEqual({ code: 0, signal: null });
}

it.skipIf(!patchedSqlite)('runs a real child, persists a selection and interaction, and replays command receipts after restart', async () => {
  await withDatabase(async (start) => {
    const first = start();
    await ready(first);
    const initial = expectSuccess(await request(first, snapshotRequest('snapshot-initial')), 'snapshot-initial');
    const target = initial.pets.find((pet) => pet.petId !== initial.primaryPetId);
    expect(target).toBeDefined();

    // An unsupported embedded DTO is a public application error; the
    // transport remains usable afterwards.
    const invalid = await request(first, { ...snapshotRequest('invalid-version'), schemaVersion: 2 });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const select = {
      commandId: 'select-once', issuedAt: Date.now(), expectedRevision: initial.revision,
      type: 'PET_SELECT', payload: { petId: target.petId },
    };
    const selected = expectSuccess(await request(first, commandRequest('select', select)), 'select');
    expect(selected.primaryPetId).toBe(target.petId);
    expect(selected.revision).toBeGreaterThan(initial.revision);

    const interact = {
      commandId: 'interact-once', issuedAt: Date.now(), expectedRevision: selected.revision,
      type: 'PET_INTERACT', payload: { petId: target.petId, interaction: 'PET' },
    };
    const interacted = expectSuccess(await request(first, commandRequest('interact', interact)), 'interact');
    expect(interacted.pets.find((pet) => pet.petId === target.petId).bond).toBe(target.bond + 1);
    expect(interacted.revision).toBeGreaterThan(selected.revision);

    expect(expectSuccess(await request(first, commandRequest('duplicate', interact)), 'duplicate')).toEqual(interacted);
    expect(expectSuccess(await request(first, snapshotRequest('before-stop')), 'before-stop')).toEqual(interacted);
    await shutdown(first);

    // Do not launch a replacement writer until the old OS process has exited.
    const second = start();
    await ready(second);
    expect(expectSuccess(await request(second, snapshotRequest('after-restart')), 'after-restart')).toEqual(interacted);
    expect(expectSuccess(await request(second, commandRequest('duplicate-restart', interact)), 'duplicate-restart')).toEqual(interacted);
    const conflict = await request(second, commandRequest('command-conflict', {
      ...interact, payload: { ...interact.payload, interaction: 'REST' },
    }));
    expect(conflict).toMatchObject({ ok: false, error: { code: 'COMMAND_CONFLICT' } });
    expect(expectSuccess(await request(second, snapshotRequest('final')), 'final')).toEqual(interacted);
    await shutdown(second);
  });
}, testMs);

it.skipIf(!patchedSqlite)('rejects extra transport fields and gracefully closes the writer on parent disconnect', async () => {
  await withDatabase(async (start, filename) => {
    const first = start();
    await ready(first);
    const forbiddenFilename = `${filename}.other`;
    await first.send({ kind: 'request', request: snapshotRequest('wrong-envelope'), databasePath: forbiddenFilename });
    expect(await first.receive('fatal')).toEqual({ kind: 'fatal', code: 'PROTOCOL_ERROR' });
    expect(await first.exit()).toEqual({ code: 1, signal: null });
    expect(existsSync(forbiddenFilename)).toBe(false);

    const second = start();
    await ready(second);
    second.disconnect();
    expect(await second.exit()).toEqual({ code: 0, signal: null });
  });
}, testMs);

it.skipIf(patchedSqlite)('fails closed before ready on an unpatched or unavailable SQLite runtime', async () => {
  await withDatabase(async (start, filename) => {
    const child = start();
    expect(await child.receive('fatal')).toEqual({ kind: 'fatal', code: 'STARTUP_FAILED' });
    expect(await child.exit()).toEqual({ code: 1, signal: null });
    expect(existsSync(filename)).toBe(false);
    expect(existsSync(`${filename}-wal`)).toBe(false);
  });
}, testMs);

it('requires the trusted parent to supply an absolute database filename', async () => {
  await withDatabase(async (start) => {
    const child = start(':memory:');
    expect(await child.receive('fatal')).toEqual({ kind: 'fatal', code: 'INVALID_STARTUP' });
    expect(await child.exit()).toEqual({ code: 1, signal: null });
  });
}, testMs);
