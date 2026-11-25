/**
 * Development-only Node fork harness, not the packaged Electron utilityProcess.
 *
 * The trusted parent supplies an absolute database filename at startup. IPC
 * accepts only closed request/shutdown envelopes; neither SQL nor filesystem
 * operations are transport commands. The embedded request is validated by
 * AppService against the V1 DTOs.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

let phase = 'booting';
let database;
let repository;
let service;

const runtime = {
  now: () => Date.now(),
  createId: (kind) => `${kind}-${randomUUID()}`,
  seed: () => {
    // The gameplay PRNG requires a nonzero unsigned 32-bit initial state.
    let value;
    do {
      value = randomBytes(4).readUInt32LE(0);
    } while (value === 0);
    return value;
  },
};

function dropChannel() {
  if (!process.connected) return;
  try {
    process.disconnect();
  } catch {
    process.exitCode = 1;
  }
}

function closeResources() {
  try {
    // Ownership moves up as startup completes. Close exactly once on the
    // normal path, including when the repository constructor failed.
    (service ?? repository ?? database)?.close();
    return true;
  } catch {
    // Best effort release if the higher-layer close failed.
    try {
      database?.close();
    } catch {
      // Public transport errors never contain exception details.
    }
    return false;
  } finally {
    service = repository = database = undefined;
  }
}

function finish(code, message) {
  if (phase === 'stopping') return;
  phase = 'stopping';
  if (!closeResources()) {
    code = 1;
    message = { kind: 'fatal', code: 'CLOSE_FAILED' };
  }
  process.exitCode = code;
  if (message && process.connected && typeof process.send === 'function') {
    // Send the terminal response only after the sole writer is closed. Wait
    // for Node to flush the message before disconnecting the channel.
    try {
      process.send(message, (error) => {
        if (error) process.exitCode = 1;
        dropChannel();
      });
      return;
    } catch {
      process.exitCode = 1;
    }
  }
  dropChannel();
}

function post(message) {
  try {
    if (!process.connected || typeof process.send !== 'function') {
      finish(1);
      return;
    }
    process.send(message, (error) => {
      if (error) finish(1);
    });
  } catch {
    finish(1);
  }
}

function hasExactKeys(message, ...keys) {
  return message !== null && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).length === keys.length &&
    keys.every((key) => Object.hasOwn(message, key));
}

process.on('message', (message) => {
  if (phase === 'stopping') return;
  if (phase !== 'ready') {
    finish(1, { kind: 'fatal', code: 'PROTOCOL_ERROR' });
    return;
  }
  if (hasExactKeys(message, 'kind', 'request') && message.kind === 'request') {
    try {
      post({ kind: 'result', result: service.handleRequest(message.request) });
    } catch {
      finish(1, { kind: 'fatal', code: 'SERVICE_FAILED' });
    }
  } else if (hasExactKeys(message, 'kind') && message.kind === 'shutdown') {
    finish(0, { kind: 'stopped' });
  } else {
    // A malformed transport frame is distinct from a malformed embedded DTO.
    // Fail closed; no part of the frame can change the configured database.
    finish(1, { kind: 'fatal', code: 'PROTOCOL_ERROR' });
  }
});
process.on('disconnect', () => finish(0));
process.on('error', () => finish(1));
process.once('SIGTERM', () => finish(0));
process.once('SIGINT', () => finish(0));

async function start() {
  if (!process.connected || typeof process.send !== 'function') {
    finish(1);
    return;
  }
  const filename = process.argv[2];
  if (process.argv.length !== 3 || !filename || !isAbsolute(filename) || filename.includes('\0')) {
    finish(1, { kind: 'fatal', code: 'INVALID_STARTUP' });
    return;
  }
  // Refuse an old built-in driver *before* opening an on-disk database: it
  // might already be in WAL mode. The repository independently checks
  // SELECT sqlite_version() when configuring the actual connection.
  const [major = 0, minor = 0, patch = 0] = (process.versions.sqlite ?? '').split('.').map(Number);
  if (!(major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3))) {
    finish(1, { kind: 'fatal', code: 'STARTUP_FAILED' });
    return;
  }
  try {
    // Dynamic imports let us report a sanitized fatal startup error even on a
    // Node runtime where the built-in SQLite driver is unavailable.
    const [{ DatabaseSync }, { SQLiteRepository }, { AppService }, { verifyMigrationBackup }] = await Promise.all([
      import('node:sqlite'),
      import('./sqlite-repository.ts'),
      import('./app-service.ts'),
      import('./migration-backup.ts'),
    ]);
    if (phase !== 'booting') return; // Parent disconnected during module load.
    database = new DatabaseSync(filename, { allowExtension: false });
    repository = new SQLiteRepository(database, {
      persistent: true,
      beforeMigration: (fromVersion, toVersion) => {
        const backup = `${filename}.pre-v${fromVersion}-to-v${toVersion}-${randomUUID()}.sqlite3`;
        verifyMigrationBackup(database, backup, fromVersion, (path) => new DatabaseSync(path, { readOnly: true, allowExtension: false }));
      },
    });
    const { version: sqliteVersion } = database.prepare('SELECT sqlite_version() AS version').get();
    service = new AppService(repository, runtime);
    phase = 'ready';
    post({ kind: 'ready', schemaVersion: 1, sqliteVersion });
  } catch {
    // Refusing an unsupported SQLite version is also a startup failure. Never
    // fall back to an in-memory database, replace the file, or enable old WAL.
    finish(1, { kind: 'fatal', code: 'STARTUP_FAILED' });
  }
}

await start();
