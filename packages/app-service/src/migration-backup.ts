import type { SqliteConnection } from './ports.js';

function readUserVersion(connection: SqliteConnection): number | null {
  const row = connection.prepare('PRAGMA user_version').get();
  if (row === null || typeof row !== 'object' || !('user_version' in row)) return null;
  const version = row.user_version;
  if (typeof version === 'bigint' && version >= 0n && version <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(version);
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null;
}

/** Called by the exclusive trusted service before advancing an existing
 * persistent schema; the destination is a unique sibling path constructed by
 * the host, never a renderer-provided path. SQLite's VACUUM INTO captures a
 * consistent database including committed WAL state, rather than copying a
 * live database file without its WAL. The caller must not be in a transaction.
 * A failed copy or check aborts startup; we never delete/overwrite the original.
 */
export function verifyMigrationBackup(
  source: SqliteConnection,
  destination: string,
  expectedVersion: number,
  openReadOnly: (filename: string) => SqliteConnection,
): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || readUserVersion(source) !== expectedVersion) {
    throw new Error('Migration backup source schema mismatch');
  }
  source.prepare('VACUUM INTO ?').run(destination);
  const backup = openReadOnly(destination);
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all();
    const row = integrity.length === 1 ? integrity[0] : undefined;
    const valid = row !== null && typeof row === 'object' && 'integrity_check' in row && row.integrity_check === 'ok';
    if (!valid || readUserVersion(backup) !== expectedVersion || backup.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Migration backup verification failed');
    }
  } finally {
    backup.close();
  }
}
