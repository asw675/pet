import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { advanceTrip, createTripCheckpoint, createTripSnapshot } from '@pet-desktop/domain';
import { MIGRATION_001, SQLiteRepository } from '../src/sqlite-repository.ts';

const START = 1_700_000_000_000;
const pet = (petId = 'pet-a') => ({
  petId, characterId: 'character-a', nickname: "猫咪' --", power: 100, presence: 'HOME', activity: 'IDLE',
  mood: 'CALM', healthStatus: 'NORMAL', visibility: 'VISIBLE', moodScore10: 750,
  healthPoints10: 1000, energy10: 600, bond10: 150, xp: 0, revision: 0,
});
const preferences = (primaryPetId = 'pet-a') => ({
  revision: 0, logicalTime: START, primaryPetId, doNotDisturb: true, pausedRender: true,
});
const route = {
  routeId: 'test-route', contentVersion: 1, returnDurationMs: 10,
  nodes: [
    { kind: 'GATHER', nodeId: 'node-gather', durationMs: 20, itemId: 'herb', minQuantity: 2, maxQuantity: 2, xp: 4 },
    { kind: 'EVENT', nodeId: 'node-event', durationMs: 30, eventDefId: 'story', cgId: 'postcard', chanceBps: 10_000 },
  ],
};

function tripRecord(tripId = 'trip-a', petId = 'pet-a', startAt = START) {
  const snapshot = createTripSnapshot({ tripId, petId, startAt, seed: 12, power: 100, route });
  return { snapshot, checkpoint: createTripCheckpoint(snapshot), status: 'TRAVELING', reportReadAt: null };
}

const event = (eventId = 'event-a', revision = 1) => ({
  eventId, type: 'PET_UPDATED', aggregateId: 'pet-a', revision, occurredAt: START,
  causationId: 'command-a', schemaVersion: 1, payload: { energy10: 600, selected: true },
});

const receipt = () => ({
  commandId: 'command-a',
  fingerprint: JSON.stringify({ commandId: 'command-a', issuedAt: START, payload: { enabled: true, flag: 'doNotDisturb' }, type: 'APP_SET_MODE' }),
  outcome: { ok: false, error: { code: 'BUSINESS_RULE', message: '测试', retryable: false } },
  createdAt: START,
});

function withMemory(action) {
  const db = new DatabaseSync(':memory:');
  const repo = new SQLiteRepository(db, { persistent: false });
  try { return action(repo, db); }
  finally { repo.close(); }
}

function withFile(action) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-desktop-sqlite-test-'));
  try { return action(join(dir, 'test.sqlite3')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function rewardLine(trip, kind, targetId, amount) {
  const { tripId: sourceId, petId } = trip.snapshot;
  return { rewardKey: JSON.stringify(['TRIP', sourceId, petId, kind, targetId]), sourceType: 'TRIP', sourceId, petId, kind, targetId, amount };
}

const OLD_MIGRATION_CHECKSUM = 'fnv1a32:9d3ced6f'; // Measured against the committed v1 repository.
const hash = 'a'.repeat(64);
function departurePin(trip, version = '1.0.0', assetHash = hash) {
  return { tripId: trip.snapshot.tripId, petId: trip.snapshot.petId, cgId: 'postcard', variant: 'default',
    characterId: 'character-a', eventDefId: 'story',
    assetRef: { state: 'PINNED', assetVersion: version, assetHash, characterId: 'character-a', eventDefId: 'story' } };
}
function unlocked(input, pin = null, favorite = false, viewedAt = null) {
  return { ...input, assetRef: pin?.assetRef ?? { state: 'LEGACY_UNVERSIONED' },
    historicalCharacterId: pin?.characterId ?? null, historicalEventDefId: pin?.eventDefId ?? null, favorite, viewedAt };
}

function completeTrip(tx, trip) {
  const result = advanceTrip(trip.snapshot, trip.checkpoint, trip.snapshot.expectedReturnAt);
  tx.appendTripFacts(trip.snapshot.tripId, result.facts);
  const settledAt = result.checkpoint.actualReturnedAt;
  tx.insertSettlement({ tripId: trip.snapshot.tripId, settledAt, rewards: result.rewardDraft });
  tx.insertReward(rewardLine(trip, 'CG', 'postcard:default', 1));
  const input = { petId: trip.snapshot.petId, cgId: 'postcard', variant: 'default', sourceTripId: trip.snapshot.tripId, unlockedAt: settledAt };
  const inserted = tx.unlockCg(input);
  tx.updateTrip({ ...trip, checkpoint: result.checkpoint, status: 'SETTLED' });
  return { input, inserted };
}

/** Build a real v1 archive using the original numbered SQL and its old checksum,
 * never by lowering user_version on a newer database. */
function createV1Archive(db) {
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATION_001);
    db.prepare('INSERT INTO schema_migrations VALUES(1, ?, ?)').run(OLD_MIGRATION_CHECKSUM, START);
    db.exec('PRAGMA user_version=1');
    for (const [petId, presence, activity] of [['pet-a', 'HOME', 'IDLE'], ['pet-b', 'AWAY', null]]) {
      db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run(petId, 'character-a', `legacy ${petId}`, 4);
      db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(petId, presence, activity,
        'CALM', 'NORMAL', 'VISIBLE', 750, 1000, 600, 150);
      db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run(petId, 100, 4);
    }
    db.prepare('INSERT INTO preferences VALUES(1, ?, ?, ?, ?, ?)').run(4, START + 123, 'pet-a', 1, 0);
    db.exec("UPDATE wallet SET balance=42; INSERT INTO inventory VALUES ('herb',2)");
    const old = tripRecord('trip-old', 'pet-a'), active = tripRecord('trip-legacy', 'pet-b', START + 100);
    const final = advanceTrip(old.snapshot, old.checkpoint, old.snapshot.expectedReturnAt);
    const insert = (trip, checkpoint, status) => {
      const s = trip.snapshot;
      db.prepare(`INSERT INTO trips (trip_id,pet_id,route_id,status,seed,snapshot_json,checkpoint_json,json_schema_version,
        start_at,expected_return_at,actual_returned_at,next_due_at,rules_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(s.tripId, s.petId, s.routeId, status, s.seed, JSON.stringify(s), JSON.stringify(checkpoint),
          s.startAt, s.expectedReturnAt, checkpoint.actualReturnedAt, checkpoint.nextDueAt, s.rulesVersion);
    };
    insert(old, final.checkpoint, 'SETTLED');
    insert(active, active.checkpoint, 'TRAVELING');
    const settledAt = final.checkpoint.actualReturnedAt;
    db.prepare('INSERT INTO settlements VALUES (?, ?, ?, 1)').run(old.snapshot.tripId, settledAt, JSON.stringify(final.rewardDraft));
    db.prepare('INSERT INTO trip_reports VALUES (?, ?)').run(old.snapshot.tripId, settledAt + 1);
    for (const fact of final.facts) {
      db.prepare('INSERT INTO trip_events VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(fact.tripId, fact.petId, fact.sequence, fact.eventId,
        fact.scheduledAt, fact.type, JSON.stringify(fact.payload));
    }
    const oldUnlock = { petId: 'pet-a', cgId: 'postcard', variant: 'default', sourceTripId: 'trip-old', unlockedAt: settledAt };
    db.prepare('INSERT INTO cg_unlocks VALUES (?, ?, ?, ?, ?)').run(...Object.values(oldUnlock));
    db.exec('COMMIT');
    return { old, active, oldUnlock, final };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

describe('SQLite repository — schema and engine', () => {
  it('marks a writer unavailable when transaction rollback itself fails', () => {
    const db = new DatabaseSync(':memory:');
    let failRollback = false;
    const driver = {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => {
        if (sql === 'ROLLBACK' && failRollback) throw new Error('simulated rollback failure');
        db.exec(sql);
      },
      close: () => db.close(),
    };
    const repo = new SQLiteRepository(driver, { persistent: false });
    try {
      failRollback = true;
      expect(() => repo.transaction(() => { throw new Error('simulated command failure'); }))
        .toThrow(expect.objectContaining({ name: 'RepositoryUnavailableError' }));
      expect(() => repo.transaction((tx) => tx.getWalletCoins()))
        .toThrow(expect.objectContaining({ name: 'RepositoryUnavailableError' }));
    } finally {
      if (failRollback) db.exec('ROLLBACK');
      repo.close();
    }
  });

  it('creates v1 and v2 in contiguous order with verified pragmas and no memory tables', () => withMemory((repo, db) => {
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('memory');
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA synchronous').get().synchronous).toBe(2);
    expect(db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
    const history = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    expect(history.map(row => row.version)).toEqual([1,2]);
    expect(history[0].checksum).toBe(OLD_MIGRATION_CHECKSUM);
    expect(history[1].checksum).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(db.prepare('SELECT name FROM sqlite_temp_schema').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)).toEqual([
      'cg_unlocks', 'commands', 'inventory', 'outbox', 'pet_progression', 'pet_states', 'pets', 'preferences',
      'reward_ledger', 'schema_migrations', 'settlements', 'trip_cg_asset_pins', 'trip_events', 'trip_reports', 'trips', 'wallet',
    ]);
    expect(repo.transaction(tx => [tx.getPreferences(), tx.listPets(), tx.listTrips(), tx.getWalletCoins()])).toEqual([null, [], [], 0]);
  }));

  it('refuses unknown future schema before enabling WAL or changing it', () => withFile(path => {
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA user_version=99');
      expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/future database schema 99/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(99);
      expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete');
      expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
    } finally { db.close(); }
  }));

  it('rejects SQLite below 3.51.3 and an unavailable FTS5 extension', () => {
    const db = new DatabaseSync(':memory:');
    const older = {
      prepare(sql) {
        if (sql === 'SELECT sqlite_version() AS version') return { get: () => ({ version: '3.51.2' }) };
        return db.prepare(sql);
      },
      exec: sql => db.exec(sql), close: () => db.close(),
    };
    try {
      expect(() => new SQLiteRepository(older, { persistent: false })).toThrow(/minimum 3\.51\.3/);
      const missingFts = {
        prepare: sql => db.prepare(sql), close: () => db.close(),
        exec(sql) { if (/CREATE VIRTUAL TABLE/.test(sql)) throw new Error('no such module: fts5'); db.exec(sql); },
      };
      expect(() => new SQLiteRepository(missingFts, { persistent: false })).toThrow(/fts5/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(0);
    } finally { db.close(); }
  });

  it('rolls back migration DDL on a failure and can retry', () => {
    const db = new DatabaseSync(':memory:');
    const failing = {
      prepare: sql => db.prepare(sql), close: () => db.close(),
      exec(sql) { db.exec(sql); if (sql.includes('CREATE TABLE schema_migrations')) throw new Error('injected migration failure'); },
    };
    try {
      expect(() => new SQLiteRepository(failing, { persistent: false })).toThrow(/injected migration failure/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(0);
      expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
      const repo = new SQLiteRepository(db, { persistent: false });
      expect(repo.transaction(tx => tx.getWalletCoins())).toBe(0);
    } finally { db.close(); }
  });

  it('refuses an unversioned nonempty database and a changed migration history', () => {
    const unknown = new DatabaseSync(':memory:');
    try {
      unknown.exec('CREATE TABLE unrelated (value TEXT)');
      expect(() => new SQLiteRepository(unknown, { persistent: false })).toThrow(/Unrecognized nonempty/);
      expect(unknown.prepare('SELECT name FROM sqlite_schema').all().map(row => row.name)).toEqual(['unrelated']);
    } finally { unknown.close(); }
    withFile(path => {
      const initial = new DatabaseSync(path);
      const repo = new SQLiteRepository(initial, { persistent: true });
      initial.exec("UPDATE schema_migrations SET checksum='incorrect'");
      repo.close();
      const db = new DatabaseSync(path);
      try { expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/checksum mismatch/); }
      finally { db.close(); }
    });
  });

  it('does not let a caller use a file in nonpersistent test mode or memory in WAL mode', () => {
    withFile(path => {
      const db = new DatabaseSync(path);
      try { expect(() => new SQLiteRepository(db, { persistent: false })).toThrow(/in-memory tests/); }
      finally { db.close(); }
    });
    const memory = new DatabaseSync(':memory:');
    try { expect(() => new SQLiteRepository(memory, { persistent: true })).toThrow(/requires WAL/); }
    finally { memory.close(); }
  });
});

describe('SQLite repository — real v1 archive migration', () => {
  it('verifies the old archive, runs a synchronous backup outside the transaction, preserves history and settles legacy in-flight only as unversioned', () => withFile(path => {
    const db = new DatabaseSync(path);
    const { old, active, oldUnlock, final } = createV1Archive(db);
    const backupPath = `${path}.before-v2`;
    let callbacks = 0;
    const repo = new SQLiteRepository(db, { persistent: true, beforeMigration(from, to) {
      callbacks++;
      expect([from,to]).toEqual([1,2]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(db.prepare('SELECT version, checksum FROM schema_migrations').all()).toEqual([{ version: 1, checksum: OLD_MIGRATION_CHECKSUM }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // VACUUM INTO would reject running under BEGIN IMMEDIATE. This proves
      // the migration hook really precedes any write transaction.
      db.prepare('VACUUM INTO ?').run(backupPath);
    } });
    try {
      expect(callbacks).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
      expect(db.prepare('SELECT trip_id, cg_pin_schema FROM trips ORDER BY trip_id').all()).toEqual([
        { trip_id: 'trip-legacy', cg_pin_schema: 1 }, { trip_id: 'trip-old', cg_pin_schema: 1 },
      ]);
      repo.transaction(tx => {
        expect(tx.getWalletCoins()).toBe(42);
        expect(tx.listInventory()).toEqual([{ itemId: 'herb', quantity: 2 }]);
        expect(tx.getPreferences()).toEqual({ revision: 4, logicalTime: START + 123, primaryPetId: 'pet-a', doNotDisturb: true, pausedRender: false });
        expect(tx.getPet('pet-a').nickname).toBe('legacy pet-a');
        expect(tx.getTrip('trip-old')).toEqual({ ...old, checkpoint: final.checkpoint, status: 'SETTLED', reportReadAt: final.checkpoint.actualReturnedAt + 1 });
        expect(tx.listTripFacts('trip-old')).toEqual(final.facts);
        expect(tx.getCgUnlock('pet-a', 'postcard', 'default')).toEqual(unlocked(oldUnlock));
        // Historical first-source retry remains idempotent; migration must not
        // fabricate missing v1 ledger metadata or rewrite the old unlock.
        expect(tx.unlockCg(oldUnlock)).toBe(false);
        expect(tx.getTrip('trip-legacy')).toEqual(active);
        expect(tx.listTripCgAssetPins('trip-legacy')).toEqual([]);
        expect(() => tx.insertTripCgAssetPin(departurePin(active))).toThrow(/matching new trip/);
        const legacy = completeTrip(tx, active);
        expect(legacy.inserted).toBe(true);
        expect(tx.getCgUnlock('pet-b', 'postcard', 'default')).toEqual(unlocked(legacy.input));
        expect(tx.setCgFavorite('pet-b', 'postcard', 'default', true)).toBe(true);
        expect(() => tx.markCgViewed('pet-b', 'postcard', 'default', 'character-a', 'story', '1.0.0', hash, START + 1000)).toThrow(/exact pinned/);
        expect(tx.getCgUnlock('pet-b', 'postcard', 'default')).toEqual(unlocked(legacy.input, null, true));
      });
      const backup = new DatabaseSync(backupPath);
      try {
        expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(1);
        expect(backup.prepare('SELECT * FROM cg_unlocks').all()).toEqual([{
          pet_id: oldUnlock.petId, cg_id: oldUnlock.cgId, variant: oldUnlock.variant,
          source_trip_id: oldUnlock.sourceTripId, unlocked_at: oldUnlock.unlockedAt,
        }]);
        expect(backup.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('trip_cg_asset_pins')).toBeUndefined();
      } finally { backup.close(); }
    } finally { repo.close(); }
    const reopened = new DatabaseSync(path);
    const v2 = new SQLiteRepository(reopened, { persistent: true, beforeMigration() { throw new Error('should not back up v2 again'); } });
    try {
      expect(v2.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([unlocked(oldUnlock)]);
      expect(reopened.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check)).toEqual(['ok']);
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { v2.close(); }
  }));

  it('refuses to mutate a persistent v1 archive without a successful synchronous backup callback', () => withFile(path => {
    const db = new DatabaseSync(path);
    createV1Archive(db);
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    const originalSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='cg_unlocks'").get().sql;
    try {
      expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/pre-migration backup callback/);
      expect(() => new SQLiteRepository(db, { persistent: true, beforeMigration() { throw new Error('disk full during backup'); } })).toThrow(/disk full/);
      expect(() => new SQLiteRepository(db, { persistent: true, beforeMigration: async () => {} })).toThrow(/must be synchronous/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(history);
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='cg_unlocks'").get().sql).toBe(originalSql);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('trip_cg_asset_pins')).toBeUndefined();
    } finally { db.close(); }
  }));

  it('rejects v1 checksum or foreign-key corruption before the backup callback', () => withFile(path => {
    const db = new DatabaseSync(path);
    createV1Archive(db);
    let calls = 0;
    const beforeMigration = () => { calls++; };
    try {
      db.exec("UPDATE schema_migrations SET checksum='tampered'");
      expect(() => new SQLiteRepository(db, { persistent: true, beforeMigration })).toThrow(/checksum mismatch/);
      db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run(OLD_MIGRATION_CHECKSUM);
      db.exec("PRAGMA foreign_keys=OFF; UPDATE preferences SET primary_pet_id='missing'");
      expect(() => new SQLiteRepository(db, { persistent: true, beforeMigration })).toThrow(/foreign-key violations/);
      expect(calls).toBe(0);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
    } finally { db.close(); }
  }));

  it('rolls back v2 DDL and legacy row copy together on a post-DDL failure, then retries safely', () => withFile(path => {
    const db = new DatabaseSync(path);
    const { oldUnlock } = createV1Archive(db);
    let backups = 0;
    const failing = {
      prepare: sql => db.prepare(sql), close: () => db.close(),
      exec(sql) { db.exec(sql); if (sql.includes('CREATE TABLE trip_cg_asset_pins')) throw new Error('injected v2 post-DDL failure'); },
    };
    const beforeMigration = () => { backups++; };
    try {
      expect(() => new SQLiteRepository(failing, { persistent: true, beforeMigration })).toThrow(/injected v2 post-DDL failure/);
      expect(backups).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(db.prepare('SELECT version, checksum FROM schema_migrations').all()).toEqual([{ version: 1, checksum: OLD_MIGRATION_CHECKSUM }]);
      expect(db.prepare('PRAGMA table_info(trips)').all().map(row => row.name)).not.toContain('cg_pin_schema');
      expect(db.prepare('PRAGMA table_info(cg_unlocks)').all().map(row => row.name)).toEqual(['pet_id','cg_id','variant','source_trip_id','unlocked_at']);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('trip_cg_asset_pins')).toBeUndefined();
      const repo = new SQLiteRepository(db, { persistent: true, beforeMigration });
      expect(backups).toBe(2);
      expect(repo.transaction(tx => tx.getCgUnlock('pet-a','postcard','default'))).toEqual(unlocked(oldUnlock));
    } finally { db.close(); }
  }));

  it('verifies both applied checksums and refuses missing or noncontiguous history on v2 startup', () => withFile(path => {
    const initial = new DatabaseSync(path);
    new SQLiteRepository(initial, { persistent: true }).close();
    const db = new DatabaseSync(path);
    try {
      const v2 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=2').get().checksum;
      for (const [version, checksum] of [[1, OLD_MIGRATION_CHECKSUM],[2,v2]]) {
        db.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=?").run(version);
        expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/checksum mismatch/);
        db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(checksum, version);
      }
      db.exec('UPDATE schema_migrations SET version=3 WHERE version=2');
      expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/not contiguous/);
      db.exec('DELETE FROM schema_migrations WHERE version=3');
      expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/history is invalid/);
    } finally { db.close(); }
  }));

  it('fresh v2 failure leaves an independently valid v1 migration, not a fake v2 record', () => {
    const db = new DatabaseSync(':memory:');
    const failing = {
      prepare: sql => db.prepare(sql), close: () => db.close(),
      exec(sql) { db.exec(sql); if (sql.includes('CREATE TABLE trip_cg_asset_pins')) throw new Error('failed second migration'); },
    };
    try {
      expect(() => new SQLiteRepository(failing, { persistent: false })).toThrow(/failed second migration/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(db.prepare('SELECT version, checksum FROM schema_migrations').all()).toEqual([{ version: 1, checksum: OLD_MIGRATION_CHECKSUM }]);
      const repo = new SQLiteRepository(db, { persistent: false });
      expect(repo.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([]);
    } finally { db.close(); }
  });
});

describe('SQLite repository — transaction and constraints', () => {
  it('roundtrips pets, preferences, wallet, inventory, receipts and ordered outbox', () => withMemory(repo => {
    repo.transaction(tx => {
      tx.savePet(pet('pet-b'));
      tx.savePet(pet());
      tx.savePet({ ...pet(), mood: 'HAPPY', xp: 9, revision: 1 });
      tx.savePreferences(preferences());
      tx.setWalletCoins(42);
      tx.addInventory('herb', 3);
      tx.addInventory('herb', 4);
      tx.addInventory('herb', -2);
      tx.addInventory('apple', 1);
      tx.saveCommandReceipt(receipt());
      tx.saveCommandReceipt(receipt());
      tx.appendOutbox(event());
      tx.appendOutbox(event());
      tx.appendOutbox(event('event-b', 2));
    });
    repo.transaction(tx => {
      expect(tx.getPet('pet-a')).toEqual({ ...pet(), mood: 'HAPPY', xp: 9, revision: 1 });
      expect(tx.getPet('absent')).toBeNull();
      expect(tx.listPets().map(p => p.petId)).toEqual(['pet-a', 'pet-b']);
      expect(tx.getPreferences()).toEqual(preferences());
      expect(tx.getWalletCoins()).toBe(42);
      expect(tx.listInventory()).toEqual([{ itemId: 'apple', quantity: 1 }, { itemId: 'herb', quantity: 5 }]);
      expect(tx.getCommandReceipt('command-a')).toEqual(receipt());
      expect(tx.getCommandReceipt('absent')).toBeNull();
      expect(tx.listOutbox(0, 100)).toEqual([{ seq: 1, event: event() }, { seq: 2, event: event('event-b', 2) }]);
      expect(tx.listOutbox(1, 1)).toEqual([{ seq: 2, event: event('event-b', 2) }]);
      expect(tx.listOutbox(0, 0)).toEqual([]);
    });
  }));

  it('rolls back all partial writes, rejects nested, async and escaped transactions', () => withMemory(repo => {
    let escaped;
    expect(() => repo.transaction(tx => {
      escaped = tx;
      tx.savePet(pet());
      tx.savePreferences(preferences());
      tx.insertTrip(tripRecord());
      tx.setWalletCoins(42);
      tx.addInventory('herb', 7);
      tx.saveCommandReceipt(receipt());
      tx.appendOutbox(event());
      throw new Error('failure before commit');
    })).toThrow(/failure before commit/);
    expect(() => escaped.listPets()).toThrow(/no longer active/);
    expect(() => escaped.savePet(pet())).toThrow(/no longer active/);
    expect(() => repo.transaction(tx => { tx.setWalletCoins(1); repo.transaction(() => {}); })).toThrow(/Nested/);
    expect(() => repo.transaction(async tx => { tx.setWalletCoins(2); await Promise.resolve(); tx.setWalletCoins(3); })).toThrow(/synchronous/);
    expect(() => repo.transaction(() => repo.close())).toThrow(/during transaction/);
    repo.transaction(tx => {
      expect(tx.listPets()).toEqual([]);
      expect(tx.getPreferences()).toBeNull();
      expect(tx.listTrips()).toEqual([]);
      expect(tx.getWalletCoins()).toBe(0);
      expect(tx.listInventory()).toEqual([]);
      expect(tx.getCommandReceipt('command-a')).toBeNull();
      expect(tx.listOutbox(0, 100)).toEqual([]);
      escaped = tx;
    });
    expect(() => escaped.getWalletCoins()).toThrow(/no longer active/);
  }));

  it('enforces SQL foreign keys and a single active trip per pet', () => withMemory((repo, db) => {
    expect(() => repo.transaction(tx => tx.savePreferences(preferences('not-found')))).toThrow(/foreign key/i);
    expect(() => repo.transaction(tx => tx.insertTrip(tripRecord('orphan', 'not-found')))).toThrow(/foreign key/i);
    repo.transaction(tx => {
      tx.savePet(pet());
      tx.savePet(pet('pet-b'));
      tx.insertTrip(tripRecord());
      tx.insertTrip(tripRecord('trip-b', 'pet-b'));
    });
    expect(() => repo.transaction(tx => tx.insertTrip(tripRecord('trip-c')))).toThrow(/unique constraint/i);
    expect(() => db.exec("UPDATE pet_states SET energy10=1001 WHERE pet_id='pet-a'")).toThrow(/check constraint/i);
    expect(() => db.exec("UPDATE pet_states SET presence='AWAY' WHERE pet_id='pet-a'")).toThrow(/check constraint/i);
    expect(() => db.exec("UPDATE trips SET seed=1 WHERE trip_id='trip-a'")).toThrow(/immutable/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(repo.transaction(tx => tx.listTrips().map(t => t.snapshot.tripId))).toEqual(['trip-a', 'trip-b']);
  }));

  it('checks safe integers and never allows negative or overflowing inventory', () => withMemory((repo, db) => {
    const max = Number.MAX_SAFE_INTEGER;
    repo.transaction(tx => { tx.setWalletCoins(max); tx.addInventory('herb', max); });
    expect(() => repo.transaction(tx => tx.setWalletCoins(max + 1))).toThrow(/safe integer/);
    expect(() => repo.transaction(tx => tx.addInventory('herb', 1))).toThrow(/overflow/);
    expect(() => repo.transaction(tx => tx.addInventory('herb', -max - 1))).toThrow(/safe integer/);
    expect(() => repo.transaction(tx => tx.addInventory('absent', -1))).toThrow(/Insufficient/);
    repo.transaction(tx => {
      expect(tx.getWalletCoins()).toBe(max);
      expect(tx.listInventory()).toEqual([{ itemId: 'herb', quantity: max }]);
      tx.addInventory('herb', -max);
    });
    expect(() => repo.transaction(tx => tx.addInventory('herb', -1))).toThrow(/Insufficient/);
    expect(() => db.exec("UPDATE wallet SET balance=-1 WHERE currency='coin'")).toThrow(/check constraint/i);
    expect(() => repo.transaction(tx => tx.savePet({ ...pet(), season: 1, xp: Number.NaN }))).toThrow(/safe integer/);
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare("UPDATE wallet SET balance=? WHERE currency='coin'").run(9007199254740992n);
    expect(() => repo.transaction(tx => tx.getWalletCoins())).toThrow();
  }));

  it('rejects contradictory receipts and outbox duplicates without overwriting committed data', () => withMemory(repo => {
    repo.transaction(tx => { tx.saveCommandReceipt(receipt()); tx.appendOutbox(event()); });
    expect(() => repo.transaction(tx => tx.saveCommandReceipt({ ...receipt(), createdAt: START + 1 }))).toThrow(/Conflicting command/);
    expect(() => repo.transaction(tx => tx.appendOutbox(event('event-a', 5)))).toThrow(/Conflicting outbox/);
    expect(repo.transaction(tx => tx.getCommandReceipt('command-a'))).toEqual(receipt());
    expect(repo.transaction(tx => tx.listOutbox(0, 1))).toEqual([{ seq: 1, event: event() }]);
  }));
});

describe('SQLite repository — frozen travel and restart durability', () => {
  it('validates checkpoints, persists exact-once settlement and resumes a WAL archive', () => withFile(path => {
    const initial = new DatabaseSync(path);
    let repo = new SQLiteRepository(initial, { persistent: true });
    const trip = tripRecord();
    const preview = advanceTrip(trip.snapshot, trip.checkpoint, START + 20);
    try {
      expect(initial.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
      repo.transaction(tx => {
        tx.savePet({ ...pet(), presence: 'AWAY', activity: null });
        tx.savePreferences(preferences());
        tx.insertTrip(trip);
        tx.insertTripCgAssetPin(departurePin(trip));
        tx.appendTripFacts(trip.snapshot.tripId, preview.facts);
        tx.appendTripFacts(trip.snapshot.tripId, preview.facts);
        tx.updateTrip({ ...trip, checkpoint: preview.checkpoint });
      });
      const altered = createTripSnapshot({ ...trip.snapshot, seed: 13, route });
      expect(() => repo.transaction(tx => tx.updateTrip({ ...trip, snapshot: altered, checkpoint: createTripCheckpoint(altered) }))).toThrow(/immutable/);
      expect(() => repo.transaction(tx => tx.appendTripFacts(trip.snapshot.tripId,
        [{ ...preview.facts[0], payload: { ...preview.facts[0].payload, quantity: 3 } }]))).toThrow(/Conflicting trip fact/);
    } finally { repo.close(); }

    const restarted = new DatabaseSync(path);
    repo = new SQLiteRepository(restarted, { persistent: true });
    const final = advanceTrip(trip.snapshot, preview.checkpoint, trip.snapshot.expectedReturnAt);
    const settlement = { tripId: trip.snapshot.tripId, settledAt: final.checkpoint.actualReturnedAt, rewards: final.rewardDraft };
    const lineXp = rewardLine(trip, 'XP', 'xp', 4);
    const lineItem = rewardLine(trip, 'ITEM', 'herb', 2);
    const lineCg = rewardLine(trip, 'CG', 'postcard:default', 1);
    const cg = { petId: 'pet-a', cgId: 'postcard', variant: 'default', sourceTripId: 'trip-a', unlockedAt: trip.snapshot.expectedReturnAt };
    try {
      expect(repo.transaction(tx => tx.getTrip('trip-a'))).toEqual({ ...trip, checkpoint: preview.checkpoint });
      expect(repo.transaction(tx => tx.listTripFacts('trip-a'))).toEqual(preview.facts);
      // A failure after appending rewards/facts but before checkpoint commit must lose the whole batch.
      expect(() => repo.transaction(tx => {
        tx.appendTripFacts('trip-a', final.facts);
        tx.insertSettlement(settlement);
        tx.insertReward(lineXp);
        tx.addInventory('herb', 2);
        throw new Error('injected settlement interruption');
      })).toThrow(/injected settlement interruption/);
      repo.transaction(tx => {
        expect(tx.getSettlement('trip-a')).toBeNull();
        expect(tx.listRewards('trip-a')).toEqual([]);
        expect(tx.listInventory()).toEqual([]);
        expect(tx.listTripFacts('trip-a')).toEqual(preview.facts);
        tx.appendTripFacts('trip-a', final.facts);
        expect(tx.insertSettlement(settlement)).toBe(true);
        expect(tx.insertSettlement(settlement)).toBe(false);
        expect(tx.insertReward(lineXp)).toBe(true);
        expect(tx.insertReward(lineXp)).toBe(false);
        expect(() => tx.insertReward({ ...lineXp, amount: 5 })).toThrow(/Conflicting reward/);
        expect(() => tx.insertReward({ ...lineXp, rewardKey: 'different-key' })).toThrow(/Conflicting reward/);
        expect(tx.insertReward(lineItem)).toBe(true);
        expect(tx.insertReward(lineCg)).toBe(true);
        tx.addInventory('herb', 2);
        expect(tx.unlockCg(cg)).toBe(true);
        expect(tx.unlockCg(cg)).toBe(false);
        tx.updateTrip({ ...trip, status: 'SETTLED', checkpoint: final.checkpoint });
        tx.savePet({ ...pet(), xp: 4 });
        tx.appendOutbox(event());
      });
      expect(() => repo.transaction(tx => tx.insertSettlement({ ...settlement, settledAt: START }))).toThrow(/Conflicting settlement/);
      expect(() => repo.transaction(tx => tx.insertReward(rewardLine(trip, 'COIN', 'coin', 1)))).toThrow(/active trip/);
      expect(() => repo.transaction(tx => tx.updateTrip({ ...trip, checkpoint: preview.checkpoint }))).toThrow(/immutable/);
      expect(restarted.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check)).toEqual(['ok']);
    } finally { repo.close(); }

    const reopened = new DatabaseSync(path);
    repo = new SQLiteRepository(reopened, { persistent: true });
    try {
      repo.transaction(tx => {
        expect(tx.getSettlement('trip-a')).toEqual(settlement);
        expect(tx.insertSettlement(settlement)).toBe(false);
        expect(tx.insertReward(lineXp)).toBe(false);
        expect(tx.listRewards('trip-a')).toEqual([lineCg, lineItem, lineXp]);
        expect(tx.listTripFacts('trip-a')).toEqual([...preview.facts, ...final.facts]);
        tx.appendTripFacts('trip-a', [...preview.facts, ...final.facts]);
        expect(tx.listInventory()).toEqual([{ itemId: 'herb', quantity: 2 }]);
        expect(tx.listCgUnlocks('pet-a')).toEqual([unlocked(cg, departurePin(trip))]);
        expect(tx.listTripCgAssetPins('trip-a')).toEqual([departurePin(trip)]);
        expect(tx.getPet('pet-a').xp).toBe(4);
        expect(tx.getTrip('trip-a')).toEqual({ ...trip, status: 'SETTLED', checkpoint: final.checkpoint });
        tx.updateTrip({ ...trip, status: 'SETTLED', checkpoint: final.checkpoint, reportReadAt: START + 100 });
        expect(tx.getTrip('trip-a').reportReadAt).toBe(START + 100);
        expect(tx.listOutbox(0, 10)).toEqual([{ seq: 1, event: event() }]);
        tx.insertTrip(tripRecord('trip-next', 'pet-a', START + 100));
      });
      expect(() => repo.transaction(tx => tx.updateTrip({ ...trip, status: 'SETTLED', checkpoint: final.checkpoint }))).toThrow(/cannot regress/);
    } finally { repo.close(); }
  }));

  it('rejects valid JSON with missing/unknown persisted structures or contradictory indexed fields', () => withMemory((repo, db) => {
    repo.transaction(tx => { tx.savePet(pet()); tx.insertTrip(tripRecord()); tx.saveCommandReceipt(receipt()); tx.appendOutbox(event()); });
    db.exec("UPDATE trips SET checkpoint_json=json_set(checkpoint_json, '$.unknown', 1) WHERE trip_id='trip-a'");
    expect(() => repo.transaction(tx => tx.getTrip('trip-a'))).toThrow(/unexpected or absent fields/);
    db.prepare("UPDATE trips SET checkpoint_json=? WHERE trip_id='trip-a'").run(JSON.stringify(tripRecord().checkpoint));
    db.exec("UPDATE trips SET next_due_at=next_due_at+1 WHERE trip_id='trip-a'");
    expect(() => repo.transaction(tx => tx.listTrips())).toThrow(/indexed columns/);
    db.exec("UPDATE commands SET outcome_json='{}' WHERE command_id='command-a'");
    expect(() => repo.transaction(tx => tx.getCommandReceipt('command-a'))).toThrow(/discriminator/);
    db.exec("UPDATE outbox SET payload_json='{\"nested\":{}}' WHERE event_id='event-a'");
    expect(() => repo.transaction(tx => tx.listOutbox(0, 10))).toThrow();
  }));
});

describe('SQLite repository — frozen CG acquisition, favorites and first view', () => {
  it('pins exact departure content and preserves first acquisition through later versions and character changes', () => withMemory((repo, db) => {
    const first = tripRecord(), pin = departurePin(first);
    const later = tripRecord('trip-later', 'pet-a', START + 1000), newer = departurePin(later, '2.0.0', 'b'.repeat(64));
    let firstInput;
    repo.transaction(tx => {
      tx.savePet(pet());
      tx.savePet(pet('pet-b'));
      tx.insertTrip(first);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toBeNull();
      expect(() => tx.setCgFavorite('pet-a','postcard','default',true)).toThrow(/not been unlocked/);
      expect(() => tx.insertTripCgAssetPin({ ...pin, petId: 'pet-b' })).toThrow(/matching new trip/);
      expect(() => tx.insertTripCgAssetPin({ ...pin, cgId: 'unrelated' })).toThrow(/matching new trip/);
      expect(() => tx.insertTripCgAssetPin({ ...pin, eventDefId: 'wrong', assetRef: { ...pin.assetRef, eventDefId: 'wrong' } })).toThrow(/matching new trip/);
      expect(() => tx.insertTripCgAssetPin({ ...pin, assetRef: { ...pin.assetRef, characterId: 'wrong' } })).toThrow(/contradicts/);
      expect(() => tx.insertTripCgAssetPin({ ...pin, assetRef: { state: 'LEGACY_UNVERSIONED' } })).toThrow(/cannot be legacy/);
      tx.insertTripCgAssetPin(pin);
      tx.insertTripCgAssetPin(pin); // Exact retry is a no-op.
      expect(() => tx.insertTripCgAssetPin({ ...pin, assetRef: { ...pin.assetRef, assetVersion: '1.1.0' } })).toThrow(/Conflicting departure CG pin/);
      expect(tx.listTripCgAssetPins('trip-a')).toEqual([pin]);
      tx.savePet({ ...pet(), characterId: 'new-character' });
      const done = completeTrip(tx, first);
      firstInput = done.input;
      expect(done.inserted).toBe(true);
      expect(tx.unlockCg(firstInput)).toBe(false); // Same source is idempotent even after settlement.
      expect(() => tx.unlockCg({ ...firstInput, unlockedAt: firstInput.unlockedAt + 1 })).toThrow(/Conflicting CG unlock/);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(firstInput, pin));
      tx.savePet(pet());
      tx.insertTrip(later);
      tx.insertTripCgAssetPin(newer);
      expect(completeTrip(tx, later).inserted).toBe(false);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(firstInput, pin));
      expect(tx.listTripCgAssetPins('trip-later')).toEqual([newer]);
      expect(tx.listCgUnlocks('pet-b')).toEqual([]);
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(repo.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([unlocked(firstInput, pin)]);
  }));

  it('rejects missing, late or unrelated pins on new trips instead of falsely labeling them legacy', () => withMemory((repo, db) => {
    const trip = tripRecord(), pin = departurePin(trip);
    repo.transaction(tx => { tx.savePet(pet()); tx.insertTrip(trip); });
    expect(() => repo.transaction(tx => completeTrip(tx, trip))).toThrow(/requires its frozen departure pin/);
    // The logical clock can advance before the first scheduled fact. Even with
    // OUTBOUND and sequence=0 it is too late to declare departure metadata.
    const beforeFirstFact = advanceTrip(trip.snapshot,trip.checkpoint,START+1);
    expect(beforeFirstFact.facts).toEqual([]);
    repo.transaction(tx => tx.updateTrip({...trip,checkpoint:beforeFirstFact.checkpoint}));
    expect(() => repo.transaction(tx => tx.insertTripCgAssetPin(pin))).toThrow(/matching new trip/);
    expect(() => db.prepare('INSERT INTO trip_cg_asset_pins VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('trip-a','pet-a','postcard','default','character-a','story','PINNED','1.0.0',hash)).toThrow(/invalid or duplicate departure CG pin/);
    const partial = advanceTrip(trip.snapshot, trip.checkpoint, START + 20);
    repo.transaction(tx => {
      tx.appendTripFacts(trip.snapshot.tripId, partial.facts);
      expect(() => tx.insertTripCgAssetPin(pin)).toThrow(/matching new trip/);
      tx.updateTrip({ ...trip, checkpoint: partial.checkpoint });
    });
    expect(() => repo.transaction(tx => tx.insertTripCgAssetPin(pin))).toThrow(/matching new trip/);
    expect(repo.transaction(tx => tx.getSettlement('trip-a'))).toBeNull();
    expect(repo.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([]);
  }));

  it('requires an exact CG ledger line for first and later acquisitions, rolling all failed writes back', () => withMemory(repo => {
    const first = tripRecord();
    repo.transaction(tx => { tx.savePet(pet()); tx.insertTrip(first); tx.insertTripCgAssetPin(departurePin(first)); });
    const tryWithoutExactReward = (trip, invalid) => {
      const completed = advanceTrip(trip.snapshot,trip.checkpoint,trip.snapshot.expectedReturnAt);
      const t = completed.checkpoint.actualReturnedAt;
      const tripId = trip.snapshot.tripId;
      const input = { petId: trip.snapshot.petId, cgId: 'postcard', variant: 'default', sourceTripId: tripId, unlockedAt: t };
      expect(() => repo.transaction(tx => {
        tx.appendTripFacts(tripId, completed.facts);
        tx.insertSettlement({ tripId, settledAt: t, rewards: completed.rewardDraft });
        if (invalid !== null) tx.insertReward(invalid);
        tx.unlockCg(input);
      })).toThrow(/exact reward ledger line/);
      expect(repo.transaction(tx => ({ facts: tx.listTripFacts(tripId), settlement: tx.getSettlement(tripId), rewards: tx.listRewards(tripId) })))
        .toEqual({ facts: [], settlement: null, rewards: [] });
    };
    tryWithoutExactReward(first, null);
    tryWithoutExactReward(first, rewardLine(first,'CG','postcard:other-variant',1));
    tryWithoutExactReward(first, rewardLine(first,'CG','postcard:default',2));
    tryWithoutExactReward(first, rewardLine(first,'ITEM','postcard:default',1));
    expect(repo.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([]);
    const acquisition = repo.transaction(tx => completeTrip(tx, first));
    const later = tripRecord('trip-next','pet-a',START+1000);
    repo.transaction(tx => { tx.insertTrip(later); tx.insertTripCgAssetPin(departurePin(later,'2.0.0','b'.repeat(64))); });
    tryWithoutExactReward(later, null);
    tryWithoutExactReward(later, rewardLine(later,'CG','postcard:other-variant',1));
    expect(repo.transaction(tx => completeTrip(tx,later).inserted)).toBe(false);
    expect(repo.transaction(tx => tx.getCgUnlock('pet-a','postcard','default'))).toEqual(unlocked(acquisition.input,departurePin(first)));
  }));

  it('persists unavailable-at-departure without inventing a version or allowing a false first view', () => withMemory(repo => {
    const trip = tripRecord();
    const pin = { ...departurePin(trip), assetRef: { state: 'UNAVAILABLE_AT_DEPARTURE' } };
    repo.transaction(tx => {
      tx.savePet(pet());
      tx.insertTrip(trip);
      tx.insertTripCgAssetPin(pin);
      expect(tx.listTripCgAssetPins('trip-a')).toEqual([pin]);
      const done = completeTrip(tx, trip);
      expect(done.inserted).toBe(true);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(done.input,pin));
      expect(tx.setCgFavorite('pet-a','postcard','default',true)).toBe(true);
      expect(tx.setCgFavorite('pet-a','postcard','default',true)).toBe(false);
      expect(() => tx.markCgViewed('pet-a','postcard','default','character-a','story','1.0.0',hash,done.input.unlockedAt)).toThrow(/exact pinned/);
      expect(tx.listCgUnlocks('pet-a')).toEqual([unlocked(done.input,pin,true)]);
    });
  }));

  it('marks only an exact pinned CG first view and changes favorites without game effects', () => withMemory(repo => {
    const trip = tripRecord(), pin = departurePin(trip);
    repo.transaction(tx => {
      tx.savePet(pet());
      tx.insertTrip(trip);
      tx.insertTripCgAssetPin(pin);
      const done = completeTrip(tx,trip), t = done.input.unlockedAt;
      const before = { coins: tx.getWalletCoins(), inventory: tx.listInventory(), xp: tx.getPet('pet-a').xp, rewards: tx.listRewards('trip-a'), outbox: tx.listOutbox(0,10) };
      expect(tx.setCgFavorite('pet-a','postcard','default',false)).toBe(false);
      expect(tx.setCgFavorite('pet-a','postcard','default',true)).toBe(true);
      expect(tx.setCgFavorite('pet-a','postcard','default',true)).toBe(false);
      expect(() => tx.markCgViewed('pet-a','missing','default','character-a','story','1.0.0',hash,t)).toThrow(/not been unlocked/);
      for (const [c,e,v,h] of [['wrong','story','1.0.0',hash],['character-a','wrong','1.0.0',hash],
        ['character-a','story','2.0.0',hash],['character-a','story','1.0.0','b'.repeat(64)]]) {
        expect(() => tx.markCgViewed('pet-a','postcard','default',c,e,v,h,t)).toThrow(/exact pinned/);
      }
      expect(() => tx.markCgViewed('pet-a','postcard','default','character-a','story','1.0.0',hash,t-1)).toThrow(/cannot precede unlock/);
      expect(tx.markCgViewed('pet-a','postcard','default','character-a','story','1.0.0',hash,t+1)).toBe(true);
      expect(tx.markCgViewed('pet-a','postcard','default','character-a','story','1.0.0',hash,t+100)).toBe(false);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(done.input,pin,true,t+1));
      expect(tx.setCgFavorite('pet-a','postcard','default',false)).toBe(true);
      expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(done.input,pin,false,t+1));
      expect({ coins: tx.getWalletCoins(), inventory: tx.listInventory(), xp: tx.getPet('pet-a').xp, rewards: tx.listRewards('trip-a'), outbox: tx.listOutbox(0,10) }).toEqual(before);
    });
  }));

  it('enforces immutable pin and acquisition constraints in SQLite itself, including REPLACE and first view', () => withMemory((repo, db) => {
    const trip = tripRecord(), pin = departurePin(trip);
    repo.transaction(tx => { tx.savePet(pet()); tx.insertTrip(trip); tx.insertTripCgAssetPin(pin); });
    expect(() => db.exec("UPDATE trips SET cg_pin_schema=1 WHERE trip_id='trip-a'")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE trip_cg_asset_pins SET asset_version='2.0.0'")).toThrow(/immutable/);
    expect(() => db.exec('DELETE FROM trip_cg_asset_pins')).toThrow(/immutable/);
    expect(() => db.exec('INSERT OR REPLACE INTO trip_cg_asset_pins SELECT * FROM trip_cg_asset_pins')).toThrow(/duplicate departure CG pin/);
    const insert = db.prepare('INSERT INTO trip_cg_asset_pins VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const version of ['01.0.0','1.0.0-alpha','1.0','65536.0.0']) {
      expect(() => insert.run('trip-a','pet-a','postcard','test','character-a','story','PINNED',version,hash)).toThrow(/check constraint/i);
    }
    expect(() => insert.run('trip-a','pet-a','postcard','test','character-a','story','PINNED','1.0.0','wrong')).toThrow(/check constraint/i);
    expect(() => insert.run('trip-a','pet-a','postcard','test','character-a','story','UNAVAILABLE_AT_DEPARTURE','1.0.0',hash)).toThrow(/check constraint/i);
    expect(() => insert.run('trip-a','pet-b','postcard','test','character-a','story','PINNED','1.0.0',hash)).toThrow(/invalid/);
    const complete = advanceTrip(trip.snapshot,trip.checkpoint,trip.snapshot.expectedReturnAt);
    const t = complete.checkpoint.actualReturnedAt;
    const rawUnlock = db.prepare(`INSERT INTO cg_unlocks (pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state,historical_character_id,historical_event_def_id,asset_version,asset_hash)
      VALUES ('pet-a','postcard','default','trip-a',?,'PINNED','character-a','story','1.0.0',?)`);
    repo.transaction(tx => {
      tx.appendTripFacts('trip-a',complete.facts);
      tx.insertSettlement({tripId:'trip-a',settledAt:t,rewards:complete.rewardDraft});
      expect(() => rawUnlock.run(t,hash)).toThrow(/invalid CG unlock source or departure pin/);
      tx.insertReward(rewardLine(trip,'CG','postcard:default',1));
      expect(() => rawUnlock.run(t,'b'.repeat(64))).toThrow(/invalid CG unlock source or departure pin/);
      expect(() => db.prepare(`INSERT INTO cg_unlocks(pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state)
        VALUES ('pet-a','postcard','default','trip-a',?,'LEGACY_UNVERSIONED')`).run(t)).toThrow(/invalid CG unlock/);
      tx.unlockCg({petId:'pet-a',cgId:'postcard',variant:'default',sourceTripId:'trip-a',unlockedAt:t});
      tx.updateTrip({...trip,status:'SETTLED',checkpoint:complete.checkpoint});
    });
    expect(() => db.exec("UPDATE cg_unlocks SET asset_version='2.0.0'")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE cg_unlocks SET historical_character_id='other'")).toThrow(/immutable/);
    expect(() => db.exec('UPDATE cg_unlocks SET unlocked_at=unlocked_at+1')).toThrow(/immutable/);
    expect(() => db.exec('UPDATE cg_unlocks SET favorite=2')).toThrow(/check constraint/i);
    expect(() => db.exec('UPDATE cg_unlocks SET viewed_at=unlocked_at-1')).toThrow(/check constraint/i);
    expect(() => db.exec('DELETE FROM cg_unlocks')).toThrow(/immutable/);
    expect(() => db.exec('INSERT OR REPLACE INTO cg_unlocks SELECT * FROM cg_unlocks')).toThrow(/invalid CG unlock/);
    repo.transaction(tx => { expect(tx.markCgViewed('pet-a','postcard','default','character-a','story','1.0.0',hash,t+1)).toBe(true); });
    expect(() => db.exec('UPDATE cg_unlocks SET viewed_at=NULL')).toThrow(/immutable/);
    expect(() => db.exec('UPDATE cg_unlocks SET viewed_at=viewed_at+1')).toThrow(/immutable/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').all().map(row=>row.integrity_check)).toEqual(['ok']);
  }));
});
