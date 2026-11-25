import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppService, SCHEMA_VERSION, SQLiteRepository } from '@pet-desktop/app-service';
import { describe, expect, it } from 'vitest';
import { createBackupRestore } from '../src/app-service/backup-restore.ts';
import { openPersistentService } from '../src/app-service/database.ts';
import { startUtilityTransport } from '../src/app-service/transport.ts';

const open = (path, readOnly = false) => new DatabaseSync(path, { readOnly });
const runtime = { now: Date.now, createId: kind => `${kind}-restore-test`, seed: () => 1 };

function createSave(path, coins) {
  const database = open(path);
  const repository = new SQLiteRepository(database, { persistent: true });
  const service = new AppService(repository, runtime);
  repository.transaction(tx => tx.setWalletCoins(coins));
  return service;
}

function fixture(action) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pet-restore-test-')));
  const live = join(root, 'pet-desktop.sqlite3');
  const source = join(root, '原始 备份.sqlite3');
  const liveService = createSave(live, 42);
  createSave(source, 7).close();
  try { action({ root, live, source, liveService, restore: createBackupRestore(live, open) }); }
  finally { liveService.close(); rmSync(root, { recursive: true, force: true }); }
}

function balance(path) {
  const database = open(path, true);
  try { return database.prepare('SELECT balance FROM wallet').get().balance; }
  finally { database.close(); }
}

function planLocation(root) {
  const statePath = join(root, '.pet-restore', 'state.json');
  const plan = JSON.parse(readFileSync(statePath, 'utf8'));
  return { plan, candidate: join(root, '.pet-restore', `${plan.token}.sqlite3`),
    previous: join(root, `pet-desktop.pre-restore-${plan.token}.sqlite3`) };
}

describe('verified native backup restore', () => {
  it('stages independently, preserves the closed live save, installs atomically, and cannot reapply', () => fixture(({ root, live, source, liveService, restore }) => {
    const originalSource = readFileSync(source);
    expect(restore.status()).toBe('NONE');
    restore.prepare(source);
    expect(restore.status()).toBe('PENDING');
    expect(liveService.getSnapshot().walletCoins).toBe(42);
    expect(() => restore.prepare(source)).toThrow(/pending/);
    liveService.close();
    const originalLive = readFileSync(live);
    const { candidate, previous } = planLocation(root);
    const restarted = createBackupRestore(live, open);
    restarted.applyPending();
    expect(restarted.status()).toBe('RESTORED');
    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(previous)).toEqual(originalLive);
    expect(readFileSync(source)).toEqual(originalSource);
    expect(balance(live)).toBe(7);
    const changed = open(live);
    try { changed.exec('UPDATE wallet SET balance = 37'); }
    finally { changed.close(); }
    restarted.applyPending();
    expect(balance(live)).toBe(37);
  }));

  it('migrates a supported older save only inside staging', () => fixture(({ root, live, source, liveService, restore }) => {
    const earlier = open(source);
    try {
      earlier.exec('PRAGMA foreign_keys = OFF');
      earlier.exec('DROP TRIGGER ai_memory_search_insert; DROP TRIGGER ai_memory_search_edit; DROP TRIGGER ai_memory_search_delete; DROP TABLE ai_memory_fts; DROP TABLE ai_memory_search_keys;');
      earlier.exec('DROP TABLE IF EXISTS proactive_notices; DROP TABLE IF EXISTS proactive_observations; DROP TABLE IF EXISTS proactive_settings;');
      earlier.exec('DROP TABLE host_window_anchors; DROP TABLE host_preferences; DELETE FROM schema_migrations WHERE version > 10; PRAGMA user_version = 10');
    } finally { earlier.close(); }
    const originalSource = readFileSync(source);
    restore.prepare(source);
    liveService.close();
    const staged = open(planLocation(root).candidate, true);
    try { expect(staged.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION); }
    finally { staged.close(); }
    restore.applyPending();
    expect(restore.status()).toBe('RESTORED');
    expect(balance(live)).toBe(7);
    expect(readFileSync(source)).toEqual(originalSource);
  }));

  it('refuses foreign, tampered, invalid or in-use sources before staging a replacement', () => fixture(({ root, live, source, liveService, restore }) => {
    const bad = join(root, 'bad.sqlite3');
    writeFileSync(bad, Buffer.alloc(2048, 42));
    expect(() => restore.prepare(bad)).toThrow();
    expect(() => restore.prepare(live)).toThrow();
    const alias = join(root, 'alias.sqlite3');
    linkSync(live, alias);
    expect(() => restore.prepare(alias)).toThrow();
    writeFileSync(`${source}-wal`, 'simulated active backup');
    expect(() => restore.prepare(source)).toThrow(/journal/);
    rmSync(`${source}-wal`);
    const altered = open(source);
    try { altered.exec('CREATE TRIGGER extra_user_trigger AFTER UPDATE ON wallet BEGIN SELECT 1; END'); }
    finally { altered.close(); }
    expect(() => restore.prepare(source)).toThrow(/schema does not match/);
    const future = open(source);
    try { future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); }
    finally { future.close(); }
    expect(() => restore.prepare(source)).toThrow(/Unsupported backup schema/);
    expect(restore.status()).toBe('NONE');
    expect(liveService.getSnapshot().walletCoins).toBe(42);
    expect(readdirSync(join(root, '.pet-restore'))).toEqual([]);
  }));

  it('preserves the original when the staged data changes or original journal remains', () => fixture(({ root, live, source, liveService, restore }) => {
    restore.prepare(source);
    const { candidate } = planLocation(root);
    const altered = open(candidate);
    try { altered.exec('UPDATE wallet SET balance = 197'); }
    finally { altered.close(); }
    liveService.close();
    const original = readFileSync(live);
    restore.applyPending();
    expect(restore.status()).toBe('FAILED');
    expect(readFileSync(live)).toEqual(original);
    restore.prepare(source);
    writeFileSync(`${live}-wal`, 'simulated leftover journal');
    restore.applyPending();
    expect(restore.status()).toBe('FAILED');
    expect(readFileSync(live)).toEqual(original);
    expect(readFileSync(`${live}-wal`, 'utf8')).toBe('simulated leftover journal');
  }));

  it('recognizes an interruption after replacement without restoring the same save twice', () => fixture(({ root, live, source, liveService, restore }) => {
    restore.prepare(source);
    liveService.close();
    const { candidate, previous } = planLocation(root);
    const original = readFileSync(live);
    linkSync(live, previous);
    renameSync(candidate, live);
    expect(restore.status()).toBe('PENDING');
    restore.applyPending();
    expect(restore.status()).toBe('RESTORED');
    expect(readFileSync(previous)).toEqual(original);
    expect(balance(live)).toBe(7);
  }));

  it('restores through the normal internal authority route and reports the outcome from the new writer', () => fixture(({ root, live, source, liveService }) => {
    liveService.close();
    const outputs = [];
    const launch = () => startUtilityTransport({ args: [live], start: path => openPersistentService(path, open, { resourcesDirectory: root }),
      send: message => outputs.push(message), exit() {} });
    const first = launch();
    try {
      expect(outputs.find(result => result.kind === 'snapshot').snapshot.walletCoins).toBe(42);
      first.receive({ kind: 'host-authority-request', requestId: 'stage-restore', request: { kind: 'restore-backup', source } });
      expect(outputs.at(-1)).toEqual({ kind: 'host-authority-result', requestId: 'stage-restore',
        result: { kind: 'restore-backup', result: { ok: true } } });
    } finally { first.receive({ kind: 'shutdown' }); }
    expect(outputs.at(-1)).toEqual({ kind: 'stopped' });
    outputs.length = 0;
    const second = launch();
    try {
      expect(outputs.find(result => result.kind === 'snapshot').snapshot.walletCoins).toBe(7);
      second.receive({ kind: 'host-authority-request', requestId: 'inspect-restore', request: { kind: 'restore-status' } });
      expect(outputs.at(-1)).toEqual({ kind: 'host-authority-result', requestId: 'inspect-restore',
        result: { kind: 'restore-status', result: { ok: true, status: 'RESTORED' } } });
    } finally { second.receive({ kind: 'shutdown' }); }
    expect(outputs.at(-1)).toEqual({ kind: 'stopped' });
  }));

  it('recovers a corrupt unopened live save through the explicit startup path', () => fixture(({ root, live, source, liveService }) => {
    liveService.close();
    const broken = Buffer.alloc(2048, 42);
    writeFileSync(live, broken);
    const outputs = [];
    const launch = args => startUtilityTransport({ args,
      start: (path, recoverySource) => openPersistentService(path, open, { resourcesDirectory: root }, recoverySource),
      send: message => outputs.push(message), exit() {} });
    launch([live]);
    expect(outputs).toEqual([{ kind: 'fatal', code: 'STARTUP_FAILED' }]);
    outputs.length = 0;
    const recovered = launch([live, '--recover-from-backup', source]);
    try {
      expect(outputs.find(result => result.kind === 'snapshot').snapshot.walletCoins).toBe(7);
      expect(readFileSync(planLocation(root).previous)).toEqual(broken);
    } finally { recovered.receive({ kind: 'shutdown' }); }
  }));
});
