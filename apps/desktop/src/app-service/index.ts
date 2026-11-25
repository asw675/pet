import type BetterSqlite3 from 'better-sqlite3';
import type {} from 'electron';
import type { SqliteConnection, SqlValue } from '@pet-desktop/app-service';
import { openPersistentService } from './database';
import { startUtilityTransport } from './transport';

function adaptConnection(database: BetterSqlite3.Database): SqliteConnection {
  // better-sqlite3 binds blobs as Buffer. The repository port accepts any
  // Uint8Array and positional scalar parameters, never arbitrary named objects.
  const bind = (value: SqlValue): SqlValue => value instanceof Uint8Array ? Buffer.from(value) : value;
  return {
    exec: (sql) => { database.exec(sql); },
    prepare: (sql) => {
      const statement = database.prepare<SqlValue[]>(sql);
      return {
        run: (...params) => statement.run(...params.map(bind)),
        get: (...params) => statement.get(...params.map(bind)),
        all: (...params) => statement.all(...params.map(bind)),
      };
    },
    close: () => { database.close(); },
  };
}

// Electron utilityProcess (not worker_threads): the documented ParentPort
// receives MessageEvent objects with data and transferred MessagePortMain[].
const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') process.exit(1);

const transport = startUtilityTransport({
  args: process.argv.slice(2),
  start: (databasePath) => {
    // Loaded inside the startup failure boundary, in the built CJS utility
    // entry only. A missing/incompatible addon is terminal, never a fallback.
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    return openPersistentService(databasePath, (filename) => adaptConnection(new Database(filename)));
  },
  send: (message) => parentPort.postMessage(message),
  exit: (code) => {
    // process.exit() is synchronous in Electron. Let the terminal notification
    // travel first; the parent must still observe the actual child exit before
    // creating a replacement writer. The database is already closed here.
    setTimeout(() => process.exit(code), 100);
  },
});

parentPort.on('message', (event) => transport.receive(event.ports.length === 0 ? event.data : null));
process.on('uncaughtException', () => transport.abort());
process.on('unhandledRejection', () => transport.abort());
