import { createHash, randomInt, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { AppService, SCHEMA_VERSION, SQLiteRepository, verifyRestoreBackup } from '@pet-desktop/app-service';
import type { SqliteConnection } from '@pet-desktop/app-service';

type OpenDatabase = (filename: string, readOnly?: boolean) => SqliteConnection;

export type RestoreStatus = 'NONE' | 'PENDING' | 'RESTORED' | 'FAILED';
interface RestorePlan {
  status: Exclude<RestoreStatus, 'NONE'>;
  token: string;
  device: string;
  inode: string;
  sha256: string;
}

function stat(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}

function directFile(path: string): BigIntStats {
  const info = stat(path);
  if (!info?.isFile() || info.isSymbolicLink() || !samePath(realpathSync.native(path), path)) throw new Error('Expected a direct file');
  return info;
}

function directDirectory(path: string): void {
  const info = stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync.native(path), path)) throw new Error('Expected a direct directory');
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameContent(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

const sidecars = ['-wal', '-shm', '-journal'] as const;

function requireClosedFile(path: string): void {
  if (sidecars.some(suffix => stat(path + suffix) !== undefined)) throw new Error('Database has journal sidecars');
}

function copySource(source: string, candidate: string, live: BigIntStats): void {
  if (!isAbsolute(source) || source.length > 4096 || source.startsWith('\\\\') || source.startsWith('//')
    || extname(source).toLowerCase() !== '.sqlite3' || /[\u0000-\u001f\u007f:]/u.test(basename(source))) {
    throw new Error('Invalid selected backup path');
  }
  const info = directFile(source);
  if (sameFile(info, live) || info.size < 100n) throw new Error('The backup is invalid or is the live save');
  requireClosedFile(source);
  const input = openSync(source, 'r');
  try {
    if (!sameContent(info, fstatSync(input, { bigint: true }))) throw new Error('Selected backup changed');
    const output = openSync(candidate, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0n;
      while (copied < info.size) {
        const remaining = info.size - copied;
        const length = readSync(input, buffer, 0, Math.min(buffer.length, Number(remaining)), null);
        if (length === 0) throw new Error('Selected backup became shorter');
        for (let written = 0; written < length;) {
          const count = writeSync(output, buffer, written, length - written);
          if (count === 0) throw new Error('Could not copy selected backup');
          written += count;
        }
        copied += BigInt(length);
      }
      requireClosedFile(source);
      if (!sameContent(info, fstatSync(input, { bigint: true })) || !sameContent(info, directFile(source))) {
        throw new Error('Selected backup changed');
      }
      fsyncSync(output);
    } finally { closeSync(output); }
  } finally { closeSync(input); }
}

function verifyCandidate(path: string, open: OpenDatabase): number {
  requireClosedFile(path);
  const reference = open(':memory:');
  try {
    const database = open(path, true);
    try { return verifyRestoreBackup(database, reference); }
    finally { database.close(); }
  } finally { reference.close(); }
}

function fileDigest(path: string): string {
  const before = directFile(path);
  const input = openSync(path, 'r');
  try {
    if (!sameContent(before, fstatSync(input, { bigint: true }))) throw new Error('Restore stage changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const length = readSync(input, buffer, 0, buffer.length, null);
      if (length === 0) break;
      hash.update(buffer.subarray(0, length));
    }
    if (!sameContent(before, fstatSync(input, { bigint: true })) || !sameContent(before, directFile(path))) {
      throw new Error('Restore stage changed');
    }
    return hash.digest('hex');
  } finally { closeSync(input); }
}

function migrateAndAudit(path: string, open: OpenDatabase): void {
  const database = open(path);
  let repository: SQLiteRepository | undefined;
  try {
    database.exec('PRAGMA trusted_schema = OFF');
    // The original selected backup remains untouched. Only this private copy
    // can be changed if a migration or the gameplay startup audit fails.
    repository = new SQLiteRepository(database, { persistent: true, beforeMigration: () => {} });
    repository.transaction(tx => {
      if (!tx.getPreferences() || !tx.listPets().length) throw new Error('Backup has no initialized game');
    });
    new AppService(repository, {
      now: Date.now,
      createId: kind => `${kind}-${randomUUID()}`,
      seed: () => randomInt(1, 0x1_0000_0000),
    });
    database.exec('PRAGMA journal_mode = DELETE');
  } finally {
    if (repository) repository.close();
    else database.close();
  }
}

function parsePlan(path: string): RestorePlan | undefined {
  if (!stat(path)) return undefined;
  if (directFile(path).size > 4096n) throw new Error('Invalid restore plan');
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || !('status' in data) || !('token' in data) || !('device' in data) || !('inode' in data) || !('sha256' in data)
    || (data.status !== 'PENDING' && data.status !== 'RESTORED' && data.status !== 'FAILED')
    || typeof data.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(data.token)
    || typeof data.device !== 'string' || !/^\d{1,25}$/u.test(data.device)
    || typeof data.inode !== 'string' || !/^\d{1,25}$/u.test(data.inode)
    || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(data.sha256)) throw new Error('Invalid restore plan');
  return { status: data.status, token: data.token, device: data.device, inode: data.inode, sha256: data.sha256 };
}

function persistPlan(path: string, plan: RestorePlan): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(plan), { flag: 'wx', mode: 0o600, flush: true });
  try { renameSync(temporary, path); }
  finally { if (stat(temporary)) unlinkSync(temporary); }
}

function plannedFile(info: BigIntStats | undefined, plan: RestorePlan): boolean {
  return !!info?.isFile() && !info.isSymbolicLink() && String(info.dev) === plan.device && String(info.ino) === plan.inode;
}

/** Called in the sole utility process. Preparing can run against its normal
 * writer because it opens only private staging files. Applying runs before
 * opening the live database, after Main has observed the old process exit. */
export function createBackupRestore(databasePath: string, open: OpenDatabase) {
  const directory = join(dirname(databasePath), '.pet-restore');
  const statePath = join(directory, 'state.json');
  const sourcePath = (token: string) => join(directory, `${token}.sqlite3`);
  const previousPath = (token: string) => join(dirname(databasePath), `${basename(databasePath, extname(databasePath))}.pre-restore-${token}.sqlite3`);

  function readPlan(): RestorePlan | undefined {
    if (!stat(directory)) return undefined;
    directDirectory(directory);
    return parsePlan(statePath);
  }

  function prepare(source: string): void {
    const current = readPlan();
    if (current?.status === 'PENDING') throw new Error('Another restore is already pending');
    directDirectory(dirname(databasePath));
    if (!stat(directory)) mkdirSync(directory, { mode: 0o700 });
    directDirectory(directory);
    const token = randomUUID();
    const candidate = sourcePath(token);
    try {
      copySource(source, candidate, directFile(databasePath));
      verifyCandidate(candidate, open);
      migrateAndAudit(candidate, open);
      if (verifyCandidate(candidate, open) !== SCHEMA_VERSION) throw new Error('Backup migration incomplete');
      const verified = directFile(candidate);
      persistPlan(statePath, { status: 'PENDING', token, device: String(verified.dev), inode: String(verified.ino), sha256: fileDigest(candidate) });
    } catch (error) {
      // The token was allocated for this operation. Only its private files
      // are eligible for cleanup. The external backup is never changed.
      for (const suffix of ['', ...sidecars]) {
        const file = candidate + suffix;
        if (stat(file)) unlinkSync(file);
      }
      throw error;
    }
  }

  function applyPending(): void {
    const plan = readPlan();
    if (!plan || plan.status !== 'PENDING') return;
    const candidate = sourcePath(plan.token);
    if (plannedFile(stat(databasePath), plan) && !stat(candidate)) {
      // The replace succeeded before a crash writing the final status.
      persistPlan(statePath, { ...plan, status: 'RESTORED' });
      return;
    }
    let replaced = false;
    try {
      const original = directFile(databasePath);
      if (!plannedFile(directFile(candidate), plan) || fileDigest(candidate) !== plan.sha256
        || verifyCandidate(candidate, open) !== SCHEMA_VERSION) throw new Error('Restore stage changed');
      requireClosedFile(databasePath);
      const preserved = previousPath(plan.token);
      if (!stat(preserved)) linkSync(databasePath, preserved);
      if (!sameFile(original, directFile(preserved)) || !sameFile(original, directFile(databasePath))) throw new Error('Live database changed');
      requireClosedFile(databasePath);
      // Both paths share a filesystem. Replacement is the single commit
      // point, after preserving the full closed original under a new name.
      renameSync(candidate, databasePath);
      replaced = true;
    } catch {
      persistPlan(statePath, { ...plan, status: 'FAILED' });
      if (plannedFile(stat(candidate), plan)) unlinkSync(candidate);
    }
    if (replaced) persistPlan(statePath, { ...plan, status: 'RESTORED' });
  }

  return { prepare, applyPending, status: (): RestoreStatus => readPlan()?.status ?? 'NONE' };
}
