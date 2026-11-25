import { randomInt, randomUUID } from 'node:crypto';
import { AppService, SQLiteRepository } from '@pet-desktop/app-service';
import type { SqliteConnection } from '@pet-desktop/app-service';

function requireSupportedSQLite(connection: SqliteConnection): string {
  const row = connection.prepare('SELECT sqlite_version() AS version').get();
  const version = row !== null && typeof row === 'object' && 'version' in row ? row.version : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Invalid SQLite version');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined
    || ![major, minor, patch].every(Number.isSafeInteger)
    || major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    throw new Error('Unsupported SQLite version');
  }
  return version;
}

/** Probe the actual loaded engine before even opening a user's save. */
export function openPersistentService(databasePath: string, open: (filename: string) => SqliteConnection): {
  service: AppService; sqliteVersion: string;
} {
  const probe = open(':memory:');
  let sqliteVersion: string;
  try {
    sqliteVersion = requireSupportedSQLite(probe);
  } finally {
    probe.close();
  }

  // This is the only persistent connection. SQLiteRepository applies and
  // verifies the pragmas, migrates, and owns the connection after construction.
  const connection = open(databasePath);
  try {
    const repository = new SQLiteRepository(connection, { persistent: true });
    const service = new AppService(repository, {
      now: Date.now,
      createId: (kind) => `${kind}-${randomUUID()}`,
      seed: () => randomInt(1, 0x1_0000_0000),
    });
    return { service, sqliteVersion };
  } catch (error) {
    // Includes migration/recovery failures before AppService can take ownership.
    connection.close();
    throw error;
  }
}
