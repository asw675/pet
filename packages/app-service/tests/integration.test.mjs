import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../src/app-service.ts';
import { verifyMigrationBackup } from '../src/migration-backup.ts';
import { MIGRATION_001, SQLiteRepository } from '../src/sqlite-repository.ts';
import { advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE } from '@pet-desktop/domain';
import { findBuiltinCg } from '@pet-desktop/domain/cg-catalog';

const initialTime = 1_800_000_000_000;
const minutes = (n) => n * 60_000;
let DatabaseSync;
let sqliteVersion = '0.0.0';
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  const probe = new DatabaseSync(':memory:');
  sqliteVersion = probe.prepare('SELECT sqlite_version() AS version').get().version;
  probe.close();
} catch { /* The persistent POC requires a supported Node/SQLite runtime. */ }
const [major, minor, patch] = sqliteVersion.split('.').map(Number);
const supported = major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)));

const directories = [];
const openRepositories = new Set();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pet-desktop-integration-'));
  directories.push(directory);
  const dbPath = join(directory, 'state.sqlite');
  let now = initialTime;
  let sequence = 0;
  const runtime = {
    now: () => now,
    seed: () => 8,
    createId: (kind) => `${kind}-${++sequence}`,
  };
  const open = (wrap = (repo) => repo, options = {}) => {
    const connection = new DatabaseSync(dbPath);
    const { beforeMigration, ...rest } = options;
    const repo = new SQLiteRepository(connection, { persistent: true, ...rest,
      ...(beforeMigration ? { beforeMigration: (from, to) => beforeMigration(connection, from, to) } : {}) });
    openRepositories.add(repo);
    const service = new AppService(wrap(repo), runtime);
    return { repo, service, close: () => { service.close(); openRepositories.delete(repo); } };
  };
  const command = (type, payload, commandId = `command-${++sequence}`, expectedRevision) => ({
    type, payload, commandId, issuedAt: now,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
  const request = (service, command) => service.handleRequest({
    schemaVersion: 1, requestId: `request-${++sequence}`, method: 'command/dispatch', payload: { command },
  });
  return { open, command, request, dbPath, advance: (value) => { now = value; } };
}

afterEach(() => {
  for (const repo of openRepositories) repo.close();
  openRepositories.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function expectSuccess(result) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected result: ${result.error.code}`);
  return result.snapshot;
}

function readGallery(service, query = {}) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'gallery-query', method: 'gallery/list',
    payload: { filter: 'ALL', offset: 0, limit: 50, ...query } });
  expect(result.ok).toBe(true);
  expect(result.gallery.revision).toBe(result.snapshot.revision);
  return result;
}

describe.skipIf(!supported)('application service + real SQLite persisted integration', () => {
  it('settles frozen travel once and preserves report, ledger, CG, wallet and XP after 20 restarts', () => {
    const f = fixture();
    let instance = f.open();
    const initial = instance.service.getSnapshot();
    expect(initial.pets).toHaveLength(2);
    const petId = initial.primaryPetId;
    const startCommand = f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId }, 'start-once');
    const started = expectSuccess(f.request(instance.service, startCommand));
    const pet = started.pets.find((value) => value.petId === petId);
    expect(pet.presence).toBe('AWAY');
    expect(pet.energy).toBe(initial.pets.find((value) => value.petId === petId).energy - 15);
    const tripId = pet.trip.tripId;
    const frozen = instance.repo.transaction((tx) => tx.getTrip(tripId).snapshot);
    const expected = advanceTrip(frozen, createTripCheckpoint(frozen), frozen.expectedReturnAt);

    expect(expectSuccess(f.request(instance.service, startCommand))).toEqual(started);
    const conflict = f.request(instance.service, { ...startCommand, payload: { petId, routeId: 'other-route' } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'COMMAND_CONFLICT' } });
    instance.close();

    f.advance(initialTime + minutes(60 * 72));
    let final;
    let ledger;
    for (let repeat = 0; repeat < 20; repeat++) {
      instance = f.open();
      const snapshot = instance.service.getSnapshot();
      const stored = instance.repo.transaction((tx) => ({
        settlement: tx.getSettlement(tripId), rewards: tx.listRewards(tripId),
        inventory: tx.listInventory(), unlocks: tx.listCgUnlocks(petId),
        facts: tx.listTripFacts(tripId), trips: tx.listTrips(),
      }));
      if (repeat === 0) {
        final = snapshot;
        ledger = stored;
        expect(stored.settlement.rewards).toEqual(expected.rewardDraft);
        expect(stored.facts).toEqual(expected.facts);
        expect(snapshot.walletCoins).toBe(expected.rewardDraft.coins);
        expect(snapshot.pets.find((value) => value.petId === petId)).toMatchObject({
          presence: 'HOME', xp: expected.rewardDraft.xp, trip: { tripId, status: 'SETTLED' },
        });
        expect(stored.inventory).toEqual(expected.rewardDraft.items);
        expect(stored.unlocks.map((unlock) => unlock.cgId)).toEqual(expected.rewardDraft.cgIds);
        expect(stored.trips).toHaveLength(1);
      } else {
        expect(snapshot).toEqual(final);
        expect(stored).toEqual(ledger);
      }
      instance.close();
    }
  });

  it('does not issue any partial reward if an atomic settlement fails, then recovers', () => {
    const f = fixture();
    let failSettlement = false;
    const instance = f.open((repo) => ({
      close: () => repo.close(),
      transaction: (action) => repo.transaction((tx) => action(new Proxy(tx, {
        get(target, key) {
          if (key === 'appendOutbox' && failSettlement) return (event) => {
            if (event.type === 'TripSettled') throw new Error('injected failure');
            return target.appendOutbox(event);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    const petId = instance.service.getSnapshot().primaryPetId;
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets.find((pet) => pet.petId === petId).trip.tripId;
    const beforeOutbox = instance.repo.transaction((tx) => tx.listOutbox(0, 100));
    failSettlement = true;
    f.advance(initialTime + minutes(60));
    const failed = instance.service.handleRequest({ schemaVersion: 1, requestId: 'failing-get', method: 'snapshot/get', payload: {} });
    expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', requestId: 'failing-get' } });
    expect(JSON.stringify(failed)).not.toContain('injected failure');
    const rolledBack = instance.repo.transaction((tx) => ({
      settlement: tx.getSettlement(tripId), rewards: tx.listRewards(tripId),
      coins: tx.getWalletCoins(), pet: tx.getPet(petId), trip: tx.getTrip(tripId),
      items: tx.listInventory(), cg: tx.listCgUnlocks(petId), facts: tx.listTripFacts(tripId),
      outbox: tx.listOutbox(0, 100),
    }));
    expect(rolledBack.settlement).toBeNull();
    expect(rolledBack.rewards).toEqual([]);
    expect(rolledBack.coins).toBe(0);
    expect(rolledBack.items).toEqual([]);
    expect(rolledBack.cg).toEqual([]);
    expect(rolledBack.facts).toEqual([]);
    expect(rolledBack.outbox).toEqual(beforeOutbox);
    expect(rolledBack.pet.xp).toBe(0);
    expect(rolledBack.pet.presence).toBe('AWAY');
    expect(rolledBack.trip.status).toBe('TRAVELING');
    failSettlement = false;
    const recovered = instance.service.getSnapshot();
    expect(recovered.pets.find((pet) => pet.petId === petId).presence).toBe('HOME');
    expect(instance.repo.transaction((tx) => tx.getSettlement(tripId))).not.toBeNull();
    instance.close();
  });

  it('keeps both pets independent and settles only the nodes reached before recall', () => {
    const f = fixture();
    const instance = f.open();
    const initial = instance.service.getSnapshot();
    const [first, second] = initial.pets;
    expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: first.petId, routeId: DEMO_ROUTE.routeId })));
    f.advance(initialTime + minutes(1));
    expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: second.petId, routeId: DEMO_ROUTE.routeId })));
    const firstTrip = instance.service.getSnapshot().pets.find((pet) => pet.petId === first.petId).trip.tripId;
    f.advance(initialTime + minutes(2));
    const recalled = expectSuccess(f.request(instance.service, f.command('TRIP_RECALL', { petId: first.petId, tripId: firstTrip })));
    expect(recalled.pets.find((pet) => pet.petId === first.petId).presence).toBe('RETURNING');
    expect(recalled.pets.find((pet) => pet.petId === second.petId).presence).toBe('AWAY');
    f.advance(initialTime + minutes(6));
    const mid = instance.service.getSnapshot();
    expect(mid.pets.find((pet) => pet.petId === first.petId)).toMatchObject({ presence: 'HOME', xp: 0 });
    expect(mid.pets.find((pet) => pet.petId === second.petId).presence).toBe('AWAY');
    const firstSettlement = instance.repo.transaction((tx) => tx.getSettlement(firstTrip));
    expect(firstSettlement.rewards).toEqual({ xp: 0, coins: 0, items: [], cgIds: [] });
    f.advance(initialTime + minutes(30));
    expect(instance.service.getSnapshot().pets.every((pet) => pet.presence === 'HOME')).toBe(true);
    expect(instance.repo.transaction((tx) => tx.listTrips().every((trip) => trip.status === 'SETTLED'))).toBe(true);
    instance.close();
  });

  it('refuses a structurally valid but non-replayable persisted reward draft', () => {
    const f = fixture();
    const instance = f.open();
    const petId = instance.service.getSnapshot().primaryPetId;
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets.find((pet) => pet.petId === petId).trip.tripId;
    f.advance(initialTime + minutes(4));
    instance.service.getSnapshot();
    const original = instance.repo.transaction((tx) => tx.getTrip(tripId));
    expect(original.checkpoint.nodeIndex).toBe(1);
    // Deliberately corrupt a test fixture through the repository boundary; a
    // renderer has no equivalent API. The value is structurally legal but not
    // the deterministic result of the frozen route and persisted facts.
    instance.repo.transaction((tx) => tx.updateTrip({
      ...original,
      checkpoint: { ...original.checkpoint, rewardDraft: { ...original.checkpoint.rewardDraft, xp: original.checkpoint.rewardDraft.xp + 1 } },
    }));
    f.advance(initialTime + minutes(40));
    const result = instance.service.handleRequest({ schemaVersion: 1, requestId: 'corrupt-draft', method: 'snapshot/get', payload: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    const state = instance.repo.transaction((tx) => ({
      settlement: tx.getSettlement(tripId), wallet: tx.getWalletCoins(), pet: tx.getPet(petId), rewards: tx.listRewards(tripId),
    }));
    expect(state.settlement).toBeNull();
    expect(state.wallet).toBe(0);
    expect(state.pet.xp).toBe(0);
    expect(state.rewards).toEqual([]);
    instance.close();
  });

  it('refuses restart on a tampered settled ledger without changing the existing save', () => {
    const f = fixture();
    const instance = f.open();
    const petId = instance.service.getSnapshot().primaryPetId;
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets.find((pet) => pet.petId === petId).trip.tripId;
    f.advance(initialTime + minutes(40));
    const final = instance.service.getSnapshot();
    instance.close();
    // Independent corruption of the synthetic test file, never a user save.
    const db = new DatabaseSync(f.dbPath);
    expect(Number(db.prepare("UPDATE reward_ledger SET amount=amount+1 WHERE source_id=? AND kind='XP'").run(tripId).changes)).toBe(1);
    db.close();
    expect(() => f.open()).toThrow();
    // The failed initialization transaction did not issue new rewards.
    const verify = new DatabaseSync(f.dbPath);
    try {
      expect(verify.prepare('SELECT balance FROM wallet WHERE currency=?').get('coin').balance).toBe(final.walletCoins);
      expect(verify.prepare('SELECT xp FROM pet_progression WHERE pet_id=?').get(petId).xp)
        .toBe(final.pets.find((pet) => pet.petId === petId).xp);
    } finally { verify.close(); }
  });

  it('does not seed new pets over an uninitialized file containing a command history', () => {
    const f = fixture();
    const repo = new SQLiteRepository(new DatabaseSync(f.dbPath), { persistent: true });
    openRepositories.add(repo);
    repo.transaction((tx) => tx.saveCommandReceipt({
      commandId: 'old-command',
      fingerprint: JSON.stringify({ commandId: 'old-command', issuedAt: initialTime, payload: { petId: 'missing-pet' }, type: 'PET_SELECT' }),
      outcome: { ok: false, error: { code: 'NOT_FOUND', message: 'Missing pet', retryable: false } },
      createdAt: initialTime,
    }));
    const runtime = { now: () => initialTime, seed: () => 8, createId: (kind) => `${kind}-unused` };
    expect(() => new AppService(repo, runtime)).toThrow();
    expect(repo.transaction((tx) => tx.listPets())).toEqual([]);
  });

  it('reports a broken repository as requiring a restart instead of a retryable operation', () => {
    const f = fixture();
    let broken = false;
    const instance = f.open((repo) => ({
      close: () => repo.close(),
      transaction: (action) => {
        if (broken) throw Object.assign(new Error('internal fixture details'), { name: 'RepositoryUnavailableError' });
        return repo.transaction(action);
      },
    }));
    broken = true;
    const result = instance.service.handleRequest({ schemaVersion: 1, requestId: 'closed-writer', method: 'snapshot/get', payload: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', retryable: false, requestId: 'closed-writer' } });
    expect(JSON.stringify(result)).not.toContain('fixture details');
    instance.close();
  });

  it('persists departure CG pins, exact first unlock, view/favorite, and no duplicate reward after restart', () => {
    const f = fixture();
    let instance = f.open();
    const petId = 'pet-1';
    const keys = { petId, cgId: 'morning-dew', variant: 'default' };
    const locked = readGallery(instance.service, { petId });
    expect(locked.gallery.rows[0]).toMatchObject({ unlockStatus: 'LOCKED' });
    expect(locked.gallery.rows[0]).not.toHaveProperty('assetRef');
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets.find((pet) => pet.petId === petId).trip.tripId;
    const pin = instance.repo.transaction((tx) => tx.listTripCgAssetPins(tripId))[0];
    const entry = findBuiltinCg('star-singer', 'morning-dew');
    expect(pin).toMatchObject({ ...keys, characterId: 'star-singer', eventDefId: 'dew-postcard', tripId,
      assetRef: { state: 'PINNED', assetVersion: entry.assetVersion, assetHash: entry.assetHash } });
    instance.close();

    f.advance(initialTime + minutes(15));
    instance = f.open();
    expect(instance.repo.transaction((tx) => tx.listTripCgAssetPins(tripId))).toEqual([pin]);
    const settled = readGallery(instance.service, { petId, filter: 'UNLOCKED' });
    expect(settled.gallery.rows[0]).toMatchObject({ unlockStatus: 'UNLOCKED', assetRef: pin.assetRef, sourceTripId: tripId,
      unlockedAt: initialTime + minutes(15), favorite: false, viewedAt: null });
    const ledger = instance.repo.transaction((tx) => tx.listRewards(tripId));
    f.advance(initialTime + minutes(16));
    const { characterId, eventDefId, assetVersion, assetHash } = pin.assetRef;
    const viewCommand = f.command('CG_MARK_VIEWED', { ...keys, characterId, eventDefId, assetVersion, assetHash }, 'view-cg-once');
    const viewed = expectSuccess(f.request(instance.service, viewCommand));
    const favoriteCommand = f.command('CG_SET_FAVORITE', { ...keys, favorite: true }, 'favorite-cg-once');
    const favorited = expectSuccess(f.request(instance.service, favoriteCommand));
    expect(viewed.revision).toBe(settled.snapshot.revision + 1);
    expect(favorited.revision).toBe(viewed.revision + 1);
    expect(favorited).toEqual({ ...settled.snapshot, revision: favorited.revision });
    instance.close();

    f.advance(initialTime + minutes(17));
    instance = f.open();
    const afterRestart = readGallery(instance.service, { petId, filter: 'FAVORITES' });
    expect(afterRestart.gallery.rows[0]).toMatchObject({ favorite: true, viewedAt: initialTime + minutes(16), assetRef: pin.assetRef });
    expect(expectSuccess(f.request(instance.service, viewCommand))).toEqual(viewed);
    expect(expectSuccess(f.request(instance.service, favoriteCommand))).toEqual(favorited);
    expect(instance.repo.transaction((tx) => tx.listRewards(tripId))).toEqual(ledger);
    const second = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const secondTripId = second.pets.find((pet) => pet.petId === petId).trip.tripId;
    f.advance(initialTime + minutes(32));
    const collectedAgain = readGallery(instance.service, { petId });
    expect(collectedAgain.gallery.rows).toHaveLength(1);
    expect(collectedAgain.gallery.rows[0]).toEqual(afterRestart.gallery.rows[0]);
    expect(instance.repo.transaction((tx) => tx.listRewards(secondTripId).filter((line) => line.kind === 'CG'))).toHaveLength(1);
    expect(instance.repo.transaction((tx) => tx.listOutbox(0, 100).filter((event) => event.event.type === 'CGUnlocked'))).toHaveLength(1);
    instance.close();
  });

  it('settles a real v1 in-flight trip through migration without inventing the missing historical asset', () => {
    const f = fixture();
    const petId = 'pet-1';
    const tripId = 'legacy-trip';
    const snapshot = createTripSnapshot({ tripId, petId, startAt: initialTime, seed: 8, power: 30, route: DEMO_ROUTE });
    const checkpoint = createTripCheckpoint(snapshot);
    const db = new DatabaseSync(f.dbPath);
    try {
      // A synthetic historical database, independently constructed from the
      // immutable migration 001 rather than downgrading a newer user save.
      db.exec(MIGRATION_001);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, 'fnv1a32:9d3ced6f', initialTime);
      db.exec('PRAGMA user_version = 1');
      db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run(petId, 'star-singer', '星咏', 1);
      db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(petId, 'AWAY', null, 'CALM', 'NORMAL', 'VISIBLE', 500, 1000, 850, 0);
      db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run(petId, 30, 0);
      db.prepare('INSERT INTO preferences VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, initialTime, petId, 0, 0);
      db.prepare(`INSERT INTO trips (trip_id, pet_id, route_id, status, seed, snapshot_json, checkpoint_json, json_schema_version,
        start_at, expected_return_at, actual_returned_at, next_due_at, rules_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tripId, petId, snapshot.routeId, 'TRAVELING', snapshot.seed, JSON.stringify(snapshot), JSON.stringify(checkpoint),
          1, snapshot.startAt, snapshot.expectedReturnAt, null, checkpoint.nextDueAt, snapshot.rulesVersion);
    } finally { db.close(); }
    let backupInvoked = false;
    const beforeMigration = (source, from) => {
      verifyMigrationBackup(source, `${f.dbPath}.v1-test-backup`, from, (filename) => new DatabaseSync(filename, { readOnly: true }));
      backupInvoked = true;
    };
    f.advance(initialTime + minutes(15));
    let instance = f.open((repo) => repo, { beforeMigration });
    expect(backupInvoked).toBe(true);
    expect(instance.repo.transaction((tx) => tx.listTripCgAssetPins(tripId))).toEqual([]);
    const settled = readGallery(instance.service, { petId });
    expect(settled.snapshot.walletCoins).toBe(8);
    expect(settled.gallery.rows).toHaveLength(1);
    expect(settled.gallery.rows[0]).toMatchObject({ petId, cgId: 'morning-dew', variant: 'default', title: '历史纪念画面',
      sourceTripId: tripId, unlockStatus: 'UNLOCKED', assetRef: { state: 'LEGACY_UNVERSIONED' }, viewedAt: null });
    const keys = { petId, cgId: 'morning-dew', variant: 'default' };
    expectSuccess(f.request(instance.service, f.command('CG_SET_FAVORITE', { ...keys, favorite: true })));
    const entry = findBuiltinCg('star-singer', 'morning-dew');
    expect(f.request(instance.service, f.command('CG_MARK_VIEWED', { ...keys, characterId: entry.characterId,
      eventDefId: entry.eventDefId, assetVersion: entry.assetVersion, assetHash: entry.assetHash })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    instance.close();
    instance = f.open();
    expect(readGallery(instance.service, { petId, filter: 'FAVORITES' }).gallery.rows[0]).toMatchObject({ favorite: true,
      assetRef: { state: 'LEGACY_UNVERSIONED' }, viewedAt: null });
    instance.close();
  });
});
