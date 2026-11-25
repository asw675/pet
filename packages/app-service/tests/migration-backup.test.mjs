import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { verifyMigrationBackup } from '../src/migration-backup.ts';

function withDatabase(action) {
  const directory = mkdtempSync(join(tmpdir(), 'pet-migration-backup-'));
  const source = new DatabaseSync(join(directory, 'game.sqlite3'));
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT); PRAGMA user_version=1;');
    source.prepare('INSERT INTO demo VALUES (?, ?)').run(1, '历史记录');
    return action(source, join(directory, 'game.pre-v1.sqlite3'));
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const openReadOnly = (filename) => new DatabaseSync(filename, { readOnly: true });

describe('trusted SQLite upgrade backup', () => {
  it('keeps committed WAL data in an independently verified v1 copy', () => withDatabase((source, destination) => {
    verifyMigrationBackup(source, destination, 1, openReadOnly);
    const backup = openReadOnly(destination);
    try {
      expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(backup.prepare('SELECT value FROM demo WHERE id=1').get().value).toBe('历史记录');
      source.prepare('UPDATE demo SET value=? WHERE id=1').run('新版本');
      expect(backup.prepare('SELECT value FROM demo WHERE id=1').get().value).toBe('历史记录');
    } finally { backup.close(); }
  }));

  it('refuses a source schema mismatch before creating a copy', () => withDatabase((source, destination) => {
    let attempted = false;
    expect(() => verifyMigrationBackup(source, destination, 2, () => { attempted = true; throw new Error('unexpected'); })).toThrow(/source schema mismatch/);
    expect(attempted).toBe(false);
    expect(source.prepare('PRAGMA user_version').get().user_version).toBe(1);
  }));

  it('does not overwrite an existing backup or mutate source data', () => withDatabase((source, destination) => {
    verifyMigrationBackup(source, destination, 1, openReadOnly);
    expect(() => verifyMigrationBackup(source, destination, 1, openReadOnly)).toThrow();
    expect(source.prepare('SELECT value FROM demo').get().value).toBe('历史记录');
  }));

  it('fails closed and closes the verifier on bad integrity or version', () => withDatabase((source, destination) => {
    let closed = false;
    expect(() => verifyMigrationBackup(source, destination, 1, () => ({
      prepare: () => ({ all: () => [{ integrity_check: 'not ok' }], get: () => ({ user_version: 1 }) }),
      close: () => { closed = true; },
    }))).toThrow(/verification failed/);
    expect(closed).toBe(true);
    expect(source.prepare('SELECT value FROM demo').get().value).toBe('历史记录');
  }));
});
