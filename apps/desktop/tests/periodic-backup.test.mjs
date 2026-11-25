import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppService, SQLiteRepository } from '@pet-desktop/app-service';
import { describe, expect, it, vi } from 'vitest';
import { createBackupExportIo } from '../src/app-service/backup-export-io';
import { createBackupRestore } from '../src/app-service/backup-restore';
import { openPersistentService } from '../src/app-service/database';
import { createPeriodicBackup, PERIODIC_BACKUP_INTERVAL_MS } from '../src/app-service/periodic-backup';
import { startUtilityTransport } from '../src/app-service/transport';
import { managedBackupDirectory } from '../src/shared/host-settings-ipc';

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 25);
const open = (filename, readOnly = false) => new DatabaseSync(filename, { readOnly });

function fixture(action) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pet-periodic-backup-test-')));
  const live = join(root, 'pet.sqlite3');
  const directory = join(root, managedBackupDirectory);
  const repo = new SQLiteRepository(open(live), { persistent: true });
  new AppService(repo, { now: () => START, createId: kind => `test-${kind}`, seed: () => 1 });
  const io = createBackupExportIo(path => open(path, true));
  const exportVerified = vi.fn(destination => repo.exportBackup(destination, io));
  let wall = START, elapsed = 0;
  const clock = { now: () => wall, monotonicNow: () => elapsed };
  const make = () => createPeriodicBackup({ databasePath: live, exportVerified, ...clock });
  try {
    action({ live, directory, repo, exportVerified, make, backup: make(), advance: ms => { wall += ms; elapsed += ms; },
      setWall: time => { wall = time; } });
  } finally { repo.close(); rmSync(root, { recursive: true, force: true }); }
}

function snapshots(directory) {
  return readdirSync(directory).filter(name => /^pet-automatic-[1-3]-[a-f0-9-]{36}\.sqlite3$/u.test(name)).sort()
    .map(name => join(directory, name));
}

function balance(path) {
  const db = open(path, true);
  try {
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    return db.prepare('SELECT balance FROM wallet').get().balance;
  } finally { db.close(); }
}

describe('verified periodic SQLite snapshots', () => {
  it('captures one initial committed snapshot and performs no repeated or restart writes before it is due', () => fixture(({ directory, repo, exportVerified, make, backup, advance, setWall }) => {
    expect(backup.status()).toEqual({ ok: true, status: 'WAITING', lastCompletedAt: null });
    expect(existsSync(directory)).toBe(false);
    repo.transaction(tx => tx.setWalletCoins(42));
    backup.tick();
    expect(backup.status()).toEqual({ ok: true, status: 'AVAILABLE', lastCompletedAt: new Date(START).toISOString() });
    expect(balance(snapshots(directory)[0])).toBe(42);
    const owner = readFileSync(join(directory, '.owner'));
    for (let count = 0; count < 5; count++) backup.tick();
    advance(HOUR);
    backup.tick();
    const restarted = make();
    restarted.tick();
    setWall(START - HOUR);
    make().tick();
    expect(exportVerified).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(directory, '.owner'))).toEqual(owner);
    expect(snapshots(directory)).toHaveLength(1);
  }));

  it('retains the three newest automatic snapshots and leaves unrelated and manual files intact', () => fixture(({ directory, repo, backup, advance }) => {
    const capture = coins => { repo.transaction(tx => tx.setWalletCoins(coins)); backup.tick(); advance(PERIODIC_BACKUP_INTERVAL_MS); };
    capture(10);
    const manual = join(directory, 'manual-backup.sqlite3');
    const unrelated = join(directory, 'pet-automatic-1.sqlite3');
    writeFileSync(manual, 'manual backup marker'); writeFileSync(unrelated, 'not a managed backup');
    capture(20); capture(30); capture(40);
    expect(snapshots(directory).map(balance).sort((a, b) => a - b)).toEqual([20, 30, 40]);
    expect(readFileSync(manual, 'utf8')).toBe('manual backup marker');
    expect(readFileSync(unrelated, 'utf8')).toBe('not a managed backup');
  }));

  it('retains all last-known valid snapshots on export failure and throttles retries', () => fixture(({ directory, repo, exportVerified, backup, advance }) => {
    for (const coins of [10, 20, 30]) {
      repo.transaction(tx => tx.setWalletCoins(coins));
      backup.tick(); advance(PERIODIC_BACKUP_INTERVAL_MS);
    }
    const digests = () => snapshots(directory).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    const before = digests();
    exportVerified.mockImplementationOnce(() => { throw new Error('synthetic disk full'); });
    repo.transaction(tx => tx.setWalletCoins(40));
    backup.tick();
    expect(backup.status()).toEqual({ ok: true, status: 'FAILED', lastCompletedAt: new Date(START + 2 * PERIODIC_BACKUP_INTERVAL_MS).toISOString() });
    expect(digests()).toEqual(before);
    advance(HOUR / 2); backup.tick();
    expect(exportVerified).toHaveBeenCalledTimes(4);
    advance(HOUR / 2); backup.tick();
    expect(exportVerified).toHaveBeenCalledTimes(5);
    expect(backup.status().status).toBe('AVAILABLE');
    expect(snapshots(directory).map(balance).sort((a, b) => a - b)).toEqual([20, 30, 40]);
  }));

  it('creates a file the normal verified restore path can use without consuming the snapshot', () => fixture(({ live, directory, backup, repo }) => {
    repo.transaction(tx => tx.setWalletCoins(17));
    backup.tick();
    const source = snapshots(directory)[0];
    const original = readFileSync(source);
    repo.transaction(tx => tx.setWalletCoins(91));
    const restore = createBackupRestore(live, open);
    restore.prepare(source);
    repo.close();
    restore.applyPending();
    expect(restore.status()).toBe('RESTORED');
    expect(balance(live)).toBe(17);
    expect(readFileSync(source)).toEqual(original);
  }));

  it('runs after the normal utility heartbeat, and reports completion through the closed host authority channel', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pet-periodic-heartbeat-')));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const outputs = [];
    const transport = startUtilityTransport({ args: [join(root, 'pet.sqlite3')],
      start: path => openPersistentService(path, open, { resourcesDirectory: root }), send: value => outputs.push(value), exit() {} });
    try {
      expect(outputs[0]).toMatchObject({ kind: 'ready' });
      expect(existsSync(join(root, managedBackupDirectory))).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(snapshots(join(root, managedBackupDirectory))).toHaveLength(1);
      transport.receive({ kind: 'host-authority-request', requestId: 'backup-status', request: { kind: 'periodic-backup-status' } });
      expect(outputs.at(-1)).toEqual({ kind: 'host-authority-result', requestId: 'backup-status',
        result: { kind: 'periodic-backup-status', result: { ok: true, status: 'AVAILABLE', lastCompletedAt: expect.any(String) } } });
    } finally { transport.receive({ kind: 'shutdown' }); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });
});
