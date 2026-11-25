import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { managedBackupDirectory } from '../shared/host-settings-ipc';
import type { PeriodicBackupStatus } from '../shared/host-settings-ipc';

export const PERIODIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const FAILURE_RETRY_MS = 60 * CHECK_INTERVAL_MS;
const SLOT_COUNT = 3;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

interface BackupOptions {
  databasePath: string;
  exportVerified: (destination: string) => void;
  now?: () => number;
  monotonicNow?: () => number;
}

function stat(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function direct(path: string, info: BigIntStats, kind: 'file' | 'directory'): void {
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())) throw new Error('Invalid periodic backup path');
  const actual = normalize(realpathSync.native(path));
  const expected = normalize(path);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) {
    throw new Error('Periodic backup path must be direct');
  }
}

function equalFile(left: BigIntStats | undefined, right: BigIntStats | undefined): boolean {
  if (!left || !right) return left === right;
  return left.ino === right.ino && left.dev === right.dev && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function ownerId(directory: string): string {
  const ownerFile = join(directory, '.owner');
  let info = stat(ownerFile);
  if (!info) {
    const id = randomUUID();
    const pending = join(directory, `.owner-${id}`);
    try {
      writeFileSync(pending, id, { flag: 'wx', mode: 0o600, flush: true });
      linkSync(pending, ownerFile);
    } finally {
      if (stat(pending)?.isFile()) unlinkSync(pending);
    }
    info = stat(ownerFile);
  }
  if (!info || info.size !== 36n) throw new Error('Invalid periodic backup owner');
  direct(ownerFile, info, 'file');
  const id = readFileSync(ownerFile, 'utf8');
  if (!UUID.test(id)) throw new Error('Invalid periodic backup owner');
  return id;
}

function removeAbandonedCandidates(directory: string, prefix: string): void {
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.sqlite3') || !UUID.test(name.slice(prefix.length, -8))) continue;
    const file = join(directory, name);
    const info = stat(file);
    if (!info) continue;
    direct(file, info, 'file');
    unlinkSync(file);
  }
}

/** Runs only on the single app-service event loop after the application's
 * snapshot transaction has completed. Uses the same verified, committed WAL
 * export as manual backups. Rotates only the three app-owned names. */
export function createPeriodicBackup(options: BackupOptions) {
  const directory = join(dirname(options.databasePath), managedBackupDirectory);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let nextCheck = Number.NEGATIVE_INFINITY;
  let lastCompletedAt: number | null = null;
  let failed = false;

  function tick(): void {
    const elapsed = monotonicNow();
    if (!Number.isFinite(elapsed) || elapsed < nextCheck) return;
    nextCheck = elapsed + CHECK_INTERVAL_MS;
    try {
      const wallNow = now();
      if (!Number.isSafeInteger(wallNow) || wallNow < 0 || wallNow > 8.64e15) throw new Error('Invalid periodic backup clock');
      const parent = dirname(directory);
      const parentInfo = stat(parent);
      if (!parentInfo) throw new Error('Periodic backup parent is unavailable');
      direct(parent, parentInfo, 'directory');
      if (!stat(directory)) mkdirSync(directory, { mode: 0o700 });
      const directoryInfo = stat(directory);
      if (!directoryInfo) throw new Error('Periodic backup directory is unavailable');
      direct(directory, directoryInfo, 'directory');
      const owner = ownerId(directory);
      const slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
        const path = join(directory, `pet-automatic-${index + 1}-${owner}.sqlite3`);
        const info = stat(path);
        if (info) direct(path, info, 'file');
        return { path, info, capturedAt: info ? Number(info.mtimeMs) : null };
      });
      const timestamps = slots.flatMap(slot => slot.capturedAt === null ? [] : [slot.capturedAt]);
      lastCompletedAt = timestamps.length ? Math.max(...timestamps) : null;
      if (lastCompletedAt !== null && wallNow - lastCompletedAt < PERIODIC_BACKUP_INTERVAL_MS) return;
      const target = slots.find(slot => !slot.info) ?? slots.reduce((oldest, slot) =>
        (slot.capturedAt ?? 0) < (oldest.capturedAt ?? 0) ? slot : oldest);
      const prefix = `.pending-${owner}-`;
      removeAbandonedCandidates(directory, prefix);
      const candidate = join(directory, `${prefix}${randomUUID()}.sqlite3`);
      let published = false;
      try {
        options.exportVerified(candidate);
        const currentDirectory = stat(directory);
        if (!currentDirectory || currentDirectory.dev !== directoryInfo.dev || currentDirectory.ino !== directoryInfo.ino) {
          throw new Error('Periodic backup directory changed');
        }
        direct(directory, currentDirectory, 'directory');
        const staged = stat(candidate);
        if (!staged) throw new Error('Verified snapshot is absent');
        direct(candidate, staged, 'file');
        if (staged.size < 100n) throw new Error('Verified snapshot is empty');
        utimesSync(candidate, new Date(wallNow), new Date(wallNow));
        const current = stat(target.path);
        if (!equalFile(target.info, current) || ['-wal', '-shm', '-journal'].some(suffix => stat(target.path + suffix))) {
          throw new Error('Periodic backup slot changed or is open');
        }
        if (current) renameSync(candidate, target.path);
        else linkSync(candidate, target.path);
        published = true;
        lastCompletedAt = wallNow;
        failed = false;
      } finally {
        try {
          const currentDirectory = stat(directory);
          if (currentDirectory?.dev === directoryInfo.dev && currentDirectory.ino === directoryInfo.ino && stat(candidate)) unlinkSync(candidate);
        } catch (error) {
          // A later cleanup failure does not invalidate publication. The
          // private candidate remains eligible for the next scheduled pass.
          if (!published) throw error;
        }
      }
    } catch {
      failed = true;
      nextCheck = elapsed + FAILURE_RETRY_MS;
    }
  }

  function status(): PeriodicBackupStatus {
    return { ok: true, status: failed ? 'FAILED' : lastCompletedAt === null ? 'WAITING' : 'AVAILABLE',
      lastCompletedAt: lastCompletedAt === null ? null : new Date(lastCompletedAt).toISOString() };
  }

  return { tick, status };
}
