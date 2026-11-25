import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { advanceTrip, createTripCheckpoint, createTripSnapshot } from '@pet-desktop/domain';
import { SQLiteRepository } from '../src/sqlite-repository.ts';

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

  it('creates v1 transactionally with verified connection pragmas and no memory tables', () => withMemory((repo, db) => {
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('memory');
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA synchronous').get().synchronous).toBe(2);
    expect(db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toHaveLength(1);
    expect(db.prepare('SELECT name FROM sqlite_temp_schema').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)).toEqual([
      'cg_unlocks', 'commands', 'inventory', 'outbox', 'pet_progression', 'pet_states', 'pets', 'preferences',
      'reward_ledger', 'schema_migrations', 'settlements', 'trip_events', 'trip_reports', 'trips', 'wallet',
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
        expect(tx.listCgUnlocks('pet-a')).toEqual([cg]);
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
