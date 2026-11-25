import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE } from '@pet-desktop/domain';
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, SQLiteRepository } from '../src/sqlite-repository.ts';

const START = 1_700_000_000_000;
const pet = (petId = 'pet-a') => ({
  petId, characterId: 'character-a', nickname: "猫咪' --", power: 100, presence: 'HOME', activity: 'IDLE',
  mood: 'CALM', healthStatus: 'NORMAL', visibility: 'VISIBLE', moodScore10: 750,
  healthPoints10: 1000, energy10: 600, bond10: 150, xp: 0, revision: 0,
});
const preferences = (primaryPetId = 'pet-a') => ({
  revision: 0, logicalTime: START, primaryPetId, doNotDisturb: true, pausedRender: true,
});
const DAY_MS=86_400_000;
const schedule=(petId='pet-a',lastSimAt=START)=>({petId,lastSimAt,activityDueAt:null,
  energyRemainder:0,healthRemainder:0,moodRemainder:0,interactionDay:Math.floor(lastSimAt/DAY_MS),interactionCount:0,lastInteractionAt:null});
const route = {
  routeId: 'test-route', contentVersion: 1, returnDurationMs: 10,
  nodes: [
    { kind: 'GATHER', nodeId: 'node-gather', durationMs: 20, itemId: 'herb', minQuantity: 2, maxQuantity: 2, xp: 4 },
    { kind: 'EVENT', nodeId: 'node-event', durationMs: 30, eventDefId: 'story', cgId: 'postcard', chanceBps: 10_000 },
  ],
};

function tripRecord(tripId = 'trip-a', petId = 'pet-a', startAt = START, definition = route) {
  const snapshot = createTripSnapshot({ tripId, petId, startAt, seed: 12, power: 100, route: definition });
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

const starterAcquisition = (petId = 'pet-a') => ({ petId, acquiredAt: START,
  origin: 'STARTER', catalogVersion: 1, coinCost: 0, commandId: null });
const gameAcquisition = (petId = 'pet-game', commandId = 'acquire-game') => ({ petId, acquiredAt: START+10,
  origin: 'GAME', catalogVersion: 1, coinCost: 16, commandId });
function successfulAcquireReceipt(acquisition, characterId = 'nova', catalogVersion = acquisition.catalogVersion,
  resultPetId = acquisition.petId, resultCharacterId = characterId) {
  return {
    commandId: acquisition.commandId,
    fingerprint: JSON.stringify({ commandId:acquisition.commandId,issuedAt:acquisition.acquiredAt,
      payload:{catalogVersion,characterId},type:'PET_ACQUIRE' }),
    outcome:{ok:true,snapshot:{revision:1,primaryPetId:resultPetId,pets:[{
      petId:resultPetId,characterId:resultCharacterId,nickname:'诺瓦',presence:'HOME',activity:'IDLE',mood:'CALM',
      healthStatus:'NORMAL',visibility:'HIDDEN',moodScore:50,healthPoints:100,energy:100,bond:0,level:1,xp:0,revision:0,
    }],walletCoins:0,doNotDisturb:false,pausedRender:false}},
    createdAt:acquisition.acquiredAt,
  };
}

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
const OLD_MIGRATION_002_CHECKSUM = 'fnv1a32:a0036d79'; // Measured against committed 7fca3d0.
const OLD_MIGRATION_003_CHECKSUM = 'fnv1a32:519a9ef3'; // Measured against committed 145901c.
const OLD_MIGRATION_004_CHECKSUM = 'fnv1a32:0f3c0f0e'; // Measured against committed 23b875d.
const OLD_MIGRATION_005_CHECKSUM = 'fnv1a32:16a20fb2'; // Measured against committed 750d6fc.
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

/** Genuine v2 archive: apply the original v1 and v2 SQL in order, preserve
 * their historical checksums, then append a real v2 pinned CG and receipt. */
function createV2Archive(db) {
  const legacy = createV1Archive(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATION_002);
    db.prepare('INSERT INTO schema_migrations VALUES(2, ?, ?)').run(OLD_MIGRATION_002_CHECKSUM, START+1);
    db.exec('PRAGMA user_version=2');
    db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run('pet-c','character-a','pinned pet',2);
    db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('pet-c','HOME','IDLE','HAPPY','NORMAL','HIDDEN',800,1000,700,200);
    db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run('pet-c',100,4);
    const trip = tripRecord('trip-v2','pet-c',START+200), s = trip.snapshot, c = trip.checkpoint;
    db.prepare(`INSERT INTO trips(trip_id,pet_id,route_id,status,seed,snapshot_json,checkpoint_json,json_schema_version,
      start_at,expected_return_at,actual_returned_at,next_due_at,rules_version,cg_pin_schema)
      VALUES (?, ?, ?, 'TRAVELING', ?, ?, ?, 1, ?, ?, ?, ?, ?, 2)`)
      .run(s.tripId,s.petId,s.routeId,s.seed,JSON.stringify(s),JSON.stringify(c),s.startAt,s.expectedReturnAt,c.actualReturnedAt,c.nextDueAt,s.rulesVersion);
    const pin = departurePin(trip);
    db.prepare('INSERT INTO trip_cg_asset_pins VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(pin.tripId,pin.petId,pin.cgId,pin.variant,
      pin.characterId,pin.eventDefId,pin.assetRef.state,pin.assetRef.assetVersion,pin.assetRef.assetHash);
    const completed = advanceTrip(s,c,s.expectedReturnAt), settledAt = completed.checkpoint.actualReturnedAt;
    for (const fact of completed.facts) {
      db.prepare('INSERT INTO trip_events VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(fact.tripId,fact.petId,fact.sequence,fact.eventId,
        fact.scheduledAt,fact.type,JSON.stringify(fact.payload));
    }
    db.prepare('INSERT INTO settlements VALUES (?, ?, ?, 1)').run(s.tripId,settledAt,JSON.stringify(completed.rewardDraft));
    const line = rewardLine(trip,'CG','postcard:default',1);
    db.prepare('INSERT INTO reward_ledger VALUES (?, ?, ?, ?, ?, ?, ?)').run(line.rewardKey,line.sourceType,line.sourceId,line.petId,line.kind,line.targetId,line.amount);
    const input = { petId:s.petId,cgId:pin.cgId,variant:pin.variant,sourceTripId:s.tripId,unlockedAt:settledAt };
    db.prepare(`INSERT INTO cg_unlocks(pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state,historical_character_id,historical_event_def_id,asset_version,asset_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.petId,input.cgId,input.variant,input.sourceTripId,input.unlockedAt,pin.assetRef.state,
      pin.characterId,pin.eventDefId,pin.assetRef.assetVersion,pin.assetRef.assetHash);
    db.prepare('INSERT INTO trip_reports VALUES (?,?)').run(s.tripId,settledAt+1);
    db.prepare("UPDATE trips SET status='SETTLED',checkpoint_json=?,actual_returned_at=?,next_due_at=NULL WHERE trip_id=?")
      .run(JSON.stringify(completed.checkpoint),settledAt,s.tripId);
    const viewAt = settledAt+2;
    db.prepare('UPDATE cg_unlocks SET favorite=1,viewed_at=? WHERE pet_id=? AND cg_id=? AND variant=?').run(viewAt,input.petId,input.cgId,input.variant);
    const command = receipt();
    db.prepare('INSERT INTO commands VALUES (?, ?, ?, 1, ?)').run(command.commandId,command.fingerprint,JSON.stringify(command.outcome),command.createdAt);
    db.exec('COMMIT');
    return { ...legacy, trip: { ...trip, checkpoint:completed.checkpoint,status:'SETTLED',reportReadAt:settledAt+1 }, pin, cg:unlocked(input,pin,true,viewAt), command, line };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Real v3 archive, built from immutable prior migrations; contains both
 * acquired and legacy pets, plus preserved v2 CG/trip/receipt history. */
function createV3Archive(db) {
  const prior=createV2Archive(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATION_003);
    db.prepare('INSERT INTO schema_migrations VALUES(3, ?, ?)').run(OLD_MIGRATION_003_CHECKSUM,START+2);
    db.exec('PRAGMA user_version=3');
    const acquired={...gameAcquisition(),acquiredAt:START+500};
    const command=successfulAcquireReceipt(acquired);
    db.prepare('UPDATE preferences SET logical_time=?').run(acquired.acquiredAt);
    db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run(acquired.petId,'nova','诺瓦',1);
    db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(acquired.petId,'HOME','IDLE','CALM','NORMAL','HIDDEN',500,1000,1000,0);
    db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run(acquired.petId,28,0);
    db.prepare('INSERT INTO pet_acquisitions VALUES (?, ?, ?, ?, ?, ?)').run(acquired.petId,acquired.acquiredAt,
      acquired.origin,acquired.catalogVersion,acquired.coinCost,acquired.commandId);
    db.prepare('INSERT INTO commands VALUES (?, ?, ?, 1, ?)').run(command.commandId,command.fingerprint,JSON.stringify(command.outcome),command.createdAt);
    db.exec('COMMIT');
    return {...prior,acquired,acquireCommand:command};
  } catch(error){db.exec('ROLLBACK');throw error;}
}

/** Genuine v4 archive: historical acquisition/CG/trip records plus the old
 * stack-only inventory and persisted home clocks; not a downgraded v5 file. */
function createV4Archive(db) {
  const prior=createV3Archive(db);
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(MIGRATION_004);
    db.prepare('INSERT INTO schema_migrations VALUES(4,?,?)').run(OLD_MIGRATION_004_CHECKSUM,START+3);
    db.exec('PRAGMA user_version=4');
    const clocks=db.prepare('SELECT pet_id FROM pets ORDER BY pet_id').all().map((row,index)=>({
      ...schedule(row.pet_id,prior.acquired.acquiredAt),energyRemainder:42+index,
    }));
    for(const clock of clocks)db.prepare('INSERT INTO pet_home_schedules VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(clock));
    db.prepare('INSERT INTO inventory VALUES (?,?)').run('legacy-unrecognized-material',7);
    db.exec('COMMIT');
    return {...prior,clocks,stacks:[{itemId:'herb',quantity:2},{itemId:'legacy-unrecognized-material',quantity:7}]};
  }catch(error){db.exec('ROLLBACK');throw error;}
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

  it('creates v1 through v6 in contiguous order with verified pragmas and no memory tables', () => withMemory((repo, db) => {
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('memory');
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA synchronous').get().synchronous).toBe(2);
    expect(db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
    const history = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    expect(history.map(row => row.version)).toEqual([1,2,3,4,5,6]);
    expect(history[0].checksum).toBe(OLD_MIGRATION_CHECKSUM);
    expect(history[1].checksum).toBe(OLD_MIGRATION_002_CHECKSUM);
    expect(history[2].checksum).toBe(OLD_MIGRATION_003_CHECKSUM);
    expect(history[3].checksum).toBe(OLD_MIGRATION_004_CHECKSUM);
    expect(history[4].checksum).toBe(OLD_MIGRATION_005_CHECKSUM);
    expect(history[5].checksum).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(db.prepare('SELECT name FROM sqlite_temp_schema').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)).toEqual([
      'cg_unlocks', 'commands', 'commerce_operation_instances', 'commerce_operation_materials', 'commerce_operations', 'inventory', 'item_instances', 'outbox',
      'pet_acquisitions', 'pet_equipment', 'pet_home_schedules', 'pet_progression', 'pet_states', 'pets', 'preferences',
      'reward_ledger', 'schema_migrations', 'settlements', 'trip_cg_asset_pins', 'trip_departure_equipment', 'trip_departure_loadouts', 'trip_departure_supplies', 'trip_events', 'trip_reports', 'trips', 'wallet',
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
const itemInstance=(instanceId,definitionId='apprentice-staff',definitionVersion=1,acquiredAt=START)=>
  ({instanceId,definitionId,definitionVersion,enhancement:0,acquiredAt});
const operationBase=(commandId,type,occurredAt=START,catalogVersion=1)=>({commandId,type,occurredAt,catalogVersion});
const canonical=(value)=>JSON.stringify(value,(_k,v)=>v!==null&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
function commerceReceipt(operation,payload,overrides={},walletCoins=0) {
  return { commandId:operation.commandId,
    fingerprint:canonical({commandId:operation.commandId,expectedRevision:0,issuedAt:operation.occurredAt,payload,type:operation.type}),
    outcome:{ok:true,snapshot:{revision:1,primaryPetId:null,pets:[],walletCoins,doNotDisturb:false,pausedRender:false}},
    createdAt:operation.occurredAt,...overrides };
}

const departureLoadout=(supplies=[],equipment=[])=>({routeCatalogVersion:1,itemCatalogVersion:1,level:1,energyCost10:120,
  supplies,stats:{hp:100,atk:12,def:8,spd:9,luk:10},battlePower:100,equipment});
const preparedInput=(trip,loadout)=>({petId:trip.snapshot.petId,routeId:trip.snapshot.routeId,routeCatalogVersion:loadout.routeCatalogVersion,
  selectedSupplies:loadout.supplies});
function departureReceipt(trip,record,overrides={},payload=preparedInput(trip,record.loadout),energy=48,walletCoins=0,revision=1) {
  const s=trip.snapshot;
  return {commandId:record.commandId,fingerprint:canonical({commandId:record.commandId,expectedRevision:revision-1,issuedAt:s.startAt,
    payload,type:'TRIP_START_PREPARED'}),createdAt:s.startAt,outcome:{ok:true,snapshot:{revision,primaryPetId:s.petId,pets:[{
      petId:s.petId,characterId:'character-a',nickname:'旅行者',presence:'AWAY',activity:null,mood:'CALM',healthStatus:'NORMAL',visibility:'VISIBLE',
      moodScore:75,healthPoints:100,energy,bond:15,level:record.loadout.level,xp:0,revision:1,
      trip:{tripId:s.tripId,routeId:s.routeId,status:'TRAVELING',expectedReturnAt:s.expectedReturnAt}}],walletCoins,doNotDisturb:true,pausedRender:true}},...overrides};
}
function legacyDepartureReceipt(trip,record,overrides={},energy=48,walletCoins=0,revision=1) {
  return departureReceipt(trip,record,{fingerprint:canonical({commandId:record.commandId,issuedAt:trip.snapshot.startAt,
    payload:{petId:trip.snapshot.petId,routeId:trip.snapshot.routeId},type:'TRIP_START'}),...overrides},undefined,energy,walletCoins,revision);
}

/** Genuine historical commerce archive, not constructed from v6 then downgraded. */
function createV5Archive(db) {
  const prior=createV4Archive(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATION_005);
    db.prepare('INSERT INTO schema_migrations VALUES(5,?,?)').run(OLD_MIGRATION_005_CHECKSUM,START+4);
    db.exec('PRAGMA user_version=5');
    const item=itemInstance('v5-staff','apprentice-staff',1,prior.acquired.acquiredAt);
    const operation={...operationBase('v5-buy','SHOP_PURCHASE',item.acquiredAt),offerId:'staff-offer',itemId:item.definitionId,
      quantity:1,coinCost:12,outputKind:'EQUIPMENT',instanceIds:[item.instanceId]};
    db.prepare('INSERT INTO item_instances VALUES(?,?,?,?,?,0)').run(item.instanceId,item.definitionId,item.definitionVersion,item.enhancement,item.acquiredAt);
    db.prepare('UPDATE wallet SET balance=30').run();
    db.prepare(`INSERT INTO commerce_operations(command_id,operation_type,occurred_at,catalog_version,offer_id,item_id,quantity,coin_cost,output_kind)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(operation.commandId,operation.type,operation.occurredAt,operation.catalogVersion,operation.offerId,
        operation.itemId,operation.quantity,operation.coinCost,operation.outputKind);
    db.prepare('INSERT INTO commerce_operation_instances VALUES(?,?)').run(operation.commandId,item.instanceId);
    const purchase=commerceReceipt(operation,{offerId:operation.offerId,quantity:1,catalogVersion:1},{},30);
    db.prepare('INSERT INTO commands VALUES(?,?,?,1,?)').run(purchase.commandId,purchase.fingerprint,JSON.stringify(purchase.outcome),purchase.createdAt);
    const binding={petId:'pet-a',slot:'WEAPON',instanceId:item.instanceId};
    db.prepare('INSERT INTO pet_equipment VALUES(?,?,?)').run(...Object.values(binding));
    const legacyDeparture=tripRecord('trip-v5','pet-c',prior.acquired.acquiredAt,DEMO_ROUTE),s=legacyDeparture.snapshot,c=legacyDeparture.checkpoint;
    db.prepare(`INSERT INTO trips(trip_id,pet_id,route_id,status,seed,snapshot_json,checkpoint_json,json_schema_version,start_at,expected_return_at,
      actual_returned_at,next_due_at,rules_version,cg_pin_schema) VALUES(?,?,?,'TRAVELING',?,?,?,1,?,?,NULL,?,?,2)`)
      .run(s.tripId,s.petId,s.routeId,s.seed,JSON.stringify(s),JSON.stringify(c),s.startAt,s.expectedReturnAt,c.nextDueAt,s.rulesVersion);
    db.prepare("UPDATE pet_states SET presence='AWAY',activity=NULL,energy10=580 WHERE pet_id='pet-c'").run();
    const oldDeparture=legacyDepartureReceipt(legacyDeparture,{commandId:'v5-depart',loadout:departureLoadout()},{},58,30,5);
    db.prepare('INSERT INTO commands VALUES(?,?,?,1,?)').run(oldDeparture.commandId,oldDeparture.fingerprint,JSON.stringify(oldDeparture.outcome),oldDeparture.createdAt);
    db.exec('COMMIT');
    return {...prior,item,operation,purchase,binding,legacyDeparture,oldDeparture};
  } catch(error){db.exec('ROLLBACK');throw error;}
}

describe('SQLite repository — real v1 archive migration', () => {
  it('verifies the old archive, runs a synchronous backup outside the transaction, preserves history and settles legacy in-flight only as unversioned', () => withFile(path => {
    const db = new DatabaseSync(path);
    const { old, active, oldUnlock, final } = createV1Archive(db);
    const backupPath = `${path}.before-v6`;
    let callbacks = 0;
    const repo = new SQLiteRepository(db, { persistent: true, beforeMigration(from, to) {
      callbacks++;
      expect([from,to]).toEqual([1,6]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
      expect(db.prepare('SELECT version, checksum FROM schema_migrations').all()).toEqual([{ version: 1, checksum: OLD_MIGRATION_CHECKSUM }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // VACUUM INTO would reject running under BEGIN IMMEDIATE. This proves
      // the migration hook really precedes any write transaction.
      db.prepare('VACUUM INTO ?').run(backupPath);
    } });
    try {
      expect(callbacks).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      expect(db.prepare('SELECT trip_id, cg_pin_schema FROM trips ORDER BY trip_id').all()).toEqual([
        { trip_id: 'trip-legacy', cg_pin_schema: 1 }, { trip_id: 'trip-old', cg_pin_schema: 1 },
      ]);
      repo.transaction(tx => {
        expect(tx.getWalletCoins()).toBe(42);
        expect(tx.listInventory()).toEqual([{ itemId: 'herb', quantity: 2 }]);
        expect(tx.getPreferences()).toEqual({ revision: 4, logicalTime: START + 123, primaryPetId: 'pet-a', doNotDisturb: true, pausedRender: false });
        expect(tx.getPet('pet-a').nickname).toBe('legacy pet-a');
        expect(tx.getPetAcquisition('pet-a')).toBeNull();
        expect(tx.getPetAcquisition('pet-b')).toBeNull();
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
    const v6 = new SQLiteRepository(reopened, { persistent: true, beforeMigration() { throw new Error('should not back up v6 again'); } });
    try {
      expect(v6.transaction(tx => tx.listCgUnlocks('pet-a'))).toEqual([unlocked(oldUnlock)]);
      expect(reopened.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check)).toEqual(['ok']);
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { v6.close(); }
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
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      expect(repo.transaction(tx => tx.getCgUnlock('pet-a','postcard','default'))).toEqual(unlocked(oldUnlock));
    } finally { db.close(); }
  }));

  it('verifies all six applied checksums and refuses missing or noncontiguous history on v6 startup', () => withFile(path => {
    const initial = new DatabaseSync(path);
    new SQLiteRepository(initial, { persistent: true }).close();
    const db = new DatabaseSync(path);
    try {
      const v6 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=6').get().checksum;
      for (const [version, checksum] of [[1, OLD_MIGRATION_CHECKSUM],[2, OLD_MIGRATION_002_CHECKSUM],[3,OLD_MIGRATION_003_CHECKSUM],[4,OLD_MIGRATION_004_CHECKSUM],[5,OLD_MIGRATION_005_CHECKSUM],[6,v6]]) {
        db.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=?").run(version);
        expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/checksum mismatch/);
        db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(checksum, version);
      }
      db.exec('UPDATE schema_migrations SET version=7 WHERE version=2');
      expect(() => new SQLiteRepository(db, { persistent: true })).toThrow(/not contiguous/);
      db.exec('DELETE FROM schema_migrations WHERE version=7');
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

describe('SQLite repository — genuine v2 acquisition migration', () => {
  it('preserves pinned CG/trips/receipt and legacy pets while invoking one v2→v6 pre-backup', () => withFile(path => {
    const db = new DatabaseSync(path), fixture = createV2Archive(db);
    const backupPath = `${path}.v2-copy`;
    let calls = 0;
    const repo = new SQLiteRepository(db, { persistent:true,beforeMigration(from,to) {
      calls++;
      expect([from,to]).toEqual([2,6]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
      expect(db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()).toEqual([
        {version:1,checksum:OLD_MIGRATION_CHECKSUM},{version:2,checksum:OLD_MIGRATION_002_CHECKSUM},
      ]);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_acquisitions')).toBeUndefined();
      db.prepare('VACUUM INTO ?').run(backupPath);
    } });
    try {
      expect(calls).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      expect(db.prepare('SELECT * FROM pet_acquisitions').all()).toEqual([]);
      repo.transaction(tx => {
        expect(tx.listPets().map(p=>p.petId)).toEqual(['pet-a','pet-b','pet-c']);
        expect(tx.getPet('pet-c').nickname).toBe('pinned pet');
        for (const petId of ['pet-a','pet-b','pet-c','absent']) expect(tx.getPetAcquisition(petId)).toBeNull();
        expect(tx.getTrip('trip-v2')).toEqual(fixture.trip);
        expect(tx.getTrip('trip-legacy')).toEqual(fixture.active);
        expect(tx.listTripCgAssetPins('trip-v2')).toEqual([fixture.pin]);
        expect(tx.getCgUnlock('pet-c','postcard','default')).toEqual(fixture.cg);
        expect(tx.getCgUnlock('pet-a','postcard','default')).toEqual(unlocked(fixture.oldUnlock));
        expect(tx.listRewards('trip-v2')).toEqual([fixture.line]);
        expect(tx.getCommandReceipt(fixture.command.commandId)).toEqual(fixture.command);
        expect(tx.getWalletCoins()).toBe(42);
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const backup = new DatabaseSync(backupPath);
      try {
        expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(2);
        expect(backup.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_acquisitions')).toBeUndefined();
        expect(backup.prepare('SELECT asset_version,asset_hash,favorite,viewed_at FROM cg_unlocks WHERE pet_id=?').get('pet-c')).toEqual({
          asset_version:fixture.pin.assetRef.assetVersion,asset_hash:fixture.pin.assetRef.assetHash,favorite:1,viewed_at:fixture.cg.viewedAt,
        });
        expect(backup.prepare('SELECT fingerprint FROM commands WHERE command_id=?').get(fixture.command.commandId).fingerprint).toBe(fixture.command.fingerprint);
      } finally { backup.close(); }
    } finally { repo.close(); }
  }));

  it('stops a v2 upgrade on missing/failed backup without touching original pinned records or history', () => withFile(path => {
    const db = new DatabaseSync(path);
    createV2Archive(db);
    const before = {
      history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      pets:db.prepare('SELECT * FROM pets ORDER BY pet_id').all(),
      pins:db.prepare('SELECT * FROM trip_cg_asset_pins').all(),
      cgs:db.prepare('SELECT * FROM cg_unlocks ORDER BY pet_id').all(),
      commands:db.prepare('SELECT * FROM commands').all(),
      trips:db.prepare('SELECT * FROM trips ORDER BY trip_id').all(),
    };
    try {
      expect(() => new SQLiteRepository(db,{persistent:true})).toThrow(/pre-migration backup callback/);
      expect(() => new SQLiteRepository(db,{persistent:true,beforeMigration(){throw new Error('v2 backup failed');}})).toThrow(/v2 backup failed/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_acquisitions')).toBeUndefined();
      expect({history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),pets:db.prepare('SELECT * FROM pets ORDER BY pet_id').all(),
        pins:db.prepare('SELECT * FROM trip_cg_asset_pins').all(),cgs:db.prepare('SELECT * FROM cg_unlocks ORDER BY pet_id').all(),
        commands:db.prepare('SELECT * FROM commands').all(),trips:db.prepare('SELECT * FROM trips ORDER BY trip_id').all()}).toEqual(before);
    } finally { db.close(); }
  }));

  it('rolls back v3 DDL after an injected failure and retries from the same valid v2 archive', () => withFile(path => {
    const db = new DatabaseSync(path), fixture = createV2Archive(db);
    const failing = { prepare:sql=>db.prepare(sql),close:()=>db.close(),
      exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE pet_acquisitions'))throw new Error('injected post-v3-DDL failure');} };
    let backups=0;
    const beforeMigration=()=>{backups++;};
    try {
      expect(()=>new SQLiteRepository(failing,{persistent:true,beforeMigration})).toThrow(/injected post-v3-DDL failure/);
      expect(backups).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
      expect(db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()).toEqual([
        {version:1,checksum:OLD_MIGRATION_CHECKSUM},{version:2,checksum:OLD_MIGRATION_002_CHECKSUM},
      ]);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_acquisitions')).toBeUndefined();
      const repo=new SQLiteRepository(db,{persistent:true,beforeMigration});
      expect(backups).toBe(2);
      expect(repo.transaction(tx=>[tx.getCgUnlock('pet-c','postcard','default'),tx.getCommandReceipt(fixture.command.commandId),tx.getPetAcquisition('pet-c')]))
        .toEqual([fixture.cg,fixture.command,null]);
    } finally { db.close(); }
  }));
});

describe('SQLite repository — genuine v3 home-clock migration', () => {
  it('upgrades v3 with one verified pre-backup and no invented clocks or changes to acquisition, CG, trip and receipt history', () => withFile(path=>{
    const db=new DatabaseSync(path), fixture=createV3Archive(db), backupPath=`${path}.v3-copy`;
    let calls=0;
    const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(from,to){
      calls++;
      expect([from,to]).toEqual([3,6]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(3);
      expect(db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()).toEqual([
        {version:1,checksum:OLD_MIGRATION_CHECKSUM},{version:2,checksum:OLD_MIGRATION_002_CHECKSUM},{version:3,checksum:OLD_MIGRATION_003_CHECKSUM},
      ]);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_home_schedules')).toBeUndefined();
      db.prepare('VACUUM INTO ?').run(backupPath);
    }});
    try{
      expect(calls).toBe(1);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      expect(db.prepare('SELECT * FROM pet_home_schedules').all()).toEqual([]);
      repo.transaction(tx=>{
        expect(tx.listPets().map(p=>p.petId)).toEqual(['pet-a','pet-b','pet-c',fixture.acquired.petId]);
        for(const p of tx.listPets()) expect(tx.getHomeSchedule(p.petId)).toBeNull();
        expect(tx.getPetAcquisition(fixture.acquired.petId)).toEqual(fixture.acquired);
        expect(tx.getPetAcquisition('pet-a')).toBeNull();
        expect(tx.getCommandReceipt(fixture.acquireCommand.commandId)).toEqual(fixture.acquireCommand);
        expect(tx.getCommandReceipt(fixture.command.commandId)).toEqual(fixture.command);
        expect(tx.getCgUnlock('pet-c','postcard','default')).toEqual(fixture.cg);
        expect(tx.listTripCgAssetPins('trip-v2')).toEqual([fixture.pin]);
        expect(tx.getTrip('trip-v2')).toEqual(fixture.trip);
        expect(tx.getTrip('trip-legacy')).toEqual(fixture.active);
        expect(tx.getPreferences().logicalTime).toBe(fixture.acquired.acquiredAt);
      });
      const backup=new DatabaseSync(backupPath);
      try{
        expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(3);
        expect(backup.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_home_schedules')).toBeUndefined();
        expect(backup.prepare('SELECT acquired_at,command_id FROM pet_acquisitions WHERE pet_id=?').get(fixture.acquired.petId)).toEqual({acquired_at:fixture.acquired.acquiredAt,command_id:fixture.acquired.commandId});
        expect(backup.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      }finally{backup.close();}
    }finally{repo.close();}
  }));

  it('failed pre-backup or post-DDL v4 fault preserves the original genuine v3 archive, then safely retries',()=>withFile(path=>{
    const db=new DatabaseSync(path), fixture=createV3Archive(db);
    const capture=()=>({history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      pets:db.prepare('SELECT * FROM pets ORDER BY pet_id').all(),acquisitions:db.prepare('SELECT * FROM pet_acquisitions').all(),
      cgs:db.prepare('SELECT * FROM cg_unlocks ORDER BY pet_id').all(),trips:db.prepare('SELECT * FROM trips ORDER BY trip_id').all(),
      commands:db.prepare('SELECT * FROM commands ORDER BY command_id').all()});
    const before=capture();
    const failing={prepare:sql=>db.prepare(sql),close:()=>db.close(),exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE pet_home_schedules'))throw new Error('v4 DDL fault');}};
    try{
      expect(()=>new SQLiteRepository(db,{persistent:true})).toThrow(/pre-migration backup callback/);
      expect(()=>new SQLiteRepository(db,{persistent:true,beforeMigration(){throw new Error('v3 backup failed');}})).toThrow(/v3 backup failed/);
      expect(()=>new SQLiteRepository(failing,{persistent:true,beforeMigration(){}})).toThrow(/v4 DDL fault/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(3);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('pet_home_schedules')).toBeUndefined();
      expect(capture()).toEqual(before);
      const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(){}});
      expect(repo.transaction(tx=>[tx.getPetAcquisition(fixture.acquired.petId),tx.getHomeSchedule(fixture.acquired.petId),tx.getCgUnlock('pet-c','postcard','default')]))
        .toEqual([fixture.acquired,null,fixture.cg]);
    }finally{db.close();}
  }));
});

describe('SQLite repository — genuine v4 commerce migration',()=>{
  it('adds empty equipment and operation tables with a mandatory pre-backup, preserving every legacy stack/history and home clock',()=>withFile(path=>{
    const db=new DatabaseSync(path),fixture=createV4Archive(db),backupPath=`${path}.v4-backup`;
    let calls=0;
    const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(from,to){
      calls++;expect([from,to]).toEqual([4,6]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(4);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('item_instances')).toBeUndefined();
      db.prepare('VACUUM INTO ?').run(backupPath);
    }});
    try{
      expect(calls).toBe(1);expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      repo.transaction(tx=>{
        expect(tx.listInventory()).toEqual(fixture.stacks);
        expect(tx.listItemInstances()).toEqual([]);expect(tx.listPetEquipment()).toEqual([]);expect(tx.getCommerceOperation('absent')).toBeNull();
        expect(fixture.clocks.map(clock=>tx.getHomeSchedule(clock.petId))).toEqual(fixture.clocks);
        expect(tx.getPetAcquisition(fixture.acquired.petId)).toEqual(fixture.acquired);
        expect(tx.getCgUnlock('pet-c','postcard','default')).toEqual(fixture.cg);
        expect(tx.getTrip('trip-v2')).toEqual(fixture.trip);expect(tx.listRewards('trip-v2')).toEqual([fixture.line]);
        expect(tx.getCommandReceipt(fixture.acquireCommand.commandId)).toEqual(fixture.acquireCommand);
        expect(tx.getCommandReceipt(fixture.command.commandId)).toEqual(fixture.command);
      });
      for(const table of ['item_instances','pet_equipment','commerce_operations','commerce_operation_materials','commerce_operation_instances'])
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
      const backup=new DatabaseSync(backupPath);
      try{
        expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(4);
        expect(backup.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('commerce_operations')).toBeUndefined();
        expect(backup.prepare('SELECT * FROM inventory ORDER BY item_id').all()).toEqual(fixture.stacks.map(stack=>({item_id:stack.itemId,quantity:stack.quantity})));
      }finally{backup.close();}
    }finally{repo.close();}
  }));

  it('failed backup and injected v5 DDL rollback leave the original v4 archive exactly intact and retryable',()=>withFile(path=>{
    const db=new DatabaseSync(path),fixture=createV4Archive(db);
    const capture=()=>({history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),inventory:db.prepare('SELECT * FROM inventory ORDER BY item_id').all(),
      rewards:db.prepare('SELECT * FROM reward_ledger').all(),commands:db.prepare('SELECT * FROM commands ORDER BY command_id').all(),
      schedules:db.prepare('SELECT * FROM pet_home_schedules ORDER BY pet_id').all()});
    const before=capture();
    const failing={prepare:sql=>db.prepare(sql),close:()=>db.close(),exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE item_instances'))throw new Error('v5 DDL fault');}};
    try{
      expect(()=>new SQLiteRepository(db,{persistent:true})).toThrow(/pre-migration backup callback/);
      expect(()=>new SQLiteRepository(db,{persistent:true,beforeMigration(){throw new Error('v4 backup failed');}})).toThrow(/v4 backup failed/);
      expect(()=>new SQLiteRepository(failing,{persistent:true,beforeMigration(){}})).toThrow(/v5 DDL fault/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(4);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('item_instances')).toBeUndefined();
      expect(capture()).toEqual(before);
      const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(){}});
      expect(repo.transaction(tx=>[tx.listInventory(),tx.listItemInstances(),tx.getCommandReceipt(fixture.command.commandId)]))
        .toEqual([fixture.stacks,[],fixture.command]);
    }finally{db.close();}
  }));
});

describe('SQLite repository — genuine v5 departure migration',()=>{
  it('backs up original v5 bytes once and preserves prior commerce, clocks, CG and trip history without inventing a loadout',()=>withFile(path=>{
    const db=new DatabaseSync(path),fixture=createV5Archive(db),backupPath=`${path}.v5-backup`;
    let calls=0;
    const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(from,to){
      calls++;expect([from,to]).toEqual([5,6]);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(5);
      expect(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('trip_departure_loadouts')).toBeUndefined();
      db.prepare('VACUUM INTO ?').run(backupPath);
    }});
    try {
      expect(calls).toBe(1);expect(db.prepare('PRAGMA user_version').get().user_version).toBe(6);
      repo.transaction(tx=>{
        expect(tx.listInventory()).toEqual(fixture.stacks);expect(tx.getWalletCoins()).toBe(30);
        expect(tx.getItemInstance(fixture.item.instanceId)).toEqual(fixture.item);
        expect(tx.listPetEquipment()).toEqual([fixture.binding]);
        expect(tx.getCommerceOperation(fixture.operation.commandId)).toEqual(fixture.operation);
        expect(tx.getCommandReceipt(fixture.purchase.commandId)).toEqual(fixture.purchase);
        expect(fixture.clocks.map(clock=>tx.getHomeSchedule(clock.petId))).toEqual(fixture.clocks);
        expect(tx.getPetAcquisition(fixture.acquired.petId)).toEqual(fixture.acquired);
        expect(tx.getCgUnlock('pet-c','postcard','default')).toEqual(fixture.cg);
        expect(tx.getTrip('trip-v2')).toEqual(fixture.trip);expect(tx.listRewards('trip-v2')).toEqual([fixture.line]);
        expect(tx.getTrip('trip-v5')).toEqual(fixture.legacyDeparture);
        expect(tx.getCommandReceipt(fixture.oldDeparture.commandId)).toEqual(fixture.oldDeparture);
        tx.saveCommandReceipt(fixture.oldDeparture); // historical success replay remains idempotent
        for (const trip of tx.listTrips()) expect(tx.getTripDepartureLoadout(trip.snapshot.tripId)).toBeNull();
      });
      expect(db.prepare('SELECT count(*) AS n FROM trips WHERE departure_loadout_trip_id IS NOT NULL').get().n).toBe(0);
      for (const table of ['trip_departure_loadouts','trip_departure_supplies','trip_departure_equipment']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const backup=new DatabaseSync(backupPath);
      try {
        expect(backup.prepare('PRAGMA user_version').get().user_version).toBe(5);
        expect(backup.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('trip_departure_loadouts')).toBeUndefined();
        expect(backup.prepare('SELECT fingerprint FROM commands WHERE command_id=?').get(fixture.oldDeparture.commandId).fingerprint).toBe(fixture.oldDeparture.fingerprint);
        expect(backup.prepare('SELECT instance_id FROM pet_equipment WHERE pet_id=?').get(fixture.binding.petId).instance_id).toBe(fixture.item.instanceId);
      } finally {backup.close();}
    } finally {repo.close();}
  }));

  it('failed backup and post-DDL v6 failure leave original v5 history/columns unchanged and retryable',()=>withFile(path=>{
    const db=new DatabaseSync(path),fixture=createV5Archive(db);
    const capture=()=>({history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),trips:db.prepare('SELECT * FROM trips ORDER BY trip_id').all(),
      items:db.prepare('SELECT * FROM item_instances').all(),commerce:db.prepare('SELECT * FROM commerce_operations').all(),commands:db.prepare('SELECT * FROM commands ORDER BY command_id').all()});
    const before=capture();
    const failing={prepare:sql=>db.prepare(sql),close:()=>db.close(),exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE trip_departure_loadouts'))throw new Error('v6 DDL fault');}};
    try{
      expect(()=>new SQLiteRepository(db,{persistent:true})).toThrow(/pre-migration backup callback/);
      expect(()=>new SQLiteRepository(db,{persistent:true,beforeMigration(){throw new Error('v5 backup failed');}})).toThrow(/v5 backup failed/);
      expect(()=>new SQLiteRepository(failing,{persistent:true,beforeMigration(){}})).toThrow(/v6 DDL fault/);
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(5);
      expect(db.prepare('PRAGMA table_info(trips)').all().map(r=>r.name)).not.toContain('departure_loadout_trip_id');
      expect(capture()).toEqual(before);
      const repo=new SQLiteRepository(db,{persistent:true,beforeMigration(){}});
      expect(repo.transaction(tx=>[tx.getTripDepartureLoadout('trip-v5'),tx.getCommandReceipt(fixture.oldDeparture.commandId),tx.getCommerceOperation(fixture.operation.commandId)]))
        .toEqual([null,fixture.oldDeparture,fixture.operation]);
    }finally{db.close();}
  }));
});

function stageDeparture(tx,trip,record,{marked=true,debit=true,transition=true,energy10=480,revision=1,includeLoadout=true}={}) {
  tx.insertTrip(trip,marked);
  if (debit) for (const supply of record.loadout.supplies) tx.addInventory(supply.itemId,-supply.quantity);
  if (includeLoadout) tx.insertTripDepartureLoadout(record);
  if (transition) tx.savePet({...pet(trip.snapshot.petId),presence:'AWAY',activity:null,energy10,revision:1});
  tx.savePreferences({...preferences(trip.snapshot.petId),logicalTime:trip.snapshot.startAt,revision});
}

describe('SQLite repository — departure authority and immutable history',()=>{
  const trip=tripRecord('trip-prepared'),
    weapon=itemInstance('frozen-weapon'),armor=itemInstance('frozen-armor','cloth-vest'),
    binding={petId:'pet-a',slot:'WEAPON',instanceId:weapon.instanceId},armorBinding={petId:'pet-a',slot:'ARMOR',instanceId:armor.instanceId};
  const gear=(item,slot,bonus=null)=>({slot,instanceId:item.instanceId,definitionId:item.definitionId,definitionVersion:item.definitionVersion,enhancement:item.enhancement,bonus});
  const equipment=[gear(armor,'ARMOR'),gear(weapon,'WEAPON',{hp:4,atk:2,def:0,spd:1,luk:0})];
  const supplies=[{itemId:'ration',quantity:2},{itemId:'herb',quantity:1}];
  const record={tripId:trip.snapshot.tripId,commandId:'depart-prepared',loadout:departureLoadout(supplies,equipment)};
  const canonicalLoadout={...record.loadout,equipment:[equipment[1],equipment[0]],supplies:[supplies[1],supplies[0]]};
  const seed=(repo,gearEnabled=true)=>repo.transaction(tx=>{
    tx.savePet(pet());tx.savePreferences(preferences());tx.addInventory('ration',3);tx.addInventory('herb',1);
    if(gearEnabled){tx.insertItemInstance(weapon);tx.insertItemInstance(armor);tx.equipItem(binding);tx.equipItem(armorBinding);}
  });

  it('commits prepared departure, supplies, exact gear and receipt atomically and returns stable canonical loadout',()=>withMemory((repo,db)=>{
    seed(repo);const success=departureReceipt(trip,record);
    repo.transaction(tx=>{stageDeparture(tx,trip,record);tx.saveCommandReceipt(success);});
    repo.transaction(tx=>{
      expect(tx.getTripDepartureLoadout(trip.snapshot.tripId)).toEqual(canonicalLoadout);
      expect(tx.getTripDepartureLoadout('absent')).toBeNull();
      expect(tx.getTrip(trip.snapshot.tripId)).toEqual(trip);
      expect(tx.getCommandReceipt(record.commandId)).toEqual(success);
      tx.saveCommandReceipt(success); // receipt replay doesn't consume supplies
      expect(tx.getPet('pet-a').energy10).toBe(480);
      expect(tx.listInventory()).toEqual([{itemId:'herb',quantity:0},{itemId:'ration',quantity:1}]);
      // Later equipment changes cannot rewrite a frozen historical bonus or enhancement.
      tx.unequipItem('pet-a','WEAPON',weapon.instanceId);tx.upgradeItemInstance(weapon.instanceId,0);tx.deleteItemInstance(weapon.instanceId);
      tx.unequipItem('pet-a','ARMOR',armor.instanceId);
      expect(tx.getTripDepartureLoadout(trip.snapshot.tripId)).toEqual(canonicalLoadout);
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT departure_loadout_trip_id FROM trips WHERE trip_id=?').get(trip.snapshot.tripId).departure_loadout_trip_id).toBe(trip.snapshot.tripId);
  }));

  it('allows the old supply-free meadow command while freezing the new loadout',()=>withMemory(repo=>{
    const meadow=tripRecord('trip-meadow','pet-a',START,DEMO_ROUTE),plain={tripId:meadow.snapshot.tripId,commandId:'depart-legacy',loadout:departureLoadout()};
    seed(repo,false);
    repo.transaction(tx=>{stageDeparture(tx,meadow,plain);tx.saveCommandReceipt(legacyDepartureReceipt(meadow,plain));});
    expect(repo.transaction(tx=>tx.getTripDepartureLoadout(meadow.snapshot.tripId))).toEqual(plain.loadout);
  }));

  it('deferred foreign keys reject marked trip without loadout or sidecar without receipt and roll back supply/pet changes',()=>withMemory((repo,db)=>{
    seed(repo);
    expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,record,{includeLoadout:false}))).toThrow(/foreign key/i);
    expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,record))).toThrow(/foreign key/i);
    expect(repo.transaction(tx=>[tx.getTrip(trip.snapshot.tripId),tx.getTripDepartureLoadout(trip.snapshot.tripId),tx.getPet('pet-a'),tx.listInventory()]))
      .toEqual([null,null,pet(),[{itemId:'herb',quantity:1},{itemId:'ration',quantity:3}]]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }));

  it('rejects orphan success while permitting failure receipts without any trip or supplies',()=>withMemory(repo=>{
    seed(repo);
    const success=departureReceipt(trip,record);
    expect(()=>repo.transaction(tx=>tx.saveCommandReceipt(success))).toThrow(/exact immutable successful loadout/);
    const failure={...success,outcome:{ok:false,error:{code:'BUSINESS_RULE',message:'not enough supplies',retryable:false}}};
    repo.transaction(tx=>tx.saveCommandReceipt(failure));
    expect(repo.transaction(tx=>tx.getCommandReceipt(record.commandId))).toEqual(failure);
    // A new loadout cannot attach itself to a previously recorded receipt.
    expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,record))).toThrow(/new marked trip/);
  }));

  it('rejects mismatched receipt identity, version, quantities, state, time and revision, rolling back each whole departure',()=>withMemory(repo=>{
    seed(repo);
    const base=departureReceipt(trip,record),payload=preparedInput(trip,record.loadout);
    const invalid=[departureReceipt(trip,record,{},{...payload,petId:'other'}),departureReceipt(trip,record,{},{...payload,routeId:'other-route'}),
      departureReceipt(trip,record,{},{...payload,routeCatalogVersion:2}),departureReceipt(trip,record,{},{...payload,selectedSupplies:[{itemId:'ration',quantity:1},{itemId:'herb',quantity:1}]}),
      {...base,createdAt:START+1},departureReceipt(trip,record,{},payload,47),departureReceipt(trip,record,{},payload,48,1),
      departureReceipt(trip,record,{},payload,48,0,2),legacyDepartureReceipt(trip,record),
      {...base,outcome:{...base.outcome,snapshot:{...base.outcome.snapshot,pets:[{...base.outcome.snapshot.pets[0],trip:{...base.outcome.snapshot.pets[0].trip,tripId:'other-trip'}}]}}}];
    for(const receipt of invalid){
      expect(()=>repo.transaction(tx=>{stageDeparture(tx,trip,record);tx.saveCommandReceipt(receipt);})).toThrow(/exact immutable successful loadout/);
      expect(repo.transaction(tx=>[tx.getTrip(trip.snapshot.tripId),tx.getCommandReceipt(record.commandId),tx.getPet('pet-a').energy10,tx.listInventory()]))
        .toEqual([null,null,600,[{itemId:'herb',quantity:1},{itemId:'ration',quantity:3}]]);
    }
    expect(()=>repo.transaction(tx=>{stageDeparture(tx,trip,record,{energy10:481});tx.saveCommandReceipt(base);})).toThrow(/exact immutable successful loadout/);
    expect(()=>repo.transaction(tx=>{stageDeparture(tx,trip,record,{transition:false});tx.saveCommandReceipt(base);})).toThrow(/exact immutable successful loadout/);
  }));

  it('requires every actual equipped slot at departure and rejects fake identities/versions/enhancement or wrong trip power',()=>withMemory(repo=>{
    seed(repo);
    for(const wrongGear of [[{...equipment[0],definitionVersion:2},equipment[1]],
      [{...equipment[0],enhancement:1},equipment[1]],[{...equipment[0],slot:'ACCESSORY'},equipment[1]]]){
      const wrong={...record,loadout:{...record.loadout,equipment:wrongGear}};
      expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,wrong))).toThrow(/invalid or immutable departure equipment/);
    }
    const partial={...record,loadout:{...record.loadout,equipment:[equipment[0]]}};
    expect(()=>repo.transaction(tx=>{stageDeparture(tx,trip,partial);tx.saveCommandReceipt(departureReceipt(trip,partial));})).toThrow(/exact immutable successful loadout/);
    expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,{...record,loadout:{...record.loadout,battlePower:999}}))).toThrow(/trip power/);
    expect(()=>repo.transaction(tx=>stageDeparture(tx,trip,{...record,loadout:{...record.loadout,energyCost10:601}}))).toThrow(/HOME pet energy/);
  }));

  it('fails closed on malformed bounded sidecar records before accepting evidence',()=>withMemory(repo=>{
    seed(repo);
    for(const changes of [{supplies:[supplies[0],supplies[0]]},{supplies:[{itemId:'ration',quantity:21}]},{equipment:[equipment[0],equipment[0]]},
      {stats:{hp:0,atk:1,def:1,spd:1,luk:1}},{level:21},{itemCatalogVersion:0},{battlePower:1001},{arbitrary:'extra'}]){
      expect(()=>repo.transaction(tx=>{tx.insertTrip(trip,true);tx.insertTripDepartureLoadout({...record,loadout:{...record.loadout,...changes}});})).toThrow();
    }
    expect(repo.transaction(tx=>tx.getTrip(trip.snapshot.tripId))).toBeNull();
  }));

  it('rejects attaching loadout to unmarked legacy, progressed or settled trips',()=>withMemory((repo,db)=>{
    seed(repo);
    repo.transaction(tx=>{tx.insertTrip(trip);tx.insertTripCgAssetPin(departurePin(trip));});
    expect(()=>repo.transaction(tx=>tx.insertTripDepartureLoadout(record))).toThrow(/new marked trip/);
    expect(()=>db.exec("UPDATE trips SET departure_loadout_trip_id=trip_id WHERE trip_id='trip-prepared'")).toThrow(/immutable/);
    repo.transaction(tx=>completeTrip(tx,trip));
    expect(()=>repo.transaction(tx=>tx.insertTripDepartureLoadout(record))).toThrow(/new marked trip/);
    const other=tripRecord('trip-clock','pet-a',START+100),newRecord={...record,tripId:other.snapshot.tripId};
    expect(()=>repo.transaction(tx=>{
      tx.insertTrip(other,true);
      const progress=advanceTrip(other.snapshot,other.checkpoint,other.snapshot.startAt+1);
      expect(progress.facts).toEqual([]);
      tx.updateTrip({...other,checkpoint:progress.checkpoint});
      tx.insertTripDepartureLoadout(newRecord);
    })).toThrow(/new marked trip/);
  }));

  it('freezes marker, parent/children and linked receipt even through raw SQL REPLACE, UPDATE or DELETE',()=>withMemory((repo,db)=>{
    seed(repo);repo.transaction(tx=>{stageDeparture(tx,trip,record);tx.saveCommandReceipt(departureReceipt(trip,record));});
    for(const sql of ["UPDATE trips SET departure_loadout_trip_id=NULL",'INSERT OR REPLACE INTO trips SELECT * FROM trips',
      'UPDATE trip_departure_loadouts SET level=2','DELETE FROM trip_departure_loadouts','INSERT OR REPLACE INTO trip_departure_loadouts SELECT * FROM trip_departure_loadouts',
      'UPDATE trip_departure_supplies SET quantity=quantity+1','DELETE FROM trip_departure_supplies','INSERT OR REPLACE INTO trip_departure_supplies SELECT * FROM trip_departure_supplies LIMIT 1',
      "INSERT INTO trip_departure_supplies VALUES('trip-prepared','new-supply',1)",
      'UPDATE trip_departure_equipment SET enhancement=1','DELETE FROM trip_departure_equipment','INSERT OR REPLACE INTO trip_departure_equipment SELECT * FROM trip_departure_equipment LIMIT 1',
      'UPDATE commands SET created_at=created_at+1','DELETE FROM commands','INSERT OR REPLACE INTO commands SELECT * FROM commands']){
      expect(()=>db.exec(sql)).toThrow(/immutable|marked trip|new marked trip|cannot be replaced|exact/i);
    }
    expect(repo.transaction(tx=>tx.getTripDepartureLoadout(trip.snapshot.tripId))).toEqual(canonicalLoadout);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }));

  it('paginates all settled trips and pet-filtered history by return time then tripId, never including active trips',()=>withMemory((repo,db)=>{
    repo.transaction(tx=>{
      tx.savePet(pet());tx.savePet(pet('pet-b'));
      for(const t of [tripRecord('trip-z','pet-b',START),tripRecord('trip-a','pet-a',START),tripRecord('trip-later','pet-a',START+90)]){
        tx.insertTrip(t);const result=advanceTrip(t.snapshot,t.checkpoint,t.snapshot.expectedReturnAt);
        tx.appendTripFacts(t.snapshot.tripId,result.facts);tx.insertSettlement({tripId:t.snapshot.tripId,settledAt:result.checkpoint.actualReturnedAt,rewards:result.rewardDraft});
        tx.updateTrip({...t,status:'SETTLED',checkpoint:result.checkpoint});
      }
      tx.insertTrip(tripRecord('trip-active','pet-b',START+1000));
      const page=(query)=>{const result=tx.listSettledTrips(query);return {total:result.total,trips:result.trips.map(t=>t.snapshot.tripId)};};
      expect(page({offset:0,limit:2})).toEqual({total:3,trips:['trip-later','trip-a']});
      expect(page({offset:2,limit:2})).toEqual({total:3,trips:['trip-z']});
      expect(page({offset:3,limit:2})).toEqual({total:3,trips:[]});
      expect(page({petId:'pet-a',offset:0,limit:2})).toEqual({total:2,trips:['trip-later','trip-a']});
      expect(page({petId:'pet-b',offset:0,limit:1})).toEqual({total:1,trips:['trip-z']});
      expect(page({petId:'unknown',offset:0,limit:1})).toEqual({total:0,trips:[]});
      for(const invalid of [{offset:-1,limit:2},{offset:0,limit:21},{offset:1_000_001,limit:1},{offset:0,limit:1,extra:true}]) expect(()=>page(invalid)).toThrow();
    });
    expect(db.prepare('PRAGMA index_list(trips)').all().map(index=>index.name)).toEqual(expect.arrayContaining(['settled_trip_history','settled_pet_trip_history']));
  }));
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

describe('SQLite repository — immutable pet acquisition and deferred receipt', () => {
  it('records new starters once and roundtrips game metadata with a receipt written later in the same WAL transaction', () => withFile(path => {
    const db = new DatabaseSync(path), repo = new SQLiteRepository(db,{persistent:true});
    const starter = starterAcquisition(), nextStarter = starterAcquisition('pet-b'), acquired = gameAcquisition();
    const receipt = successfulAcquireReceipt(acquired);
    try {
      repo.transaction(tx => {
        tx.savePet(pet()); tx.savePet(pet('pet-b'));
        expect(tx.getPetAcquisition('pet-a')).toBeNull();
        tx.insertPetAcquisition(starter); tx.insertPetAcquisition(nextStarter);
        expect(() => tx.insertPetAcquisition(starter)).toThrow(/immutable and unique/);
        expect(tx.getPetAcquisition('pet-a')).toEqual(starter);
        expect(tx.getPetAcquisition('pet-b')).toEqual(nextStarter);
        tx.setWalletCoins(16);
        tx.savePet({...pet(acquired.petId),characterId:'nova',nickname:'诺瓦',visibility:'HIDDEN'});
        tx.setWalletCoins(0);
        tx.insertPetAcquisition(acquired);
        // FK permits this temporary state but requires the exact successful
        // command receipt by COMMIT.
        expect(tx.getCommandReceipt(acquired.commandId)).toBeNull();
        expect(tx.getPetAcquisition(acquired.petId)).toEqual(acquired);
        tx.saveCommandReceipt(receipt);
        tx.saveCommandReceipt(receipt);
      });
    } finally { repo.close(); }
    const reopened = new DatabaseSync(path), after = new SQLiteRepository(reopened,{persistent:true});
    try {
      expect(after.transaction(tx=>[tx.getPetAcquisition(starter.petId),tx.getPetAcquisition(nextStarter.petId),tx.getPetAcquisition(acquired.petId),tx.getCommandReceipt(acquired.commandId),tx.getWalletCoins()]))
        .toEqual([starter,nextStarter,acquired,receipt,0]);
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(reopened.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check)).toEqual(['ok']);
    } finally { after.close(); }
  }));

  it('rolls back pet creation and shared coin debit when the deferred GAME receipt is missing', () => withMemory(repo => {
    const acquired=gameAcquisition();
    repo.transaction(tx=>tx.setWalletCoins(16));
    expect(()=>repo.transaction(tx=>{
      tx.savePet({...pet(acquired.petId),characterId:'nova'});
      tx.setWalletCoins(0);
      tx.insertPetAcquisition(acquired);
      expect(tx.getPetAcquisition(acquired.petId)).toEqual(acquired);
    })).toThrow(/foreign key/i);
    expect(repo.transaction(tx=>[tx.getPet(acquired.petId),tx.getPetAcquisition(acquired.petId),tx.getWalletCoins(),tx.getCommandReceipt(acquired.commandId)]))
      .toEqual([null,null,16,null]);
  }));

  it('rejects wrong command types, characters, versions, acquisition time, outcomes and result pet identity, with rollback', () => withMemory(repo => {
    const acquired=gameAcquisition(), valid=successfulAcquireReceipt(acquired);
    const wrongType={...valid,fingerprint:JSON.stringify({commandId:acquired.commandId,issuedAt:acquired.acquiredAt,
      payload:{enabled:true,flag:'doNotDisturb'},type:'APP_SET_MODE'})};
    const unsuccessful={...valid,outcome:{ok:false,error:{code:'BUSINESS_RULE',message:'denied',retryable:false}}};
    const invalidReceipts=[wrongType,successfulAcquireReceipt(acquired,'star-singer'),successfulAcquireReceipt(acquired,'nova',2),
      successfulAcquireReceipt(acquired,'nova',1,'other-pet'),successfulAcquireReceipt(acquired,'nova',1,acquired.petId,'star-singer'),
      {...valid,createdAt:acquired.acquiredAt+1},unsuccessful];
    repo.transaction(tx=>tx.setWalletCoins(16));
    for(const wrong of invalidReceipts){
      expect(()=>repo.transaction(tx=>{
        tx.savePet({...pet(acquired.petId),characterId:'nova'});
        tx.setWalletCoins(0);tx.insertPetAcquisition(acquired);tx.saveCommandReceipt(wrong);
      })).toThrow(/exact immutable successful receipt/);
      expect(repo.transaction(tx=>[tx.getPet(acquired.petId),tx.getPetAcquisition(acquired.petId),tx.getWalletCoins(),tx.getCommandReceipt(acquired.commandId)]))
        .toEqual([null,null,16,null]);
    }
  }));

  it('refuses to attach an acquisition to any already-existing command receipt, even a valid historical command', () => withMemory(repo => {
    const acquired=gameAcquisition();
    repo.transaction(tx=>{tx.savePet({...pet(acquired.petId),characterId:'nova'});tx.saveCommandReceipt(receipt());});
    expect(()=>repo.transaction(tx=>tx.insertPetAcquisition({...acquired,commandId:'command-a'}))).toThrow(/receipt already exists/);
    const prior=gameAcquisition(acquired.petId,'prior-success'), oldSuccess=successfulAcquireReceipt(prior);
    oldSuccess.fingerprint=JSON.stringify({commandId:prior.commandId,issuedAt:prior.acquiredAt,
      payload:{enabled:true,flag:'doNotDisturb'},type:'APP_SET_MODE'});
    repo.transaction(tx=>tx.saveCommandReceipt(oldSuccess));
    expect(()=>repo.transaction(tx=>tx.insertPetAcquisition(prior))).toThrow(/receipt already exists/);
    expect(repo.transaction(tx=>tx.getPetAcquisition(acquired.petId))).toBeNull();
  }));

  it('disallows an orphan successful acquisition receipt, allows ordinary failure receipt, and forbids retroactive success or sidecar attachment', () => withMemory((repo,db) => {
    const acquired=gameAcquisition(), valid=successfulAcquireReceipt(acquired);
    repo.transaction(tx=>tx.savePet({...pet(acquired.petId),characterId:'nova'}));
    expect(()=>repo.transaction(tx=>tx.saveCommandReceipt(valid))).toThrow(/exact immutable successful receipt/);
    expect(repo.transaction(tx=>tx.getCommandReceipt(acquired.commandId))).toBeNull();
    const failure={...valid,outcome:{ok:false,error:{code:'BUSINESS_RULE',message:'not enough coins',retryable:false}}};
    repo.transaction(tx=>tx.saveCommandReceipt(failure));
    expect(repo.transaction(tx=>[tx.getCommandReceipt(acquired.commandId),tx.getPetAcquisition(acquired.petId)])).toEqual([failure,null]);
    expect(()=>repo.transaction(tx=>tx.insertPetAcquisition(acquired))).toThrow(/receipt already exists/);
    expect(()=>db.prepare('UPDATE commands SET outcome_json=? WHERE command_id=?').run(JSON.stringify(valid.outcome),acquired.commandId))
      .toThrow(/cannot be retroactively added/);
    expect(repo.transaction(tx=>tx.getCommandReceipt(acquired.commandId))).toEqual(failure);
  }));

  it('validates closed records, safe integers, origin-specific cost/command and immediate pet FK', () => withMemory((repo,db) => {
    const starter=starterAcquisition(), invalid=[{...starter,acquiredAt:-1},{...starter,acquiredAt:1.5},{...starter,catalogVersion:0},
      {...starter,coinCost:1},{...starter,coinCost:Number.MAX_SAFE_INTEGER+1},{...starter,commandId:'unexpected'},
      {...starter,origin:'LEGACY'},{...starter,origin:'GAME'},{...starter,origin:'GAME',commandId:'invalid id'},
      {...starter,extra:'unexpected'},{petId:starter.petId}];
    repo.transaction(tx=>tx.savePet(pet()));
    for(const value of invalid) expect(()=>repo.transaction(tx=>tx.insertPetAcquisition(value))).toThrow();
    expect(()=>repo.transaction(tx=>tx.insertPetAcquisition(starterAcquisition('absent')))).toThrow(/foreign key/i);
    expect(()=>db.prepare('INSERT INTO pet_acquisitions VALUES (?, ?, ?, ?, ?, ?)').run('pet-a',START,'STARTER',1,9,null)).toThrow(/check constraint/i);
    expect(()=>db.prepare('INSERT INTO pet_acquisitions VALUES (?, ?, ?, ?, ?, ?)').run('pet-a',START,'GAME',1,0,null)).toThrow(/check constraint/i);
    expect(repo.transaction(tx=>tx.getPetAcquisition('pet-a'))).toBeNull();
    // Corrupt persisted data is not silently read as a valid acquisition even
    // if a broken external tool bypassed SQLite CHECK constraints.
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('INSERT INTO pet_acquisitions VALUES (?, ?, ?, ?, ?, ?)').run('pet-a',START,'STARTER',1,9,null);
    expect(()=>repo.transaction(tx=>tx.getPetAcquisition('pet-a'))).toThrow(/contradicts its cost/);
  }));

  it('prevents duplicate command reuse and record/receipt mutation via UPDATE, DELETE or REPLACE while allowing rename and ordinary pet changes', () => withMemory((repo,db) => {
    const acquired=gameAcquisition(), correct=successfulAcquireReceipt(acquired);
    // Even when the snapshot contains a second same-template instance, a
    // single command receipt cannot authorize two acquisition records.
    correct.outcome.snapshot.pets.push({...correct.outcome.snapshot.pets[0],petId:'other-pet'});
    repo.transaction(tx=>{tx.savePet({...pet(acquired.petId),characterId:'nova'});tx.savePet({...pet('other-pet'),characterId:'nova'});
      tx.insertPetAcquisition(acquired);tx.saveCommandReceipt(correct);});
    expect(()=>repo.transaction(tx=>{
      const duplicate=gameAcquisition('other-pet',acquired.commandId);
      tx.savePet({...pet(duplicate.petId),characterId:'nova'});tx.insertPetAcquisition(duplicate);
    })).toThrow(/immutable and unique|receipt already exists/);
    expect(()=>db.exec('UPDATE pet_acquisitions SET acquired_at=acquired_at+1')).toThrow(/immutable/);
    expect(()=>db.exec('DELETE FROM pet_acquisitions')).toThrow(/immutable/);
    expect(()=>db.exec('INSERT OR REPLACE INTO pet_acquisitions SELECT * FROM pet_acquisitions')).toThrow(/immutable and unique|receipt already exists/);
    expect(()=>db.exec("UPDATE commands SET outcome_json='{}' WHERE command_id='acquire-game'")).toThrow(/receipt is immutable/);
    expect(()=>db.exec("DELETE FROM commands WHERE command_id='acquire-game'")).toThrow(/receipt is immutable/);
    expect(()=>db.exec("INSERT OR REPLACE INTO commands SELECT * FROM commands WHERE command_id='acquire-game'")).toThrow(/immutable successful receipt/);
    expect(()=>repo.transaction(tx=>tx.savePet({...tx.getPet(acquired.petId),characterId:'star-singer'}))).toThrow(/acquired pet character is immutable/);
    expect(()=>db.prepare('INSERT OR REPLACE INTO pets VALUES (?, ?, ?, ?)').run(acquired.petId,'star-singer','different',1)).toThrow(/acquired pet character is immutable/);
    repo.transaction(tx=>{tx.savePet({...tx.getPet(acquired.petId),nickname:'诺瓦改名',xp:9,revision:1});});
    expect(repo.transaction(tx=>[tx.getPet(acquired.petId).nickname,tx.getPet(acquired.petId).xp,tx.getPetAcquisition(acquired.petId),tx.getCommandReceipt(acquired.commandId)]))
      .toEqual(['诺瓦改名',9,acquired,correct]);
    // Legacy instances without acquisition history retain the old storage
    // behavior until a later explicit migration/feature changes it.
    repo.transaction(tx=>{tx.savePet(pet('legacy'));tx.savePet({...tx.getPet('legacy'),characterId:'new-character'});});
    expect(repo.transaction(tx=>[tx.getPet('legacy').characterId,tx.getPetAcquisition('legacy')])).toEqual(['new-character',null]);
  }));
});

describe('SQLite repository — persisted home simulation clocks',()=>{
  it('roundtrips independent HOME/offsite schedules and exact fractional remainders through a WAL restart',()=>withFile(path=>{
    const db=new DatabaseSync(path), repo=new SQLiteRepository(db,{persistent:true});
    const target=START+12345;
    const first={...schedule(),lastSimAt:target,activityDueAt:target+30_000,energyRemainder:3_599_999,
      healthRemainder:555,moodRemainder:123,interactionCount:1,lastInteractionAt:target};
    const away=schedule('pet-b',target);
    try{
      repo.transaction(tx=>{
        tx.savePet({...pet(),activity:'REST'});tx.savePet({...pet('pet-b'),presence:'AWAY',activity:null});
        tx.savePreferences({...preferences(),logicalTime:target});
        expect(tx.getHomeSchedule('pet-a')).toBeNull();
        tx.saveHomeSchedule(schedule());tx.saveHomeSchedule(first);tx.saveHomeSchedule(first);
        tx.saveHomeSchedule(away);
        expect(tx.getHomeSchedule('pet-a')).toEqual(first);
      });
      expect(db.prepare('SELECT count(*) AS n FROM pet_home_schedules').get().n).toBe(2);
    }finally{repo.close();}
    const reopened=new DatabaseSync(path), after=new SQLiteRepository(reopened,{persistent:true});
    try{
      expect(after.transaction(tx=>[tx.getHomeSchedule('pet-a'),tx.getHomeSchedule('pet-b'),tx.getHomeSchedule('absent')])).toEqual([first,away,null]);
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }finally{after.close();}
  }));

  it('rejects regressing simulation time, UTC day, first-interaction timestamp and same-day count; resets only on a new UTC day',()=>withMemory(repo=>{
    const day=Math.floor(START/DAY_MS), nearMidnight=(day+1)*DAY_MS-100;
    const first={...schedule('pet-a',nearMidnight),interactionCount:5,lastInteractionAt:nearMidnight-20};
    repo.transaction(tx=>{tx.savePet(pet());tx.savePreferences({...preferences(),logicalTime:nearMidnight+1000});tx.saveHomeSchedule(first);});
    const invalid=[{...first,lastSimAt:nearMidnight-1},{...first,interactionDay:day-1,interactionCount:0},
      {...first,interactionCount:4},{...first,lastInteractionAt:first.lastInteractionAt-1},
      {...first,lastSimAt:nearMidnight+200,interactionDay:day+1,interactionCount:0,lastInteractionAt:null}];
    for(const record of invalid) expect(()=>repo.transaction(tx=>tx.saveHomeSchedule(record))).toThrow(/clock cannot regress/);
    expect(repo.transaction(tx=>tx.getHomeSchedule('pet-a'))).toEqual(first);
    const nextDay={...first,lastSimAt:nearMidnight+200,interactionDay:day+1,interactionCount:0};
    const nextReward={...nextDay,lastSimAt:nearMidnight+500,interactionCount:1,lastInteractionAt:nearMidnight+500};
    repo.transaction(tx=>{tx.saveHomeSchedule(nextDay);expect(tx.getHomeSchedule('pet-a')).toEqual(nextDay);
      tx.saveHomeSchedule(nextReward);});
    expect(repo.transaction(tx=>tx.getHomeSchedule('pet-a'))).toEqual(nextReward);
    expect(()=>repo.transaction(tx=>tx.saveHomeSchedule(nextDay))).toThrow(/clock cannot regress/);
  }));

  it('does not allow a schedule ahead of persisted application time or application clock rollback behind any pet',()=>withMemory((repo,db)=>{
    const first={...schedule(),lastSimAt:START+100};
    repo.transaction(tx=>{
      tx.savePet(pet());tx.savePet(pet('pet-b'));
      // A seed can be written before preferences exist, but initializing the
      // authoritative clock earlier than that seed is then refused.
      tx.saveHomeSchedule(first);
      expect(()=>tx.savePreferences(preferences())).toThrow(/precedes home schedules/);
      tx.savePreferences({...preferences(),logicalTime:first.lastSimAt});
    });
    const future=schedule('pet-b',first.lastSimAt+1);
    expect(()=>repo.transaction(tx=>tx.saveHomeSchedule(future))).toThrow(/exceeds application logical time/);
    expect(()=>db.prepare('INSERT INTO pet_home_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(future))).toThrow(/exceeds application logical time/);
    expect(()=>repo.transaction(tx=>tx.savePreferences({...preferences(),logicalTime:START}))).toThrow(/precedes home schedules/);
    expect(()=>db.exec(`UPDATE preferences SET logical_time=${START}`)).toThrow(/precedes home schedules/);
    expect(()=>db.exec('DELETE FROM preferences')).toThrow(/logical clock cannot be deleted/);
    repo.transaction(tx=>{tx.savePreferences({...preferences(),logicalTime:future.lastSimAt});tx.saveHomeSchedule(future);});
    expect(repo.transaction(tx=>tx.getHomeSchedule('pet-b'))).toEqual(future);
  }));

  it('rejects malformed schedule shapes, bad timestamps/remainders/counters and missing pet FK',()=>withMemory((repo,db)=>{
    const base=schedule();
    repo.transaction(tx=>{tx.savePet(pet());tx.savePreferences(preferences());});
    const invalid=[{...base,lastSimAt:-1},{...base,lastSimAt:NaN},{...base,lastSimAt:Number.MAX_SAFE_INTEGER+1},
      {...base,activityDueAt:START-1},{...base,activityDueAt:1.5},{...base,energyRemainder:3_600_000},
      {...base,healthRemainder:-1},{...base,moodRemainder:.5},{...base,interactionDay:base.interactionDay+1},
      {...base,interactionCount:11},{...base,interactionCount:1},{...base,lastInteractionAt:START+1},
      {...base,interactionCount:1,lastInteractionAt:START-DAY_MS},{...base,extra:'unexpected'},{petId:base.petId}];
    for(const record of invalid)expect(()=>repo.transaction(tx=>tx.saveHomeSchedule(record))).toThrow();
    expect(()=>repo.transaction(tx=>tx.saveHomeSchedule(schedule('missing')))).toThrow(/foreign key/i);
    const raw=db.prepare('INSERT INTO pet_home_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for(const record of [{...base,energyRemainder:3_600_000},{...base,activityDueAt:START-1},
      {...base,interactionCount:1},{...base,interactionDay:base.interactionDay+1},{...base,lastInteractionAt:START+1}])
      expect(()=>raw.run(...Object.values(record))).toThrow(/check constraint/i);
    expect(repo.transaction(tx=>tx.getHomeSchedule('pet-a'))).toBeNull();
    db.exec('PRAGMA ignore_check_constraints=ON');
    raw.run(...Object.values({...base,energyRemainder:3_600_000}));
    expect(()=>repo.transaction(tx=>tx.getHomeSchedule('pet-a'))).toThrow(/home energy remainder/);
  }));

  it('protects persisted clocks from raw SQL regression, deletion or REPLACE reset',()=>withMemory((repo,db)=>{
    const current={...schedule(),interactionCount:2,lastInteractionAt:START-1};
    repo.transaction(tx=>{tx.savePet(pet());tx.savePet(pet('pet-b'));tx.savePreferences(preferences());tx.saveHomeSchedule(current);});
    expect(()=>db.exec('UPDATE pet_home_schedules SET last_sim_at=last_sim_at-1')).toThrow(/cannot regress/);
    expect(()=>db.exec('UPDATE pet_home_schedules SET interaction_count=0')).toThrow(/cannot regress/);
    expect(()=>db.exec('UPDATE pet_home_schedules SET last_interaction_at=NULL')).toThrow(/cannot regress/);
    expect(()=>db.exec("UPDATE pet_home_schedules SET pet_id='pet-b'")).toThrow(/cannot regress or change pet/);
    expect(()=>db.prepare('INSERT OR REPLACE INTO pet_home_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(schedule()))).toThrow(/cannot regress/);
    expect(()=>db.exec('DELETE FROM pet_home_schedules')).toThrow(/cannot be deleted/);
    expect(repo.transaction(tx=>tx.getHomeSchedule('pet-a'))).toEqual(current);
  }));

  it('rolls back home clock, fractional simulation, preference and pet changes within the same failed transaction',()=>withMemory(repo=>{
    const before=schedule();
    repo.transaction(tx=>{tx.savePet(pet());tx.savePreferences(preferences());tx.saveHomeSchedule(before);});
    expect(()=>repo.transaction(tx=>{
      tx.savePreferences({...preferences(),logicalTime:START+2000});
      tx.savePet({...pet(),energy10:700,revision:1});
      tx.saveHomeSchedule({...before,lastSimAt:START+2000,energyRemainder:20,interactionCount:1,lastInteractionAt:START+2000});
      throw new Error('home simulation transaction failed');
    })).toThrow(/home simulation transaction failed/);
    expect(repo.transaction(tx=>[tx.getHomeSchedule('pet-a'),tx.getPreferences(),tx.getPet('pet-a')])).toEqual([before,preferences(),pet()]);
  }));
});

describe('SQLite repository — active equipment and immutable commerce history',()=>{
  it('persists all six commerce commands and equipment replacement across WAL restart without touching trip ledger',()=>withFile(path=>{
    const firstDb=new DatabaseSync(path),repo=new SQLiteRepository(firstDb,{persistent:true});
    const staffA=itemInstance('item-a'),staffB=itemInstance('item-b');
    const owner={petId:'pet-a',slot:'WEAPON',instanceId:staffA.instanceId};
    const replacement={...owner,instanceId:staffB.instanceId};
    const operations=[];
    const commit=(operation,payload,mutate)=>repo.transaction(tx=>{
      mutate(tx);tx.insertCommerceOperation(operation);
      expect(tx.getCommandReceipt(operation.commandId)).toBeNull();
      tx.saveCommandReceipt(commerceReceipt(operation,{...payload,catalogVersion:operation.catalogVersion},{},tx.getWalletCoins()));
      const stored=tx.getCommerceOperation(operation.commandId);
      operations.push(stored);
      expect(stored).toEqual(operation.type==='SHOP_PURCHASE'?{...operation,instanceIds:[...operation.instanceIds].sort()}:operation);
    });
    try{
      repo.transaction(tx=>{tx.savePet(pet());tx.savePet({...pet('pet-b'),visibility:'HIDDEN'});tx.setWalletCoins(100);tx.addInventory('iron-ore',5);});
      const stack={...operationBase('buy-stack','SHOP_PURCHASE'),offerId:'ration-offer',itemId:'ration',quantity:2,coinCost:4,outputKind:'STACK',instanceIds:[]};
      commit(stack,{offerId:stack.offerId,quantity:2},tx=>{tx.setWalletCoins(96);tx.addInventory('ration',2);});
      const equipment={...operationBase('buy-items','SHOP_PURCHASE'),offerId:'staff-offer',itemId:'apprentice-staff',quantity:2,coinCost:24,outputKind:'EQUIPMENT',instanceIds:['item-b','item-a']};
      commit(equipment,{offerId:equipment.offerId,quantity:2},tx=>{tx.setWalletCoins(72);tx.insertItemInstance(staffA);tx.insertItemInstance(staffB);});
      const equip={...operationBase('equip-one','EQUIPMENT_EQUIP'),...owner,previousInstanceId:null};
      commit(equip,owner,tx=>tx.equipItem(owner));
      const replace={...operationBase('equip-replace','EQUIPMENT_EQUIP'),...replacement,previousInstanceId:staffA.instanceId};
      commit(replace,replacement,tx=>{tx.unequipItem(owner.petId,owner.slot,owner.instanceId);tx.equipItem(replacement);});
      const unequip={...operationBase('unequip','EQUIPMENT_UNEQUIP'),...replacement};
      commit(unequip,{petId:replacement.petId,slot:replacement.slot},tx=>tx.unequipItem(replacement.petId,replacement.slot,replacement.instanceId));
      const upgrade={...operationBase('upgrade','EQUIPMENT_UPGRADE'),instanceId:staffA.instanceId,fromEnhancement:0,toEnhancement:1,coinCost:10,
        materials:[{itemId:'iron-ore',quantity:1}]};
      commit(upgrade,{instanceId:staffA.instanceId,expectedEnhancement:0},tx=>{
        tx.setWalletCoins(62);tx.addInventory('iron-ore',-1);expect(tx.upgradeItemInstance(staffA.instanceId,0)).toEqual({...staffA,enhancement:1});
      });
      const salvage={...operationBase('salvage','EQUIPMENT_SALVAGE'),instanceId:staffA.instanceId,enhancement:1,materials:[{itemId:'iron-scrap',quantity:1}]};
      commit(salvage,{instanceId:staffA.instanceId,expectedEnhancement:1},tx=>{tx.deleteItemInstance(staffA.instanceId);tx.addInventory('iron-scrap',1);});
      const use={...operationBase('use-ration','ITEM_USE'),petId:'pet-a',itemId:'ration'};
      commit(use,{petId:'pet-a',itemId:'ration'},tx=>tx.addInventory('ration',-1));
      expect(firstDb.prepare('SELECT count(*) AS n FROM reward_ledger').get().n).toBe(0);
    }finally{repo.close();}
    const db=new DatabaseSync(path),after=new SQLiteRepository(db,{persistent:true});
    try{
      after.transaction(tx=>{
        expect(tx.listItemInstances()).toEqual([staffB]);expect(tx.getItemInstance('item-a')).toBeNull();
        expect(tx.listPetEquipment()).toEqual([]);expect(tx.getPetEquipment('pet-a','WEAPON')).toBeNull();
        expect(tx.getInstanceEquipment('item-b')).toBeNull();
        expect(tx.getWalletCoins()).toBe(62);
        expect(tx.listInventory()).toEqual([{itemId:'iron-ore',quantity:4},{itemId:'iron-scrap',quantity:1},{itemId:'ration',quantity:1}]);
        for(const op of operations){expect(tx.getCommerceOperation(op.commandId)).toEqual(op);expect(tx.getCommandReceipt(op.commandId).outcome.ok).toBe(true);}
        expect(()=>tx.insertItemInstance(staffA)).toThrow(/unique \+0 active identity/);
      });
      expect(db.prepare('SELECT retired,enhancement FROM item_instances WHERE instance_id=?').get('item-a')).toEqual({retired:1,enhancement:1});
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').all().map(row=>row.integrity_check)).toEqual(['ok']);
    }finally{after.close();}
  }));

  it('enforces unique per-pet slot and per-instance ownership, explicit expected unequip, and tombstone immutability',()=>withMemory((repo,db)=>{
    const one=itemInstance('item-1'),two=itemInstance('item-2'),binding={petId:'pet-a',slot:'WEAPON',instanceId:one.instanceId};
    repo.transaction(tx=>{tx.savePet(pet());tx.savePet(pet('pet-b'));tx.insertItemInstance(one);tx.insertItemInstance(two);tx.equipItem(binding);});
    expect(repo.transaction(tx=>[tx.listPetEquipment('pet-a'),tx.getPetEquipment('pet-a','WEAPON'),tx.getInstanceEquipment(one.instanceId)]))
      .toEqual([[binding],binding,binding]);
    for(const conflicting of [{...binding,instanceId:two.instanceId},{...binding,petId:'pet-b'},{...binding,slot:'ARMOR'}])
      expect(()=>repo.transaction(tx=>tx.equipItem(conflicting))).toThrow(/free slot and active unequipped/);
    expect(()=>repo.transaction(tx=>tx.unequipItem('pet-a','WEAPON','wrong'))).toThrow(/expected instance/);
    expect(()=>repo.transaction(tx=>tx.deleteItemInstance(one.instanceId))).toThrow(/unequipped/);
    expect(()=>db.exec("UPDATE pet_equipment SET slot='ARMOR'")).toThrow(/explicitly unequipped/);
    expect(()=>db.exec('INSERT OR REPLACE INTO pet_equipment SELECT * FROM pet_equipment')).toThrow(/free slot/);
    expect(()=>db.exec("UPDATE item_instances SET retired=1 WHERE instance_id='item-1'")).toThrow(/unequipped retirement/);
    repo.transaction(tx=>{tx.unequipItem(binding.petId,binding.slot,binding.instanceId);tx.deleteItemInstance(one.instanceId);});
    expect(repo.transaction(tx=>tx.listItemInstances())).toEqual([two]);
    expect(()=>db.exec("UPDATE item_instances SET retired=0 WHERE instance_id='item-1'")).toThrow(/item identity is immutable/);
    expect(()=>db.exec("DELETE FROM item_instances WHERE instance_id='item-1'")).toThrow(/identity cannot be deleted/);
    expect(()=>db.exec("INSERT OR REPLACE INTO item_instances SELECT * FROM item_instances WHERE instance_id='item-1'")).toThrow(/unique \+0/);
    expect(()=>repo.transaction(tx=>tx.equipItem(binding))).toThrow(/active unequipped/);
  }));

  it('bounds active equipment at 500, refuses stale/skipped/over-cap upgrades, and never reuses retired IDs',()=>withMemory((repo,db)=>{
    const first=itemInstance('item-000');
    repo.transaction(tx=>{
      for(let i=0;i<500;i++)tx.insertItemInstance(itemInstance(`item-${String(i).padStart(3,'0')}`));
      expect(tx.listItemInstances()).toHaveLength(500);
      expect(()=>tx.insertItemInstance(itemInstance('overflow'))).toThrow(/within capacity/);
      for(let n=0;n<5;n++)expect(tx.upgradeItemInstance(first.instanceId,n).enhancement).toBe(n+1);
      expect(()=>tx.upgradeItemInstance(first.instanceId,4)).toThrow(/expected enhancement/);
      expect(()=>tx.upgradeItemInstance(first.instanceId,5)).toThrow();
      tx.deleteItemInstance(first.instanceId);tx.insertItemInstance(itemInstance('replacement'));
      expect(tx.listItemInstances()).toHaveLength(500);
      expect(()=>tx.insertItemInstance(first)).toThrow(/unique \+0/);
    });
    expect(()=>db.exec("UPDATE item_instances SET enhancement=enhancement+2 WHERE instance_id='replacement'")).toThrow(/one upgrade/);
    expect(()=>db.exec("UPDATE item_instances SET definition_version=2,enhancement=1 WHERE instance_id='replacement'")).toThrow(/identity is immutable/);
    expect(()=>db.exec("UPDATE item_instances SET acquired_at=acquired_at+1,enhancement=1 WHERE instance_id='replacement'")).toThrow(/identity is immutable/);
    expect(()=>repo.transaction(tx=>tx.insertItemInstance({...itemInstance('new'),'enhancement':1}))).toThrow(/start at \+0/);
  }));

  it('requires exact operation/receipt intent, timestamp, catalog version and successful outcome, rolling back wallet, stacks and item writes',()=>withMemory(repo=>{
    const op={...operationBase('purchase','SHOP_PURCHASE'),offerId:'ration-offer',itemId:'ration',quantity:2,coinCost:4,outputKind:'STACK',instanceIds:[]};
    const payload={offerId:op.offerId,quantity:2,catalogVersion:1};
    repo.transaction(tx=>tx.setWalletCoins(20));
    const valid=commerceReceipt(op,payload,{},16);
    for(const wrong of [commerceReceipt(op,{...payload,quantity:1},{},16),commerceReceipt(op,{...payload,offerId:'other-offer'},{},16),
      commerceReceipt(op,{...payload,catalogVersion:2},{},16),{...valid,createdAt:START+1},
      {...valid,outcome:{ok:true,snapshot:{...valid.outcome.snapshot,revision:2}}},
      {...valid,outcome:{ok:true,snapshot:{...valid.outcome.snapshot,walletCoins:17}}},
      {...valid,outcome:{ok:false,error:{code:'BUSINESS_RULE',message:'denied',retryable:false}}}]){
      expect(()=>repo.transaction(tx=>{tx.setWalletCoins(16);tx.addInventory('ration',2);tx.insertCommerceOperation(op);tx.saveCommandReceipt(wrong);})).toThrow(/exact immutable successful operation/);
      expect(repo.transaction(tx=>[tx.getWalletCoins(),tx.listInventory(),tx.getCommerceOperation(op.commandId),tx.getCommandReceipt(op.commandId)]))
        .toEqual([20,[],null,null]);
    }
    expect(()=>repo.transaction(tx=>{tx.setWalletCoins(16);tx.addInventory('ration',2);tx.insertCommerceOperation(op);})).toThrow(/foreign key/i);
    expect(repo.transaction(tx=>[tx.getWalletCoins(),tx.listInventory(),tx.getCommerceOperation(op.commandId)])).toEqual([20,[],null]);
    expect(()=>repo.transaction(tx=>tx.saveCommandReceipt(valid))).toThrow(/exact immutable successful operation/);
    const rejection={...valid,outcome:{ok:false,error:{code:'BUSINESS_RULE',message:'denied',retryable:false}}};
    repo.transaction(tx=>tx.saveCommandReceipt(rejection));
    expect(repo.transaction(tx=>tx.getCommandReceipt(op.commandId))).toEqual(rejection);
    expect(()=>repo.transaction(tx=>tx.insertCommerceOperation(op))).toThrow(/new unique command without receipt/);
  }));

  it('validates closed bounded evidence and refuses purchases/upgrade/equip/salvage receipts without corresponding actual instance state',()=>withMemory(repo=>{
    const item=itemInstance('owned-item');
    repo.transaction(tx=>{tx.savePet(pet());tx.insertItemInstance(item);});
    const shop={...operationBase('bad-shop','SHOP_PURCHASE'),offerId:'staff-offer',itemId:item.definitionId,quantity:1,coinCost:12,outputKind:'EQUIPMENT',instanceIds:[item.instanceId]};
    for(const invalid of [{...shop,quantity:2},{...shop,instanceIds:['owned-item','owned-item']},{...shop,coinCost:-1},{...shop,extra:'x'},{...shop,outputKind:'STACK'},
      {...operationBase('bad-upgrade','EQUIPMENT_UPGRADE'),instanceId:item.instanceId,fromEnhancement:0,toEnhancement:2,coinCost:10,materials:[{itemId:'iron-ore',quantity:1}]},
      {...operationBase('bad-salvage','EQUIPMENT_SALVAGE'),instanceId:item.instanceId,enhancement:0,materials:[{itemId:'iron-ore',quantity:1},{itemId:'iron-ore',quantity:2}]},
      {...operationBase('unbounded','EQUIPMENT_SALVAGE'),instanceId:item.instanceId,enhancement:0,materials:Array.from({length:17},(_,i)=>({itemId:`material-${i}`,quantity:1}))},
    ])expect(()=>repo.transaction(tx=>tx.insertCommerceOperation(invalid))).toThrow();
    expect(()=>repo.transaction(tx=>tx.insertCommerceOperation({...shop,occurredAt:START+1}))).toThrow(/invalid or immutable commerce instance evidence/);
    expect(()=>repo.transaction(tx=>tx.insertCommerceOperation({...shop,itemId:'other-definition'}))).toThrow(/invalid or immutable commerce instance evidence/);
    const upgrade={...operationBase('upgrade-not-applied','EQUIPMENT_UPGRADE'),instanceId:item.instanceId,fromEnhancement:0,toEnhancement:1,coinCost:10,materials:[{itemId:'iron-ore',quantity:1}]};
    const salvage={...operationBase('salvage-not-applied','EQUIPMENT_SALVAGE'),instanceId:item.instanceId,enhancement:0,materials:[{itemId:'iron-scrap',quantity:1}]};
    const equip={...operationBase('equip-not-applied','EQUIPMENT_EQUIP'),petId:'pet-a',slot:'WEAPON',instanceId:item.instanceId,previousInstanceId:null};
    for(const [operation,payload] of [[upgrade,{instanceId:item.instanceId,expectedEnhancement:0,catalogVersion:1}],
      [salvage,{instanceId:item.instanceId,expectedEnhancement:0,catalogVersion:1}],[equip,{petId:'pet-a',slot:'WEAPON',instanceId:item.instanceId,catalogVersion:1}]]){
      expect(()=>repo.transaction(tx=>{tx.insertCommerceOperation(operation);tx.saveCommandReceipt(commerceReceipt(operation,payload));})).toThrow(/exact immutable successful operation/);
      expect(repo.transaction(tx=>tx.getCommerceOperation(operation.commandId))).toBeNull();
    }
    expect(repo.transaction(tx=>[tx.getItemInstance(item.instanceId),tx.listPetEquipment()])).toEqual([item,[]]);
  }));

  it('prevents late material or instance evidence, historical operation/receipt rewriting and duplicate purchase grants',()=>withMemory((repo,db)=>{
    const item=itemInstance('owned'),shop={...operationBase('shop','SHOP_PURCHASE'),offerId:'staff-offer',itemId:item.definitionId,quantity:1,coinCost:12,outputKind:'EQUIPMENT',instanceIds:[item.instanceId]};
    const upgrade={...operationBase('upgrade','EQUIPMENT_UPGRADE'),instanceId:item.instanceId,fromEnhancement:0,toEnhancement:1,coinCost:10,materials:[{itemId:'iron-ore',quantity:1}]};
    repo.transaction(tx=>{tx.insertItemInstance(item);tx.insertCommerceOperation(shop);tx.saveCommandReceipt(commerceReceipt(shop,{offerId:shop.offerId,quantity:1,catalogVersion:1}));});
    expect(()=>repo.transaction(tx=>tx.insertCommerceOperation({...shop,commandId:'duplicate-shop'}))).toThrow(/invalid or immutable commerce instance evidence/);
    repo.transaction(tx=>{tx.upgradeItemInstance(item.instanceId,0);tx.insertCommerceOperation(upgrade);tx.saveCommandReceipt(commerceReceipt(upgrade,{instanceId:item.instanceId,expectedEnhancement:0,catalogVersion:1}));});
    expect(()=>db.exec("UPDATE commerce_operations SET coin_cost=0 WHERE command_id='upgrade'")).toThrow(/immutable/);
    expect(()=>db.exec('DELETE FROM commerce_operations')).toThrow(/immutable/);
    expect(()=>db.exec('INSERT OR REPLACE INTO commerce_operations SELECT * FROM commerce_operations')).toThrow(/new unique command/);
    expect(()=>db.exec("UPDATE commerce_operation_materials SET quantity=2")).toThrow(/immutable/);
    expect(()=>db.exec('DELETE FROM commerce_operation_materials')).toThrow(/immutable/);
    expect(()=>db.exec("INSERT INTO commerce_operation_materials VALUES ('upgrade','late-material',1)")).toThrow(/immutable commerce material/);
    expect(()=>db.exec('DELETE FROM commerce_operation_instances')).toThrow(/immutable/);
    expect(()=>db.exec("INSERT INTO commerce_operation_instances VALUES ('shop','missing')")).toThrow(/immutable commerce instance/);
    expect(()=>db.exec("UPDATE commands SET outcome_json='{}' WHERE command_id='upgrade'")).toThrow(/commerce receipt is immutable/);
    expect(()=>db.exec("DELETE FROM commands WHERE command_id='shop'")).toThrow(/commerce receipt is immutable/);
    expect(()=>db.exec("INSERT OR REPLACE INTO commands SELECT * FROM commands WHERE command_id='shop'")).toThrow(/exact immutable successful operation/);
    expect(repo.transaction(tx=>[tx.getCommerceOperation(shop.commandId),tx.getCommerceOperation(upgrade.commandId)])).toEqual([shop,upgrade]);
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
