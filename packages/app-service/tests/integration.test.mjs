import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTravelIpcResultSchema, resultMatchesMethod } from '@pet-desktop/contracts';
import { AppService } from '../src/app-service.ts';
import { verifyMigrationBackup } from '../src/migration-backup.ts';
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, SQLiteRepository, SCHEMA_VERSION } from '../src/sqlite-repository.ts';
import { advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE } from '@pet-desktop/domain';
import { findBuiltinCg } from '@pet-desktop/domain/cg-catalog';
import { CHARACTER_CATALOG_VERSION } from '@pet-desktop/domain/character-catalog';
import { HOME_RULES, advanceHomeState } from '@pet-desktop/domain/home-simulation';
import { ITEM_CATALOG_VERSION } from '@pet-desktop/domain/item-catalog';
import { ROUTE_CATALOG_VERSION } from '@pet-desktop/domain/route-catalog';
import { cumulativeXpAtLevel } from '@pet-desktop/domain/progression';
import { EVENT_CATALOG } from '@pet-desktop/domain/event-catalog';
import { selectEvent } from '@pet-desktop/domain/event-engine';
import { eventSeed } from '../src/event-service.ts';

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

function fixture(eventPolicy = false) {
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
    const service = eventPolicy === true ? new AppService(wrap(repo), runtime) : new AppService(wrap(repo), runtime, eventPolicy);
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

function readEvents(service, query = {}) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'event-query', method: 'events/list',
    payload: { filter: 'ALL', offset: 0, limit: 30, ...query } });
  expect(result.ok).toBe(true);
  expect(result.events.revision).toBe(result.snapshot.revision);
  return result;
}

const allEventChances = Object.freeze({ HOME_DAILY: 10000, AFTER_INTERACTION: 10000, TRIP_RETURNED: 10000, BOND_MILESTONE: 10000 });
const DAY = 86_400_000;
const triggerKey = (kind, petId, source) => JSON.stringify([kind, petId, source]);

describe.skipIf(!supported)('active travel map over real SQLite', () => {
  it('shows only frozen nodes and committed facts through advance, recall and restart', () => {
    const f = fixture();
    let instance = f.open();
    const readMap = () => {
      const value = instance.service.handleRequest({ schemaVersion: 1, requestId: 'active-query', method: 'travel/active', payload: {} });
      const result = activeTravelIpcResultSchema.parse(value);
      expect(result.ok).toBe(true);
      expect(resultMatchesMethod('snapshot/get', result)).toBe(false);
      return result;
    };
    expect(readMap().activeTravel.rows).toEqual([]);
    const petId = 'pet-1';
    const departed = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = departed.pets.find(pet => pet.petId === petId).trip.tripId;
    const initial = readMap().activeTravel.rows[0];
    expect(initial).toMatchObject({ tripId, petId, phase: 'OUTBOUND', nodeIndex: 0, facts: [] });
    expect(initial.nodes).toEqual(DEMO_ROUTE.nodes);
    expect(initial).not.toHaveProperty('seed');
    f.advance(initial.nextDueAt);
    const progressed = readMap();
    expect(progressed.activeTravel.rows[0]).toMatchObject({ nodeIndex: 1, facts: [expect.objectContaining({ tripId, sequence: 1 })] });
    expect(activeTravelIpcResultSchema.safeParse({ ...progressed, activeTravel: { ...progressed.activeTravel, rows: [] } }).success).toBe(false);
    expectSuccess(f.request(instance.service, f.command('TRIP_RECALL', { petId, tripId })));
    const returning = readMap();
    expect(returning.activeTravel.rows[0]).toMatchObject({ phase: 'RETURNING', returnReason: 'RECALLED', nodeIndex: 1 });
    instance.close();
    instance = f.open();
    expect(readMap()).toEqual(returning);
    f.advance(returning.activeTravel.rows[0].nextDueAt);
    expect(readMap().activeTravel.rows).toEqual([]);
  });
});

describe.skipIf(!supported)('narrative events + real SQLite authority', () => {
  it('uses the production policy, persists chance/no-event, hides effects, and commits a chosen branch once across restart', () => {
    const f = fixture(true);
    let instance = f.open();
    const first = readEvents(instance.service);
    expect(first.events.pendingTotal).toBe(1); // stable default policy seed for initialTime
    const pending = first.events.rows[0];
    expect(pending).toMatchObject({ eventId: 'star-singer.starlight-notes', status: 'PENDING', occurredAt: initialTime,
      deadlineAt: initialTime + DAY, rewards: [], artState: 'NONE' });
    expect(pending).not.toHaveProperty('effects');
    expect(pending.choices[0]).not.toHaveProperty('effects');
    const day = Math.floor(initialTime / DAY);
    const receipts = instance.repo.transaction(tx => [tx.getEventTriggerReceipt(triggerKey('HOME_DAILY', 'pet-1', day)),
      tx.getEventTriggerReceipt(triggerKey('HOME_DAILY', 'pet-2', day))]);
    expect(receipts[0]).toMatchObject({ kind: 'OCCURRENCE', occurrenceId: pending.occurrenceId, drawCount: 2 });
    expect(receipts[1]).toMatchObject({ kind: 'NO_EVENT', reason: 'NO_ELIGIBLE', drawCount: 0 });
    expect(readEvents(instance.service)).toEqual(first);
    const choice = { petId: 'pet-1', occurrenceId: pending.occurrenceId, choiceId: 'study-herbs' };
    expect(f.request(instance.service, f.command('EVENT_CHOOSE', { ...choice, petId: 'pet-2' }, 'wrong-owner', first.snapshot.revision)))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const command = f.command('EVENT_CHOOSE', choice, 'daily-branch', first.snapshot.revision);
    const chosen = expectSuccess(f.request(instance.service, command));
    expect(chosen.revision).toBe(first.snapshot.revision + 1);
    expect(chosen.pets[0].bond).toBe(0.5);
    const resolved = readEvents(instance.service, { filter: 'HISTORY' }).events.rows[0];
    expect(resolved).toMatchObject({ status: 'RESOLVED', selectedChoiceId: 'study-herbs', resolvedAt: initialTime,
      rewards: expect.arrayContaining([{ kind: 'MOOD_DELTA', delta10: 10 }, { kind: 'BOND_DELTA', delta10: 5 }, { kind: 'ITEM', itemId: 'herb', quantity: 1 }]) });
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'herb').quantity)).toBe(1);
    instance.close(); instance = f.open();
    expect(expectSuccess(f.request(instance.service, command))).toEqual(chosen);
    const current = readEvents(instance.service);
    expect(current.events.rows).toEqual([resolved]);
    expect(f.request(instance.service, f.command('EVENT_CHOOSE', choice, 'duplicate-choice', current.snapshot.revision)))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'herb').quantity)).toBe(1);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('HOME_DAILY','pet-1', day)))).toEqual(receipts[0]);
    f.advance(initialTime + DAY * 5);
    const later = readEvents(instance.service);
    expect(later.events.total).toBeLessThanOrEqual(2);
    for (let offset = 1; offset < 5; offset++) expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('HOME_DAILY', 'pet-1', day + offset)))).toBeNull();
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('HOME_DAILY','pet-1', day + 5)))).not.toBeNull();
  });

  it('only a rewarded pet interaction triggers an independent event; cooldown clicks and receipt retries do not reroll', () => {
    const f = fixture(allEventChances); const instance = f.open();
    readEvents(instance.service);
    const click = f.command('PET_INTERACT', { petId: 'pet-2', interaction: 'PET' }, 'fluffy-touch');
    const touched = expectSuccess(f.request(instance.service, click));
    const first = readEvents(instance.service, { petId: 'pet-2' });
    expect(first.events.rows).toHaveLength(1);
    expect(first.events.rows[0]).toMatchObject({ eventId: 'fluffy-ranger.forest-tea', trigger: 'AFTER_INTERACTION' });
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('AFTER_INTERACTION','pet-2','fluffy-touch')))).toMatchObject({ kind: 'OCCURRENCE' });
    expect(expectSuccess(f.request(instance.service, click))).toEqual(touched);
    expectSuccess(f.request(instance.service, f.command('PET_INTERACT', { petId: 'pet-2', interaction: 'PET' }, 'cooldown-touch')));
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('AFTER_INTERACTION','pet-2','cooldown-touch')))).toBeNull();
    expect(readEvents(instance.service, { petId: 'pet-2' }).events.rows).toEqual(first.events.rows);
    expect(readEvents(instance.service, { petId: 'pet-2', offset: 1, limit: 1 }).events.rows).toEqual([]);
  });

  it('resolves a milestone created by an actual event bond gain, with an exact pinned event CG and unified favorite/view', () => {
    const f = fixture(allEventChances); let instance = f.open();
    // Existing legitimate progression just below the milestone (no historic
    // event trigger is synthesized from this pre-v7 state).
    instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), xp: 100, bond10: 190 }));
    const notes = readEvents(instance.service, { petId: 'pet-1' });
    expect(notes.events.rows).toHaveLength(1);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('BOND_MILESTONE','pet-1',200)))).toBeNull();
    expectSuccess(f.request(instance.service, f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId: notes.events.rows[0].occurrenceId,
      choiceId: 'share-notes' }, 'real-crossing', notes.snapshot.revision)));
    const milestone = readEvents(instance.service, { petId: 'pet-1', filter: 'PENDING' });
    const star = milestone.events.rows[0];
    expect(star).toMatchObject({ eventId: 'star-singer.shared-constellation', eventVersion: 2, artState: 'LOCKED' });
    expect(readGallery(instance.service, { petId: 'pet-1', eventDefId: star.eventId }).gallery.rows[0]).not.toHaveProperty('assetRef');
    const choose = f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId: star.occurrenceId, choiceId: 'keep-the-memory' }, 'constellation-choice', milestone.snapshot.revision);
    expectSuccess(f.request(instance.service, choose));
    expect(readEvents(instance.service, { filter: 'HISTORY', petId: 'pet-1' }).events.rows.find(row => row.occurrenceId === star.occurrenceId))
      .toMatchObject({ artState: 'UNLOCKED', rewards: expect.arrayContaining([{ kind: 'CG_UNLOCK', cgId: star.eventId, variant: 'default', newlyUnlocked: true }]) });
    const gallery = readGallery(instance.service, { petId: 'pet-1', filter: 'UNLOCKED' }).gallery.rows;
    expect(gallery).toHaveLength(1);
    const cg = gallery[0];
    expect(cg).toMatchObject({ sourceTripId: null, sourceEventId: star.occurrenceId, assetRef: { state: 'PINNED', assetVersion: '1.0.0' } });
    const ids = { petId: 'pet-1', cgId: cg.cgId, variant: cg.variant };
    expectSuccess(f.request(instance.service, f.command('CG_SET_FAVORITE', { ...ids, favorite: true })));
    const { state: _, ...ref } = cg.assetRef;
    expectSuccess(f.request(instance.service, f.command('CG_MARK_VIEWED', { ...ids, ...ref })));
    instance.close(); instance = f.open();
    expect(readGallery(instance.service, { filter: 'FAVORITES' }).gallery.rows[0]).toMatchObject({ sourceEventId: star.occurrenceId,
      favorite: true, viewedAt: initialTime, assetRef: cg.assetRef });
    expect(instance.repo.transaction(tx => tx.listCgUnlocks('pet-1'))).toEqual([]);
    expect(instance.repo.transaction(tx => tx.listEventCgUnlocks('pet-1'))).toHaveLength(1);
  });

  it('expires an event at its frozen deadline while offsite, then settles travel in due order without modifying its ledger', () => {
    const f = fixture(allEventChances); let instance = f.open();
    const notes = readEvents(instance.service, { petId: 'pet-1' }).events.rows[0];
    const departs = notes.deadlineAt - minutes(5);
    f.advance(departs);
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets[0].trip.tripId;
    const frozen = instance.repo.transaction(tx => tx.getTrip(tripId).snapshot);
    f.advance(notes.deadlineAt);
    const expired = readEvents(instance.service, { petId: 'pet-1', filter: 'HISTORY' });
    expect(expired.events.rows[0]).toMatchObject({ status: 'EXPIRED', selectedChoiceId: 'share-notes', resolvedAt: notes.deadlineAt });
    expect(expired.snapshot.pets[0]).toMatchObject({ presence: 'AWAY', energy: started.pets[0].energy, bond: 1.5, xp: 0 });
    expect(instance.repo.transaction(tx => tx.getTrip(tripId).snapshot)).toEqual(frozen);
    f.advance(departs + minutes(15));
    const settled = readEvents(instance.service);
    expect(settled.snapshot.pets[0].presence).toBe('HOME');
    const ledger = instance.repo.transaction(tx => tx.listRewards(tripId));
    expect(ledger.every(row => row.sourceType === 'TRIP')).toBe(true);
    const outbox = instance.repo.transaction(tx => tx.listOutbox(0, 100)).map(row => row.event);
    expect(outbox.findIndex(row => row.type === 'EventFinalized')).toBeLessThan(outbox.findIndex(row => row.type === 'TripSettled'));
    instance.close(); instance = f.open();
    expect(instance.repo.transaction(tx => tx.listRewards(tripId))).toEqual(ledger);
    expect(readEvents(instance.service, { filter: 'HISTORY', petId: 'pet-1' }).events.rows[0].resolvedAt).toBe(notes.deadlineAt);
  });

  it('creates a homecoming from actual return time and expires it during offline catch-up with separate CG acquisition', () => {
    const f = fixture(allEventChances); let instance = f.open();
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-2', routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets[1].trip.tripId;
    f.advance(initialTime + 2 * DAY);
    const report = readEvents(instance.service, { petId: 'pet-2', filter: 'HISTORY' });
    const trip = instance.repo.transaction(tx => tx.getTrip(tripId));
    const actual = trip.checkpoint.actualReturnedAt;
    expect(report.events.rows).toHaveLength(1);
    const event = report.events.rows[0];
    expect(event).toMatchObject({ eventId: 'fluffy-ranger.meadow-homecoming', trigger: 'TRIP_RETURNED', sourceTripId: tripId,
      occurredAt: actual, deadlineAt: actual + DAY, resolvedAt: actual + DAY, status: 'EXPIRED', artState: 'UNLOCKED' });
    expect(report.snapshot.pets[1].presence).toBe('HOME');
    const cg = readGallery(instance.service, { petId: 'pet-2', eventDefId: event.eventId }).gallery.rows[0];
    expect(cg).toMatchObject({ sourceTripId: null, sourceEventId: event.occurrenceId, unlockedAt: actual + DAY });
    const ledger = instance.repo.transaction(tx => tx.listRewards(tripId));
    expect(ledger.every(row => row.sourceType === 'TRIP' && row.sourceId === tripId)).toBe(true);
    instance.close(); instance = f.open();
    expect(readEvents(instance.service, { petId: 'pet-2', filter: 'HISTORY' }).events.rows).toEqual([event]);
    expect(instance.repo.transaction(tx => tx.listRewards(tripId))).toEqual(ledger);
  });

  it('rolls back effects, finalization and receipt when an outbox append fails; the same choice can then be retried', () => {
    const f = fixture(allEventChances); let fail = false;
    const instance = f.open(repo => ({ transaction: action => repo.transaction(tx => action(new Proxy(tx, {
      get(target, key) { const value = target[key];
        if (key === 'appendOutbox') return event => { if (fail && event.type === 'EventFinalized') throw new Error('injected failure'); return value.call(target, event); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }))), close: () => repo.close() }));
    const first = readEvents(instance.service, { petId: 'pet-1' });
    const occurrenceId = first.events.rows[0].occurrenceId;
    const command = f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId, choiceId: 'study-herbs' }, 'failed-choice', first.snapshot.revision);
    fail = true;
    expect(f.request(instance.service, command)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(instance.repo.transaction(tx => tx.getEventOccurrence(occurrenceId))).toMatchObject({ status: 'PENDING', rewards: [] });
    expect(instance.repo.transaction(tx => tx.getCommandReceipt(command.commandId))).toBeNull();
    expect(instance.repo.transaction(tx => tx.listInventory())).toEqual([]);
    fail = false;
    expectSuccess(f.request(instance.service, command));
    expect(instance.repo.transaction(tx => tx.listInventory())).toEqual([{ itemId: 'herb', quantity: 1 }]);
  });

  it('records an eligible chance miss and never draws again on repeat polling or reopen', () => {
    const f = fixture({ ...allEventChances, HOME_DAILY: 0 }); let instance = f.open();
    const initial = readEvents(instance.service);
    expect(initial.events.total).toBe(0);
    const key = triggerKey('HOME_DAILY', 'pet-1', Math.floor(initialTime / DAY));
    const miss = instance.repo.transaction(tx => tx.getEventTriggerReceipt(key));
    expect(miss).toMatchObject({ kind: 'NO_EVENT', reason: 'CHANCE_MISS', drawCount: 1, seed: eventSeed(key) });
    instance.close(); instance = f.open();
    expect(readEvents(instance.service)).toEqual(initial);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(key))).toEqual(miss);
  });

  it('records a cap-denied trigger durably per pet even after one old occurrence is finalized', () => {
    const f = fixture(allEventChances); const instance = f.open();
    // Load three independently frozen, pending historical selections. This is
    // a storage fixture for future catalogs with more simultaneous branches,
    // not a UI ability to create occurrences or bypass current cooldowns.
    instance.repo.transaction(tx => {
      for (let i = 0; i < 3; i++) {
        const key = triggerKey('AFTER_INTERACTION', 'pet-2', `historical-${i}`);
        const result = selectEvent(EVENT_CATALOG, { trigger: 'AFTER_INTERACTION', triggerKey: key, occurrenceId: `historical-event-${i}`,
          seed: eventSeed(key), at: initialTime, chanceBps: 10000, history: [],
          context: { petId: 'pet-2', characterId: 'fluffy-ranger', presence: 'HOME', level: 1, bond10: 0 } });
        if (result.kind !== 'OCCURRENCE') throw new Error('Cannot construct frozen history fixture');
        tx.insertEventTriggerReceipt({ triggerKey: key, petId: 'pet-2', trigger: 'AFTER_INTERACTION', seed: result.seed, at: initialTime,
          rngState: result.rngState, drawCount: result.drawCount, sourceTripId: null, routeId: null, kind: 'OCCURRENCE', occurrenceId: result.occurrence.occurrenceId });
        tx.insertEventOccurrence(result.occurrence);
      }
    });
    const before = readEvents(instance.service);
    expect(before.events.pendingTotal).toBe(4); // cap per pet, star can still create her daily event
    const touch = f.command('PET_INTERACT', { petId: 'pet-2', interaction: 'PET' }, 'cap-touch');
    const hitCap = expectSuccess(f.request(instance.service, touch));
    const key = triggerKey('AFTER_INTERACTION', 'pet-2', 'cap-touch');
    const receipt = instance.repo.transaction(tx => tx.getEventTriggerReceipt(key));
    expect(receipt).toMatchObject({ kind: 'NO_EVENT', reason: 'TRIGGER_INELIGIBLE', drawCount: 0 });
    expectSuccess(f.request(instance.service, f.command('EVENT_CHOOSE', { petId: 'pet-2', occurrenceId: 'historical-event-0',
      choiceId: 'prepare-trail' }, 'free-capacity', hitCap.revision)));
    expect(expectSuccess(f.request(instance.service, touch))).toEqual(hitCap);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(key))).toEqual(receipt);
    expect(readEvents(instance.service, { petId: 'pet-2', filter: 'PENDING' }).events.total).toBe(2);
  });

  it('consumes a gift and creates one milestone within the exact immutable commerce receipt revision', () => {
    const f = fixture(allEventChances); const instance = f.open();
    const notes = readEvents(instance.service, { petId: 'pet-1' });
    expectSuccess(f.request(instance.service, f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId: notes.events.rows[0].occurrenceId,
      choiceId: 'share-notes' }, 'gift-prerequisite', notes.snapshot.revision)));
    instance.repo.transaction(tx => { tx.savePet({ ...tx.getPet('pet-1'), xp: 100, bond10: 190 }); tx.addInventory('flower-bouquet', 2); });
    const before = instance.service.getSnapshot();
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('BOND_MILESTONE', 'pet-1', 200)))).toBeNull();
    const gift = f.command('ITEM_USE', { petId: 'pet-1', itemId: 'flower-bouquet', catalogVersion: ITEM_CATALOG_VERSION }, 'gift-crossing', before.revision);
    const result = expectSuccess(f.request(instance.service, gift));
    expect(result.revision).toBe(before.revision + 1);
    expect(result.pets[0].bond).toBe(21);
    expect(readEvents(instance.service, { petId: 'pet-1', filter: 'PENDING' }).events.rows[0]).toMatchObject({ eventId: 'star-singer.shared-constellation' });
    expect(expectSuccess(f.request(instance.service, gift))).toEqual(result);
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'flower-bouquet').quantity)).toBe(1);
    expect(instance.repo.transaction(tx => tx.getCommerceOperation('gift-crossing'))).toMatchObject({ type: 'ITEM_USE', itemId: 'flower-bouquet' });
  });

  it('consumes a crossed milestone without prerequisites and only considers a later genuinely crossed threshold', () => {
    const f = fixture(allEventChances); const instance = f.open();
    instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), xp: 100, bond10: 195 }));
    const notes = readEvents(instance.service, { petId: 'pet-1' });
    const threshold200 = triggerKey('BOND_MILESTONE', 'pet-1', 200);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(threshold200))).toBeNull();
    const first = expectSuccess(f.request(instance.service, f.command('PET_INTERACT', { petId: 'pet-1', interaction: 'PET' }, 'early-bond-cross')));
    const denied = instance.repo.transaction(tx => tx.getEventTriggerReceipt(threshold200));
    expect(denied).toMatchObject({ kind: 'NO_EVENT', reason: 'NO_ELIGIBLE', drawCount: 0 });
    expectSuccess(f.request(instance.service, f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId: notes.events.rows[0].occurrenceId,
      choiceId: 'share-notes' }, 'prerequisite-later', first.revision)));
    expect(readEvents(instance.service, { petId: 'pet-1', filter: 'PENDING' }).events.total).toBe(0);
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(threshold200))).toEqual(denied);
    instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), bond10: 495 }));
    f.advance(initialTime + HOME_RULES.petCooldownMs);
    expectSuccess(f.request(instance.service, f.command('PET_INTERACT', { petId: 'pet-1', interaction: 'PET' }, 'later-bond-cross')));
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('BOND_MILESTONE', 'pet-1', 500)))).toMatchObject({ kind: 'OCCURRENCE' });
    expect(readEvents(instance.service, { petId: 'pet-1', filter: 'PENDING' }).events.rows[0]).toMatchObject({ eventId: 'star-singer.shared-constellation' });
    expect(instance.repo.transaction(tx => tx.getEventTriggerReceipt(triggerKey('BOND_MILESTONE', 'pet-1', 800)))).toBeNull();
  });

  it('allows a pending choice while away, clamps saturation, and never mutates the frozen trip', () => {
    const f = fixture(allEventChances); const instance = f.open();
    const notes = readEvents(instance.service, { petId: 'pet-1' }).events.rows[0];
    instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), moodScore10: 995, bond10: 995 }));
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets[0].trip.tripId;
    const frozen = instance.repo.transaction(tx => tx.getTrip(tripId));
    const result = expectSuccess(f.request(instance.service, f.command('EVENT_CHOOSE', { petId: 'pet-1', occurrenceId: notes.occurrenceId,
      choiceId: 'share-notes' }, 'offsite-choice', started.revision)));
    expect(result.pets[0]).toMatchObject({ presence: 'AWAY', energy: started.pets[0].energy, bond: 100, moodScore: 100, xp: 0 });
    expect(readEvents(instance.service, { petId: 'pet-1', filter: 'HISTORY' }).events.rows[0].rewards)
      .toEqual(expect.arrayContaining([{ kind: 'MOOD_DELTA', delta10: 5 }, { kind: 'BOND_DELTA', delta10: 5 }]));
    expect(instance.repo.transaction(tx => tx.getTrip(tripId))).toEqual(frozen);
    expect(instance.repo.transaction(tx => tx.listRewards(tripId))).toEqual([]);
  });

  it('automatically finalizes Nova’s homecoming in the return transaction and grants only one extra event item', () => {
    const f = fixture(allEventChances); let instance = f.open();
    for (let i = 0; i < 3; i++) {
      f.advance(initialTime + minutes(120 * i));
      expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
      f.advance(initialTime + minutes(120 * i + 15)); instance.service.getSnapshot();
    }
    const acquired = expectSuccess(f.request(instance.service, f.command('PET_ACQUIRE', { characterId: 'nova', catalogVersion: CHARACTER_CATALOG_VERSION })));
    const nova = acquired.pets.find(pet => pet.characterId === 'nova');
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: nova.petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets.find(pet => pet.petId === nova.petId).trip.tripId;
    const stockBefore = instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'slime-gel')?.quantity ?? 0);
    f.advance(initialTime + minutes(300));
    const page = readEvents(instance.service, { petId: nova.petId, filter: 'HISTORY' });
    const actual = instance.repo.transaction(tx => tx.getTrip(tripId).checkpoint.actualReturnedAt);
    const auto = page.events.rows[0];
    expect(auto).toMatchObject({ eventId: 'nova.field-calibration', status: 'RESOLVED', sourceTripId: tripId,
      occurredAt: actual, resolvedAt: actual, selectedChoiceId: null, choices: [], deadlineAt: null,
      rewards: expect.arrayContaining([{ kind: 'ITEM', itemId: 'slime-gel', quantity: 1 }]) });
    const tripStock = instance.repo.transaction(tx => tx.listRewards(tripId).filter(row => row.kind === 'ITEM' && row.targetId === 'slime-gel')
      .reduce((sum,row) => sum + row.amount,0));
    const stockAfter = instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'slime-gel').quantity);
    expect(stockAfter).toBe(stockBefore + tripStock + 1);
    instance.close(); instance = f.open();
    expect(readEvents(instance.service, { petId: nova.petId, filter: 'HISTORY' }).events.rows).toEqual([auto]);
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'slime-gel').quantity)).toBe(stockAfter);
  });
});

function readCharacters(service) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'characters-query', method: 'characters/list', payload: {} });
  expect(result.ok).toBe(true);
  expect(result.characters.revision).toBe(result.snapshot.revision);
  expect(result.characters.walletCoins).toBe(result.snapshot.walletCoins);
  return result;
}

function readInventory(service, legacyOffset) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'inventory-query', method: 'inventory/list',
    payload: legacyOffset === undefined ? {} : { legacyOffset } });
  expect(result.ok).toBe(true);
  expect(result.inventory.revision).toBe(result.snapshot.revision);
  expect(result.inventory.walletCoins).toBe(result.snapshot.walletCoins);
  return result;
}

function readTravelCatalog(service) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-catalog-query', method: 'travel/catalog', payload: {} });
  expect(result.ok).toBe(true);
  expect(result.travelCatalog.revision).toBe(result.snapshot.revision);
  return result;
}

function readTravelPreview(service, payload) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-preview-query', method: 'travel/preview', payload });
  expect(result.ok).toBe(true);
  expect(result.travelPreview.revision).toBe(result.snapshot.revision);
  return result;
}

function readTravelReports(service, payload = { offset: 0, limit: 20 }) {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-reports-query', method: 'travel/reports', payload });
  expect(result.ok).toBe(true);
  expect(result.travelReports.revision).toBe(result.snapshot.revision);
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
    expect(() => new AppService(repo, runtime, false)).toThrow();
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
    const currentBeforeView = instance.service.getSnapshot();
    expect(currentBeforeView.pets.find((pet) => pet.petId === petId).energy).toBe(85.3);
    const { characterId, eventDefId, assetVersion, assetHash } = pin.assetRef;
    const viewCommand = f.command('CG_MARK_VIEWED', { ...keys, characterId, eventDefId, assetVersion, assetHash }, 'view-cg-once');
    const viewed = expectSuccess(f.request(instance.service, viewCommand));
    const favoriteCommand = f.command('CG_SET_FAVORITE', { ...keys, favorite: true }, 'favorite-cg-once');
    const favorited = expectSuccess(f.request(instance.service, favoriteCommand));
    expect(viewed.revision).toBe(currentBeforeView.revision + 1);
    expect(favorited.revision).toBe(viewed.revision + 1);
    expect(favorited).toEqual({ ...currentBeforeView, revision: favorited.revision });
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
    const collectedAgain = readGallery(instance.service, { petId, filter: 'UNLOCKED' });
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
    expect(instance.repo.transaction((tx) => tx.getPetAcquisition(petId))).toBeNull();
    expect(readCharacters(instance.service).characters.rows.find(row => row.characterId === 'star-singer')?.instances)
      .toEqual([{ petId, nickname: '星咏', origin: 'LEGACY', acquiredAt: null }]);
    const settled = readGallery(instance.service, { petId, filter: 'UNLOCKED' });
    expect(settled.snapshot.walletCoins).toBe(8);
    expect(settled.gallery.rows).toHaveLength(1);
    expect(settled.gallery.rows[0]).toMatchObject({ petId, cgId: 'morning-dew', variant: 'default', title: '历史纪念画面',
      sourceTripId: tripId, unlockStatus: 'UNLOCKED', assetRef: { state: 'LEGACY_UNVERSIONED' }, viewedAt: null });
    const legacyReport = readTravelReports(instance.service, { petId, offset: 0, limit: 20 }).travelReports.rows[0];
    expect(legacyReport).toMatchObject({ tripId, loadout: null, departurePower: snapshot.power, actualReturnedAt: snapshot.expectedReturnAt });
    expect(instance.repo.transaction(tx => tx.getTripDepartureLoadout(tripId))).toBeNull();
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

  it('atomically acquires a new character with earned coins, rolls back failure, persists across restart and renames in flight', () => {
    const f = fixture();
    let failAcquisition = false;
    let instance = f.open((repo) => ({
      close: () => repo.close(),
      transaction: (action) => repo.transaction((tx) => action(new Proxy(tx, {
        get(target, key) {
          if (key === 'appendOutbox' && failAcquisition) return (event) => {
            if (event.type === 'PetAcquired') throw new Error('simulated acquisition failure');
            return target.appendOutbox(event);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    const initial = readCharacters(instance.service);
    expect(initial.characters.rows[0].instances).toEqual([{ petId: 'pet-1', nickname: '星咏', origin: 'STARTER', acquiredAt: initialTime }]);
    expect(instance.repo.transaction(tx => tx.getPetAcquisition('pet-2'))).toEqual({ petId: 'pet-2', acquiredAt: initialTime,
      origin: 'STARTER', catalogVersion: CHARACTER_CATALOG_VERSION, coinCost: 0, commandId: null });
    for (let trip = 0; trip < 3; trip++) {
      expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
      f.advance(initialTime + minutes(15 * (trip + 1)));
      instance.service.getSnapshot();
    }
    const unlocked = readCharacters(instance.service);
    expect(unlocked.characters.settledTrips).toBe(3);
    expect(unlocked.characters.walletCoins).toBe(24);
    expect(unlocked.characters.rows.find(row => row.characterId === 'nova').availability).toBe('AVAILABLE');
    const purchase = f.command('PET_ACQUIRE', { characterId: 'nova', catalogVersion: CHARACTER_CATALOG_VERSION },
      'nova-purchase-once', unlocked.snapshot.revision);
    const durableState = () => instance.repo.transaction(tx => ({ preferences: tx.getPreferences(), coins: tx.getWalletCoins(),
      pets: tx.listPets(), acquisitions: tx.listPets().map(pet => tx.getPetAcquisition(pet.petId)),
      outbox: tx.listOutbox(0, 100), receipt: tx.getCommandReceipt(purchase.commandId) }));
    const before = durableState();
    failAcquisition = true;
    expect(f.request(instance.service, purchase)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(durableState()).toEqual(before);
    failAcquisition = false;
    const bought = expectSuccess(f.request(instance.service, purchase));
    const obtained = bought.pets.find(pet => pet.characterId === 'nova');
    expect(bought.walletCoins).toBe(8);
    expect(obtained).toMatchObject({ presence: 'HOME', level: 1, xp: 0, visibility: 'HIDDEN', nickname: '诺瓦' });
    const record = { petId: obtained.petId, acquiredAt: initialTime + minutes(45), origin: 'GAME',
      catalogVersion: CHARACTER_CATALOG_VERSION, coinCost: 16, commandId: purchase.commandId };
    expect(instance.repo.transaction(tx => tx.getPetAcquisition(obtained.petId))).toEqual(record);
    expect(instance.repo.transaction(tx => tx.getPet(obtained.petId).power)).toBe(28);
    expect(expectSuccess(f.request(instance.service, purchase))).toEqual(bought);
    expect(f.request(instance.service, f.command('PET_ACQUIRE', { characterId: 'nova', catalogVersion: CHARACTER_CATALOG_VERSION })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    const departed = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: obtained.petId, routeId: DEMO_ROUTE.routeId })));
    const tripId = departed.pets.find(pet => pet.petId === obtained.petId).trip.tripId;
    const beforeTrip = instance.repo.transaction(tx => ({ trip: tx.getTrip(tripId), facts: tx.listTripFacts(tripId), pins: tx.listTripCgAssetPins(tripId) }));
    const rename = f.command('PET_RENAME', { petId: obtained.petId, nickname: '  No\u0301va 诺瓦 ' }, 'nick-once');
    const renamed = expectSuccess(f.request(instance.service, rename));
    expect(renamed.pets.find(pet => pet.petId === obtained.petId)).toMatchObject({ nickname: 'Nóva 诺瓦', presence: 'AWAY', trip: { tripId } });
    expect(instance.repo.transaction(tx => ({ trip: tx.getTrip(tripId), facts: tx.listTripFacts(tripId), pins: tx.listTripCgAssetPins(tripId) }))).toEqual(beforeTrip);
    expect(instance.repo.transaction(tx => tx.getPetAcquisition(obtained.petId))).toEqual(record);
    instance.close();
    instance = f.open();
    expect(instance.service.getSnapshot()).toEqual(renamed);
    expect(readCharacters(instance.service).characters.rows.find(row => row.characterId === 'nova')).toMatchObject({ availability: 'ALREADY_OWNED', instances: [
      { petId: obtained.petId, nickname: 'Nóva 诺瓦', origin: 'GAME', acquiredAt: record.acquiredAt },
    ] });
    expect(expectSuccess(f.request(instance.service, purchase))).toEqual(bought);
    expect(expectSuccess(f.request(instance.service, rename))).toEqual(renamed);
    expect(instance.repo.transaction(tx => tx.getPetAcquisition(obtained.petId))).toEqual(record);
    expect(instance.repo.transaction(tx => tx.listOutbox(0, 100).filter(entry => entry.event.type === 'PetAcquired'))).toHaveLength(1);
    expect(instance.repo.transaction(tx => tx.getWalletCoins())).toBe(8);
    instance.close();
  });
});

describe.skipIf(!supported)('persisted HOME recovery and bounded interactions', () => {
  const petState = (instance, petId) => instance.repo.transaction(tx => ({
    pet: tx.getPet(petId), schedule: tx.getHomeSchedule(petId), logicalTime: tx.getPreferences().logicalTime,
  }));

  it('defers fraction-only polls, persists exactly when visible needs change, and recomputes across restart', () => {
    const f = fixture();
    let instance = f.open();
    instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), energy10: 600 }));
    const original = instance.service.getSnapshot();
    const durable = petState(instance, 'pet-1').schedule;
    f.advance(initialTime + 17_999);
    expect(instance.service.getSnapshot()).toEqual(original);
    expect(petState(instance, 'pet-1')).toMatchObject({ pet: { energy10: 600 }, schedule: durable,
      logicalTime: initialTime + 17_999 });
    instance.close();
    instance = f.open();
    expect(instance.service.getSnapshot()).toEqual(original);
    expect(petState(instance, 'pet-1').schedule).toEqual(durable);
    f.advance(initialTime + 18_000);
    const next = instance.service.getSnapshot();
    expect(next.revision).toBe(original.revision + 1);
    expect(next.pets[0]).toMatchObject({ energy: 60.1, revision: original.pets[0].revision + 1 });
    expect(petState(instance, 'pet-1').schedule).toMatchObject({ lastSimAt: initialTime + 18_000, energyRemainder: 0 });
    instance.close();
  });

  it('has identical 72-hour and irregular segmented effective HOME state with real persisted restarts', () => {
    function run(segmented, elapsed) {
      const f = fixture();
      let instance = f.open();
      instance.repo.transaction(tx => {
        tx.savePet({ ...tx.getPet('pet-1'), energy10: 125, healthPoints10: 400, healthStatus: 'INJURED', moodScore10: 920, bond10: 240 });
        tx.savePet({ ...tx.getPet('pet-2'), energy10: 600, healthPoints10: 780, healthStatus: 'RECOVERING', moodScore10: 200, bond10: 180 });
      });
      instance.service.getSnapshot();
      if (segmented) {
        for (const delta of [1_000, 17_999, 36_123, HOME_RULES.hourMs + 7, 2 * HOME_RULES.hourMs + 123,
          4 * HOME_RULES.hourMs + 13_337, HOME_RULES.dayMs, 2 * HOME_RULES.dayMs + 7]) {
          if (delta >= elapsed) continue;
          f.advance(initialTime + delta);
          instance.service.getSnapshot();
          instance.close();
          instance = f.open();
        }
      }
      f.advance(initialTime + elapsed);
      const snapshot = instance.service.getSnapshot();
      const projected = ['pet-1', 'pet-2'].map(id => {
        const { pet, schedule, logicalTime } = petState(instance, id);
        const { revision: _revision, ...withoutRevision } = pet;
        return advanceHomeState({ ...withoutRevision, ...schedule }, logicalTime);
      });
      expect(snapshot.pets.map(pet => pet.bond)).toEqual([24, 18]);
      expect(snapshot.walletCoins).toBe(0);
      instance.close();
      return projected;
    }
    for (const elapsed of [5 * HOME_RULES.hourMs + 18_099, 72 * HOME_RULES.hourMs + 12_345]) {
      expect(run(true, elapsed)).toEqual(run(false, elapsed));
    }
  });

  it('never recovers while away and credits only elapsed HOME time from the actual returnedAt after restart', () => {
    const f = fixture();
    let instance = f.open();
    instance.repo.transaction(tx => {
      tx.savePet({ ...tx.getPet('pet-1'), energy10: 600 });
      tx.savePet({ ...tx.getPet('pet-2'), energy10: 700 });
    });
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
    const tripId = started.pets[0].trip.tripId;
    expect(started.pets[0].energy).toBe(45);
    f.advance(initialTime + minutes(12));
    expect(instance.service.getSnapshot().pets[0]).toMatchObject({ presence: 'RETURNING', energy: 45 });
    expect(petState(instance, 'pet-1').schedule.activityDueAt).toBeNull();
    instance.close();
    f.advance(initialTime + minutes(45));
    instance = f.open();
    const arrived = instance.service.getSnapshot();
    expect(arrived.pets[0]).toMatchObject({ presence: 'HOME', energy: 55, xp: 24, trip: { tripId, status: 'SETTLED',
      expectedReturnAt: initialTime + minutes(15) } });
    expect(arrived.pets[1].energy).toBe(85); // the other pet was HOME the full 45 minutes
    expect(petState(instance, 'pet-1').schedule.lastSimAt).toBe(initialTime + minutes(45));
    expect(instance.repo.transaction(tx => tx.getSettlement(tripId)).settledAt).toBe(initialTime + minutes(15));
    instance.close();
  });

  it('retains independent cooldown, UTC daily count and authoritative receipts across midnight and restart', () => {
    const f = fixture();
    let instance = f.open();
    const midnight = (Math.floor(initialTime / HOME_RULES.dayMs) + 1) * HOME_RULES.dayMs;
    const firstAt = midnight - 10_000;
    f.advance(firstAt);
    const raw = f.command('PET_INTERACT', { petId: 'pet-1', interaction: 'PET' }, 'first-home-touch');
    const first = expectSuccess(f.request(instance.service, raw));
    expect(first.pets[0].bond).toBe(1);
    expect(petState(instance, 'pet-1').schedule).toMatchObject({ interactionCount: 1, lastInteractionAt: firstAt });
    instance.close();
    f.advance(midnight);
    instance = f.open();
    expect(expectSuccess(f.request(instance.service, raw))).toEqual(first); // historical success, no replay
    const touch = (petId, id) => expectSuccess(f.request(instance.service, f.command('PET_INTERACT', { petId, interaction: 'PET' }, id)));
    expect(touch('pet-1', 'midnight-cooldown').pets[0].bond).toBe(1);
    expect(petState(instance, 'pet-1').schedule).toMatchObject({ interactionDay: Math.floor(midnight / HOME_RULES.dayMs),
      interactionCount: 0, lastInteractionAt: firstAt });
    expect(touch('pet-2', 'independent-touch').pets[1].bond).toBe(1);
    f.advance(midnight + 20_000);
    expect(touch('pet-1', 'second-eligible').pets[0].bond).toBe(2);
    for (let i = 1; i < HOME_RULES.petDailyLimit; i++) {
      f.advance(midnight + 20_000 + i * HOME_RULES.petCooldownMs);
      touch('pet-1', `bounded-${i}`);
    }
    const beforeExcess = petState(instance, 'pet-1');
    f.advance(midnight + 20_000 + HOME_RULES.petDailyLimit * HOME_RULES.petCooldownMs);
    expect(touch('pet-1', 'daily-excess').pets[0].bond).toBe(11);
    expect(petState(instance, 'pet-1').schedule).toMatchObject({ interactionCount: 10, lastInteractionAt: beforeExcess.schedule.lastInteractionAt });
    expect(instance.repo.transaction(tx => tx.listOutbox(0, 100).filter(entry => entry.event.type === 'PetInteracted').at(-1).event.payload))
      .toMatchObject({ rewardGranted: false, reason: 'DAILY_LIMIT' });
    instance.close();
    f.advance(midnight + HOME_RULES.dayMs);
    instance = f.open();
    expect(touch('pet-1', 'next-utc-day').pets[0].bond).toBe(12);
    expect(petState(instance, 'pet-1').schedule.interactionCount).toBe(1);
    expect(instance.service.getSnapshot().pets[1].bond).toBe(1);
    instance.close();
  });

  it('migrates genuine v3 at prior authority time, not old adoption, and preserves raw old successful receipts', () => {
    const f = fixture();
    const petId = 'pet-1';
    const oldCommand = { commandId: 'historical-rest', issuedAt: initialTime - minutes(1),
      payload: { interaction: 'REST', petId }, type: 'PET_INTERACT' };
    const oldSnapshot = { revision: 5, primaryPetId: petId, walletCoins: 0, doNotDisturb: false, pausedRender: false,
      pets: [{ petId, characterId: 'star-singer', nickname: '星咏', presence: 'HOME', activity: 'REST', mood: 'HAPPY',
        healthStatus: 'INJURED', visibility: 'VISIBLE', moodScore: 70, healthPoints: 50, energy: 40, bond: 15, level: 1, xp: 0, revision: 5 }] };
    const fingerprint = JSON.stringify(oldCommand);
    const outcome = JSON.stringify({ ok: true, snapshot: oldSnapshot });
    const db = new DatabaseSync(f.dbPath);
    try {
      for (const [version, sql, checksum] of [
        [1, MIGRATION_001, 'fnv1a32:9d3ced6f'], [2, MIGRATION_002, 'fnv1a32:a0036d79'], [3, MIGRATION_003, 'fnv1a32:519a9ef3'],
      ]) {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(version, checksum, initialTime);
        db.exec(`PRAGMA user_version = ${version}`);
      }
      db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run(petId, 'star-singer', '星咏', 5);
      db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(petId, 'HOME', 'REST', 'HAPPY', 'INJURED', 'VISIBLE', 700, 500, 400, 150);
      db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run(petId, 30, 0);
      db.prepare('INSERT INTO preferences VALUES (?, ?, ?, ?, ?, ?)').run(1, 5, initialTime, petId, 0, 0);
      db.prepare('INSERT INTO pet_acquisitions VALUES (?, ?, ?, ?, ?, ?)')
        .run(petId, initialTime - HOME_RULES.dayMs, 'STARTER', CHARACTER_CATALOG_VERSION, 0, null);
      db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)')
        .run(oldCommand.commandId, fingerprint, outcome, 1, initialTime);
    } finally { db.close(); }
    f.advance(initialTime + minutes(30));
    const beforeMigration = (source, from) => {
      expect(from).toBe(3);
      verifyMigrationBackup(source, `${f.dbPath}.v3-home-backup`, from, filename => new DatabaseSync(filename, { readOnly: true }));
    };
    const instance = f.open(repo => repo, { beforeMigration });
    const now = instance.service.getSnapshot();
    expect(now.pets[0]).toMatchObject({ energy: 50, healthPoints: 55, moodScore: 65, bond: 15, healthStatus: 'RECOVERING', activity: 'REST' });
    expect(petState(instance, petId).schedule).toMatchObject({ lastSimAt: initialTime + minutes(30), interactionCount: 0, lastInteractionAt: null });
    expect(expectSuccess(f.request(instance.service, oldCommand))).toEqual(oldSnapshot);
    expect(instance.service.getSnapshot()).toEqual(now);
    instance.close();
    const upgraded = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      expect(upgraded.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
      expect(upgraded.prepare('SELECT fingerprint,outcome_json,created_at FROM commands WHERE command_id=?').get(oldCommand.commandId))
        .toEqual({ fingerprint, outcome_json: outcome, created_at: initialTime });
      expect(upgraded.prepare('SELECT acquired_at FROM pet_acquisitions WHERE pet_id=?').get(petId).acquired_at)
        .toBe(initialTime - HOME_RULES.dayMs);
    } finally { upgraded.close(); }
  });

  it('refuses startup on a partially missing or activity-inconsistent home schedule rather than reseeding it', () => {
    for (const corruption of ['partial', 'activity']) {
      const f = fixture();
      const instance = f.open();
      if (corruption === 'activity') {
        instance.repo.transaction(tx => tx.savePet({ ...tx.getPet('pet-1'), activity: 'INTERACT' })); // no matching deadline
      }
      instance.close();
      if (corruption === 'partial') {
        // Synthetic corruption fixture only; the real v4 write path prohibits deleting schedule rows.
        const db = new DatabaseSync(f.dbPath);
        try { db.exec('DROP TRIGGER preserve_home_schedule'); db.prepare('DELETE FROM pet_home_schedules WHERE pet_id=?').run('pet-1'); }
        finally { db.close(); }
      }
      expect(() => f.open()).toThrow();
    }
  });
});

describe.skipIf(!supported)('shared equipment economy in actual SQLite', () => {
  const version = ITEM_CATALOG_VERSION;

  it('earns actual trip coins, purchases/assigns/upgrades/uses/retires items, and recovers exact receipts without rewriting a frozen trip', () => {
    const f = fixture();
    let failEvent = false;
    let instance = f.open(repo => ({
      close: () => repo.close(),
      transaction: action => repo.transaction(tx => action(new Proxy(tx, {
        get(target, key) {
          if (key === 'appendOutbox' && failEvent) return event => {
            if (event.type === 'ShopPurchased') throw new Error('injected commerce failure');
            return target.appendOutbox(event);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    const originalTrips = [];
    for (let i = 0; i < 5; i++) {
      const dispatch = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
      const tripId = dispatch.pets[0].trip.tripId;
      f.advance(initialTime + minutes((i + 1) * 15));
      instance.service.getSnapshot();
      originalTrips.push(instance.repo.transaction(tx => ({ trip: tx.getTrip(tripId), ledger: tx.listRewards(tripId), settlement: tx.getSettlement(tripId) })));
    }
    const beforeBuy = readInventory(instance.service);
    expect(beforeBuy.snapshot.walletCoins).toBe(40);
    expect(beforeBuy.snapshot.pets[0].level).toBe(2);
    const command = (type, payload, id) => f.command(type, { ...payload, catalogVersion: version }, id, instance.service.getSnapshot().revision);
    const snapshot = () => instance.repo.transaction(tx => ({ coins: tx.getWalletCoins(), items: tx.listItemInstances(),
      stacks: tx.listInventory(), equipment: tx.listPetEquipment(), preferences: tx.getPreferences(), outbox: tx.listOutbox(0, 200) }));
    const purchase = command('SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 2 }, 'earned-staff-pair');
    const beforeFailure = snapshot();
    failEvent = true;
    expect(f.request(instance.service, purchase)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(snapshot()).toEqual(beforeFailure);
    expect(instance.repo.transaction(tx => [tx.getCommerceOperation(purchase.commandId), tx.getCommandReceipt(purchase.commandId)])).toEqual([null, null]);
    failEvent = false;
    const purchased = expectSuccess(f.request(instance.service, purchase));
    expect(purchased.walletCoins).toBe(16);
    const [one, two] = instance.repo.transaction(tx => tx.getCommerceOperation(purchase.commandId).instanceIds);
    expect(one).not.toBe(two);
    expect(instance.repo.transaction(tx => tx.listItemInstances())).toHaveLength(2);

    expectSuccess(f.request(instance.service, command('SHOP_PURCHASE', { offerId: 'shop-iron-ore', quantity: 1 }, 'earned-ore')));
    expectSuccess(f.request(instance.service, command('EQUIPMENT_EQUIP', { petId: 'pet-1', instanceId: one, slot: 'WEAPON' }, 'assign-first')));
    expect(f.request(instance.service, command('EQUIPMENT_EQUIP', { petId: 'pet-2', instanceId: one, slot: 'WEAPON' }, 'reject-theft')))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expectSuccess(f.request(instance.service, command('EQUIPMENT_EQUIP', { petId: 'pet-1', instanceId: two, slot: 'WEAPON' }, 'replace-owned')));
    expect(instance.repo.transaction(tx => tx.getCommerceOperation('replace-owned'))).toMatchObject({ previousInstanceId: one, instanceId: two });
    expectSuccess(f.request(instance.service, command('EQUIPMENT_EQUIP', { petId: 'pet-2', instanceId: one, slot: 'WEAPON' }, 'assign-other')));
    const gearBefore = readInventory(instance.service).inventory;
    const quoted = gearBefore.instances.find(item => item.instanceId === two).upgrade;
    expect(quoted).toMatchObject({ ok: true, affordable: true, cost: { coins: 10, materials: [{ itemId: 'iron-ore', quantity: 1 }] } });
    const upgrade = command('EQUIPMENT_UPGRADE', { instanceId: two, expectedEnhancement: 0 }, 'upgrade-paid');
    const upgraded = expectSuccess(f.request(instance.service, upgrade));
    expect(upgraded.walletCoins).toBe(3);
    expect(instance.repo.transaction(tx => tx.getItemInstance(two).enhancement)).toBe(1);
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'iron-ore').quantity)).toBe(0);
    const gearAfter = readInventory(instance.service).inventory;
    expect(gearAfter.pets[0].battlePower).toBeGreaterThan(gearBefore.pets[0].battlePower);
    expect(gearAfter.pets[1]).toEqual(gearBefore.pets[1]);
    expect(f.request(instance.service, command('EQUIPMENT_SALVAGE', { instanceId: two, expectedEnhancement: 1 }, 'reject-equipped-salvage')))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });

    expectSuccess(f.request(instance.service, command('SHOP_PURCHASE', { offerId: 'shop-ration', quantity: 1 }, 'paid-ration')));
    const feed = command('ITEM_USE', { petId: 'pet-1', itemId: 'ration' }, 'consume-once');
    const fed = expectSuccess(f.request(instance.service, feed));
    expect(fed.walletCoins).toBe(1);
    expect(fed.pets[0]).toMatchObject({ energy: 45, activity: 'EAT' });
    const power = readInventory(instance.service).inventory.pets[0].battlePower;
    const departed = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
    const travel = departed.pets[0].trip.tripId;
    const frozen = instance.repo.transaction(tx => tx.getTrip(travel).snapshot);
    expect(frozen.power).toBe(power);
    expectSuccess(f.request(instance.service, command('EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON' }, 'release-during-travel')));
    const salvage = command('EQUIPMENT_SALVAGE', { instanceId: two, expectedEnhancement: 1 }, 'salvage-once');
    const salvaged = expectSuccess(f.request(instance.service, salvage));
    expect(salvaged.pets[0].presence).toBe('AWAY');
    expect(salvaged.walletCoins).toBe(1);
    expect(instance.repo.transaction(tx => tx.getItemInstance(two))).toBeNull();
    expect(instance.repo.transaction(tx => tx.listInventory().find(row => row.itemId === 'iron-scrap').quantity)).toBe(1);
    expect(instance.repo.transaction(tx => tx.getTrip(travel).snapshot)).toEqual(frozen);
    const operationIds = [purchase.commandId, 'earned-ore', 'assign-first', 'replace-owned', 'assign-other', upgrade.commandId,
      'paid-ration', feed.commandId, 'release-during-travel', salvage.commandId];
    const operations = instance.repo.transaction(tx => operationIds.map(id => tx.getCommerceOperation(id)));
    expect(operations.every(Boolean)).toBe(true);
    const durable = snapshot();
    instance.close();
    instance = f.open();
    expect(expectSuccess(f.request(instance.service, purchase))).toEqual(purchased);
    expect(expectSuccess(f.request(instance.service, upgrade))).toEqual(upgraded);
    expect(expectSuccess(f.request(instance.service, feed))).toEqual(fed);
    expect(expectSuccess(f.request(instance.service, salvage))).toEqual(salvaged);
    expect(snapshot()).toEqual(durable);
    expect(instance.repo.transaction(tx => operationIds.map(id => tx.getCommerceOperation(id)))).toEqual(operations);
    f.advance(initialTime + minutes(90));
    instance.service.getSnapshot();
    expect(instance.repo.transaction(tx => tx.getTrip(travel).snapshot)).toEqual(frozen);
    expect(instance.repo.transaction(tx => originalTrips.map(record => ({ trip: tx.getTrip(record.trip.snapshot.tripId),
      ledger: tx.listRewards(record.trip.snapshot.tripId), settlement: tx.getSettlement(record.trip.snapshot.tripId) })))).toEqual(originalTrips);
    expect(instance.repo.transaction(tx => tx.listItemInstances())).toEqual([expect.objectContaining({ instanceId: one, enhancement: 0 })]);
    instance.close();
  });

  it('rolls back operands, operation record and receipt together if final receipt persistence fails', () => {
    const f = fixture();
    let failReceipt = false;
    let instance = f.open(repo => ({
      close: () => repo.close(),
      transaction: action => repo.transaction(tx => action(new Proxy(tx, {
        get(target, key) {
          if (key === 'saveCommandReceipt' && failReceipt) return receipt => {
            target.saveCommandReceipt(receipt);
            if (receipt.commandId === 'receipt-failure') throw new Error('injected receipt rollback');
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    instance.repo.transaction(tx => tx.setWalletCoins(12));
    const purchase = f.command('SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 1, catalogVersion: version },
      'receipt-failure', instance.service.getSnapshot().revision);
    failReceipt = true;
    expect(f.request(instance.service, purchase)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(instance.repo.transaction(tx => [tx.getWalletCoins(), tx.listItemInstances(), tx.getCommerceOperation(purchase.commandId),
      tx.getCommandReceipt(purchase.commandId)])).toEqual([12, [], null, null]);
    failReceipt = false;
    const result = expectSuccess(f.request(instance.service, purchase));
    expect(result.walletCoins).toBe(0);
    instance.close();
    instance = f.open();
    expect(expectSuccess(f.request(instance.service, purchase))).toEqual(result);
    expect(instance.repo.transaction(tx => tx.listItemInstances())).toHaveLength(1);
    instance.close();
  });

  it('preserves and paginates 257+ historical v4 stacks, including a current gear-ID collision, without blocking real trip rewards', () => {
    const f = fixture();
    const petId = 'pet-1';
    const db = new DatabaseSync(f.dbPath);
    try {
      for (const [versionNumber, sql, checksum] of [
        [1, MIGRATION_001, 'fnv1a32:9d3ced6f'], [2, MIGRATION_002, 'fnv1a32:a0036d79'], [3, MIGRATION_003, 'fnv1a32:519a9ef3'],
        [4, MIGRATION_004, 'fnv1a32:0f3c0f0e'],
      ]) {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(versionNumber, checksum, initialTime);
        db.exec(`PRAGMA user_version=${versionNumber}`);
      }
      // Seed the archived rows as one commit. This test verifies migration
      // and pagination, so hundreds of independent disk flushes aren't needed.
      db.exec('BEGIN');
      db.prepare('INSERT INTO pets VALUES (?, ?, ?, ?)').run(petId, 'star-singer', '星咏', 0);
      db.prepare('INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(petId, 'HOME', 'IDLE', 'CALM', 'NORMAL', 'VISIBLE', 500, 1000, 1000, 0);
      db.prepare('INSERT INTO pet_progression VALUES (?, ?, ?)').run(petId, 30, 0);
      db.prepare('INSERT INTO preferences VALUES (?, ?, ?, ?, ?, ?)').run(1, 0, initialTime, petId, 0, 0);
      db.prepare('INSERT INTO pet_home_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(petId, initialTime, null, 0, 0, 0, Math.floor(initialTime / HOME_RULES.dayMs), 0, null);
      db.prepare('UPDATE wallet SET balance=? WHERE currency=?').run(20, 'coin');
      const stack = db.prepare('INSERT INTO inventory(item_id,quantity) VALUES (?,?)');
      // Old valid stack identity collides with a gear definition introduced
      // by v5. This row remains history; it must never turn into a +0 staff.
      stack.run('apprentice-staff', 7);
      for (let i = 0; i < 260; i++) stack.run(`legacy-${String(i).padStart(3,'0')}`, i % 5);
      stack.run('ration', 2);
      db.exec('COMMIT');
    } finally { db.close(); }

    const beforeMigration = (source, from) => {
      expect(from).toBe(4);
      verifyMigrationBackup(source, `${f.dbPath}.v4-legacy-backup`, from, filename => new DatabaseSync(filename, { readOnly: true }));
    };
    const instance = f.open(repo => repo, { beforeMigration });
    const first = readInventory(instance.service).inventory;
    expect(first).toMatchObject({ legacyStackOffset: 0, legacyStackTotal: 261 });
    expect(first.stacks[0]).toEqual({ itemId: 'ration', quantity: 2, definitionState: 'AVAILABLE' });
    expect(first.stacks[1]).toEqual({ itemId: 'apprentice-staff', quantity: 7, definitionState: 'LEGACY_UNKNOWN' });
    expect(first.instances).toEqual([]);
    const historical = [];
    for (const offset of [0,128,256,10_000]) {
      const page = readInventory(instance.service, offset).inventory;
      expect(page.legacyStackOffset).toBe(offset);
      expect(page.legacyStackTotal).toBe(261);
      expect(page.stacks.filter(row => row.definitionState === 'AVAILABLE')).toEqual([first.stacks[0]]);
      historical.push(...page.stacks.filter(row => row.definitionState === 'LEGACY_UNKNOWN'));
    }
    expect(historical).toHaveLength(261);
    expect(new Set(historical.map(row => row.itemId)).size).toBe(261);
    expect(historical.map(row => row.itemId)).toEqual(historical.map(row => row.itemId).sort());

    const trip = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId, routeId: DEMO_ROUTE.routeId }))).pets[0].trip.tripId;
    f.advance(initialTime + minutes(15));
    const afterTrip = readInventory(instance.service, 128);
    expect(afterTrip.snapshot.walletCoins).toBe(28);
    expect(afterTrip.snapshot.pets[0]).toMatchObject({ presence: 'HOME', xp: 24 });
    expect(afterTrip.inventory.stacks.filter(row => row.definitionState === 'AVAILABLE')).toEqual([
      { itemId: 'herb', quantity: 1, definitionState: 'AVAILABLE' }, { itemId: 'ration', quantity: 2, definitionState: 'AVAILABLE' },
      { itemId: 'slime-gel', quantity: 1, definitionState: 'AVAILABLE' },
    ]);
    expect(instance.repo.transaction(tx => tx.getSettlement(trip))).not.toBeNull();
    const command = (type, payload, id) => f.command(type, { ...payload, catalogVersion: version }, id, instance.service.getSnapshot().revision);
    expect(f.request(instance.service, command('ITEM_USE', { petId, itemId: 'apprentice-staff' }, 'deny-historical-gear-stack-use')))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expectSuccess(f.request(instance.service, command('SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 1 }, 'new-staff-not-conversion')));
    expectSuccess(f.request(instance.service, command('SHOP_PURCHASE', { offerId: 'shop-healing-potion', quantity: 1 }, 'new-compatible-stack')));
    const afterPurchases = readInventory(instance.service, 0).inventory;
    expect(afterPurchases.walletCoins).toBe(12);
    expect(afterPurchases.instances).toEqual([expect.objectContaining({ definitionId: 'apprentice-staff', enhancement: 0 })]);
    expect(afterPurchases.stacks.find(row => row.itemId === 'apprentice-staff')).toEqual({ itemId: 'apprentice-staff', quantity: 7, definitionState: 'LEGACY_UNKNOWN' });
    expect(afterPurchases.stacks.find(row => row.itemId === 'healing-potion')).toEqual({ itemId: 'healing-potion', quantity: 1, definitionState: 'AVAILABLE' });
    expect(afterPurchases.legacyStackTotal).toBe(261);
    expect(instance.repo.transaction(tx => tx.listInventory().length)).toBe(265); // all 261 + four compatible stacks, no truncation
    instance.close();
  });
});

describe.skipIf(!supported)('prepared travel and historical reports in actual SQLite', () => {
  const version = ROUTE_CATALOG_VERSION;
  const payload = (petId, routeId, selectedSupplies = []) => ({ petId, routeId, routeCatalogVersion: version, selectedSupplies });

  it('settles concurrent skilled and legacy trips after a SQLite restart with their original rule and report shapes', () => {
    const f = fixture();
    let instance = f.open();
    const legacy = expectSuccess(f.request(instance.service, f.command('TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })));
    const legacyId = legacy.pets.find(pet => pet.petId === 'pet-1').trip.tripId;
    const intent = payload('pet-2', DEMO_ROUTE.routeId);
    const quote = readTravelPreview(instance.service, intent);
    const depart = f.command('TRIP_START_PREPARED', intent, 'round-departure', quote.snapshot.revision);
    const prepared = expectSuccess(f.request(instance.service, depart));
    const roundId = prepared.pets.find(pet => pet.petId === intent.petId).trip.tripId;
    const snapshot = instance.repo.transaction(tx => tx.getTrip(roundId).snapshot);
    expect(snapshot).toMatchObject({ rulesVersion: 'trip-v3', battle: { petSkill: 'KEEN_SHOT', bossNodeId: null,
      encounters: [{ nodeId: 'meadow-slime', enemy: { enemyId: 'slime' } }] } });
    f.advance(initialTime + minutes(8));
    const active = () => activeTravelIpcResultSchema.parse(instance.service.handleRequest({
      schemaVersion: 1, requestId: 'active-round', method: 'travel/active', payload: {},
    })).activeTravel;
    const before = active();
    const battle = before.rows.find(row => row.tripId === roundId).facts.find(fact => fact.type === 'BATTLE_RESOLVED');
    expect(battle.payload.battle).toMatchObject({ rulesVersion: 'battle-v3', petSkill: 'KEEN_SHOT', boss: null,
      enemy: { enemyId: 'slime' }, petStats: snapshot.battle.petStats });
    expect(battle.payload.battle.rounds[0].actions).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'PET', skills: ['KEEN_SHOT'] })]));
    expect(battle.payload.battle.rounds.length).toBeGreaterThan(0);
    expect(before.rows.find(row => row.tripId === legacyId).facts[1].payload).toHaveProperty('winChanceBps');
    instance.close();
    instance = f.open();
    expect(active()).toEqual(before);
    expect(expectSuccess(f.request(instance.service, depart))).toEqual(prepared);
    f.advance(initialTime + minutes(15));
    const settled = () => readTravelReports(instance.service).travelReports.rows;
    const reports = settled();
    expect(reports).toHaveLength(2);
    expect(reports.find(row => row.tripId === roundId)).toMatchObject({ rulesVersion: 'trip-v3', facts: expect.arrayContaining([battle]) });
    expect(reports.find(row => row.tripId === legacyId)).toMatchObject({ rulesVersion: 'trip-v1' });
    const wallet = instance.service.getSnapshot().walletCoins;
    instance.close();
    instance = f.open();
    expect(settled()).toEqual(reports);
    expect(instance.service.getSnapshot().walletCoins).toBe(wallet);
  });

  it('atomically applies Boss defeat recovery at return and does not repeat it after restart', () => {
    const f = fixture();
    const petId = 'pet-1';
    let failReturn = false;
    let instance = f.open(repo => ({
      close: () => repo.close(),
      transaction: action => repo.transaction(tx => action(new Proxy(tx, {
        get(target, key) {
          if (key === 'saveHomeSchedule' && failReturn) return schedule => {
            if (schedule.petId === petId && target.getPet(petId).presence === 'HOME') throw new Error('injected home schedule failure');
            return target.saveHomeSchedule(schedule);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    instance.repo.transaction(tx => {
      tx.savePet({ ...tx.getPet(petId), xp: cumulativeXpAtLevel(10) });
      tx.addInventory('ration', 2);
      tx.addInventory('healing-potion', 1);
    });
    const intent = payload(petId, 'starfall-ruins', [{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }]);
    const quote = readTravelPreview(instance.service, intent);
    const departed = expectSuccess(f.request(instance.service, f.command('TRIP_START_PREPARED', intent, 'ruins-defeat', quote.snapshot.revision)));
    const tripId = departed.pets.find(pet => pet.petId === petId).trip.tripId;
    const durable = () => instance.repo.transaction(tx => ({ pet: tx.getPet(petId), trip: tx.getTrip(tripId),
      settlement: tx.getSettlement(tripId), rewards: tx.listRewards(tripId), facts: tx.listTripFacts(tripId) }));
    const { snapshot, checkpoint } = durable().trip;
    const expected = advanceTrip(snapshot, checkpoint, snapshot.expectedReturnAt);
    expect(expected.checkpoint).toMatchObject({ returnReason: 'DEFEATED', battleHp: 0 });
    expect(expected.facts.find(fact => fact.type === 'BATTLE_RESOLVED' && fact.payload.battle.boss !== null))
      .toMatchObject({ type: 'BATTLE_RESOLVED', payload: { enemyId: 'ruins-core-guardian', outcome: 'LOSS', battle: { boss: 'RUINS_GUARDIAN' } } });
    const arrival = expected.checkpoint.actualReturnedAt;
    f.advance(arrival - 1);
    expect(instance.service.getSnapshot().pets.find(pet => pet.petId === petId)).toMatchObject({ presence: 'RETURNING', healthPoints: 100 });
    const before = durable();
    failReturn = true;
    f.advance(arrival);
    expect(instance.service.handleRequest({ schemaVersion: 1, requestId: 'failed-recovery', method: 'snapshot/get', payload: {} }))
      .toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(durable()).toEqual(before);
    failReturn = false;
    expect(instance.service.getSnapshot().pets.find(pet => pet.petId === petId))
      .toMatchObject({ presence: 'HOME', healthStatus: 'RECOVERING', healthPoints: 90 });
    const after = durable();
    expect(after.settlement).not.toBeNull();
    expect(after.rewards.length).toBeGreaterThan(0);
    instance.close();
    instance = f.open();
    expect(instance.service.getSnapshot().pets.find(pet => pet.petId === petId)).toMatchObject({ healthPoints: 90 });
    expect(durable()).toEqual(after);
    f.advance(arrival + minutes(60) - 1);
    expect(instance.service.getSnapshot().pets.find(pet => pet.petId === petId)).toMatchObject({ healthStatus: 'RECOVERING', healthPoints: 99.9 });
    f.advance(arrival + minutes(60));
    expect(instance.service.getSnapshot().pets.find(pet => pet.petId === petId)).toMatchObject({ healthStatus: 'NORMAL', healthPoints: 100 });
  });

  it('commits the existing ruins Boss victory exactly once and preserves its skill history over restart', () => {
    const f = fixture();
    let instance = f.open();
    const petId = 'pet-1';
    instance.repo.transaction(tx => {
      tx.savePet({ ...tx.getPet(petId), xp: cumulativeXpAtLevel(15) });
      tx.addInventory('ration', 2);
      tx.addInventory('healing-potion', 1);
    });
    const intent = payload(petId, 'starfall-ruins', [{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }]);
    const quote = readTravelPreview(instance.service, intent);
    const started = expectSuccess(f.request(instance.service, f.command('TRIP_START_PREPARED', intent, 'ruins-boss-win', quote.snapshot.revision)));
    const tripId = started.pets.find(pet => pet.petId === petId).trip.tripId;
    const catalogInstance = (identity) => readCharacters(instance.service).characters.rows
      .flatMap(row => row.instances).find(item => item.petId === identity);
    expect(catalogInstance(petId)).not.toHaveProperty('ruinsTitle');
    const frozen = instance.repo.transaction(tx => tx.getTrip(tripId)).snapshot;
    expect(frozen.battle.bossNodeId).toBe('ruins-core-guardian');
    instance.close();
    instance = f.open();
    f.advance(frozen.expectedReturnAt);
    const settled = () => readTravelReports(instance.service).travelReports.rows[0];
    const history = settled();
    expect(catalogInstance(petId)?.ruinsTitle).toEqual({
      id: 'ruins-pathbreaker', tripId, earnedAt: history.actualReturnedAt,
    });
    expect(catalogInstance('pet-2')).not.toHaveProperty('ruinsTitle');
    const boss = history.facts.find(fact => fact.payload.enemyId === frozen.battle.bossNodeId);
    expect(boss).toMatchObject({ type: 'BATTLE_RESOLVED', payload: { outcome: 'WIN', battle: { rulesVersion: 'battle-v3', boss: 'RUINS_GUARDIAN', petSkill: 'STARFLARE' } } });
    const skills = boss.payload.battle.rounds.flatMap(round => round.actions.flatMap(action => action.skills));
    expect(skills).toEqual(expect.arrayContaining(['STARFLARE', 'GUARDIAN_FRENZY']));
    const walletCoins = instance.service.getSnapshot().walletCoins;
    expect(walletCoins).toBe(220);
    instance.close();
    instance = f.open();
    expect(settled()).toEqual(history);
    expect(catalogInstance(petId)?.ruinsTitle).toEqual({
      id: 'ruins-pathbreaker', tripId, earnedAt: history.actualReturnedAt,
    });
    expect(instance.service.getSnapshot().walletCoins).toBe(walletCoins);
  });

  it('prepares and settles all three versioned routes, charges exact supplies, rolls back failures, and freezes complete equipment after it changes away', () => {
    const f = fixture();
    let failDeparture = false;
    let instance = f.open(repo => ({
      close: () => repo.close(),
      transaction: action => repo.transaction(tx => action(new Proxy(tx, {
        get(target,key) {
          if (key === 'appendOutbox' && failDeparture) return event => {
            if (event.type === 'TripStarted') throw new Error('injected prepared departure failure');
            return target.appendOutbox(event);
          };
          const value = Reflect.get(target,key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }));
    const petId = 'pet-1';
    const catalog = readTravelCatalog(instance.service).travelCatalog;
    expect(catalog.routes.map(route => route.routeId)).toEqual([DEMO_ROUTE.routeId,'mist-forest','starfall-ruins']);
    expect(catalog.supplyStock).toEqual([{ itemId:'healing-potion', quantity:0 },{ itemId:'ration',quantity:0 }]);
    const depart = (intent,id) => {
      const quote = readTravelPreview(instance.service,intent);
      expect(quote.travelPreview.eligible).toBe(true);
      const raw = f.command('TRIP_START_PREPARED',intent,id,quote.snapshot.revision);
      return { raw, snapshot:expectSuccess(f.request(instance.service,raw)) };
    };
    const commerce = (type,body,id) => f.command(type,{...body,catalogVersion:ITEM_CATALOG_VERSION},id,instance.service.getSnapshot().revision);
    const buy = (offerId,quantity,id) => expectSuccess(f.request(instance.service,commerce('SHOP_PURCHASE',{offerId,quantity},id)));

    const early = readTravelPreview(instance.service,payload(petId,'mist-forest'));
    expect(early.travelPreview.reasons.map(reason=>reason.code)).toEqual(expect.arrayContaining(['LEVEL_TOO_LOW','MISSING_REQUIRED_SUPPLY','SUPPLY_OUT_OF_STOCK']));
    expect(f.request(instance.service,f.command('TRIP_START_PREPARED',payload(petId,'mist-forest'),'blocked-forest',early.snapshot.revision)))
      .toMatchObject({ok:false,error:{code:'BUSINESS_RULE'}});
    const first = depart(payload(petId,DEMO_ROUTE.routeId),'prepared-meadow');
    const firstId = first.snapshot.pets[0].trip.tripId;
    expect(first.snapshot.pets[0].energy).toBe(85);
    const meadowLoadout = instance.repo.transaction(tx=>tx.getTripDepartureLoadout(firstId));
    expect(meadowLoadout).toMatchObject({ energyCost10:150, level:1, battlePower:30, supplies:[], equipment:[] });
    f.advance(initialTime + minutes(15));
    const meadowReport = readTravelReports(instance.service).travelReports.rows[0];
    expect(meadowReport).toMatchObject({tripId:firstId,loadout:meadowLoadout,actualReturnedAt:initialTime+minutes(15)});
    expect(instance.service.getSnapshot().walletCoins).toBe(8);
    buy('shop-ration',1,'forest-ration');
    // Synthetic high-level fixtures avoid replaying dozens of identical low-
    // level trips just to exercise later entry gates. Actual trip/economy
    // state changes below all go through the production service and SQLite.
    instance.repo.transaction(tx=>tx.savePet({...tx.getPet(petId),xp:cumulativeXpAtLevel(4)}));
    const forestIntent = payload(petId,'mist-forest',[{itemId:'ration',quantity:1}]);
    const forestPreview = readTravelPreview(instance.service,forestIntent);
    expect(forestPreview.travelPreview).toMatchObject({eligible:true,energyCost10:300,durationMs:minutes(60),supplyConsumption:[{itemId:'ration',quantity:1}]});
    const forestCommand = f.command('TRIP_START_PREPARED',forestIntent,'prepared-forest',forestPreview.snapshot.revision);
    const durable = () => instance.repo.transaction(tx=>({pet:tx.getPet(petId),home:tx.getHomeSchedule(petId),trips:tx.listTrips(),
      supplies:tx.listInventory(),preferences:tx.getPreferences(),receipt:tx.getCommandReceipt(forestCommand.commandId),outbox:tx.listOutbox(0,100)}));
    const before = durable();
    failDeparture = true;
    expect(f.request(instance.service,forestCommand)).toMatchObject({ok:false,error:{code:'INTERNAL_ERROR'}});
    expect(durable()).toEqual(before);
    failDeparture = false;
    const forest = expectSuccess(f.request(instance.service,forestCommand));
    const forestId = forest.pets[0].trip.tripId;
    expect(forest.pets[0]).toMatchObject({presence:'AWAY',energy:55,trip:{routeId:'mist-forest',expectedReturnAt:initialTime+minutes(75)}});
    expect(instance.repo.transaction(tx=>tx.listInventory().find(row=>row.itemId==='ration').quantity)).toBe(0);
    const forestLoadout = instance.repo.transaction(tx=>tx.getTripDepartureLoadout(forestId));
    expect(forestLoadout).toMatchObject({energyCost10:300,level:4,supplies:[{itemId:'ration',quantity:1}]});
    expect(expectSuccess(f.request(instance.service,forestCommand))).toEqual(forest);
    expect(readTravelReports(instance.service).travelReports.total).toBe(1); // active forest excluded
    f.advance(initialTime + minutes(75));
    const forestReport = readTravelReports(instance.service).travelReports.rows[0];
    expect(forestReport).toMatchObject({tripId:forestId,loadout:forestLoadout,routeId:'mist-forest'});
    expect(forestReport.facts.at(-1).type).toBe('TRIP_RETURNED');

    // Rest naturally before the energy-50 route and set its fixture level.
    const ruinsStartAt = initialTime + minutes(255);
    f.advance(ruinsStartAt);
    instance.service.getSnapshot();
    instance.repo.transaction(tx=>tx.savePet({...tx.getPet(petId),xp:cumulativeXpAtLevel(10)}));
    expect(instance.service.getSnapshot().pets[0].energy).toBe(100);
    buy('shop-ration',2,'ruins-rations');
    buy('shop-healing-potion',1,'ruins-medicine');
    buy('shop-apprentice-staff',1,'ruins-staff');
    const staff = instance.repo.transaction(tx=>tx.getCommerceOperation('ruins-staff').instanceIds[0]);
    expectSuccess(f.request(instance.service,commerce('EQUIPMENT_EQUIP',{petId,slot:'WEAPON',instanceId:staff},'equip-ruins-staff')));
    const beforeRuins = readInventory(instance.service).inventory.pets[0];
    const ruins = depart(payload(petId,'starfall-ruins',[{itemId:'ration',quantity:2},{itemId:'healing-potion',quantity:1}]),'prepared-ruins');
    const ruinsId = ruins.snapshot.pets[0].trip.tripId;
    expect(ruins.snapshot.pets[0]).toMatchObject({presence:'AWAY',energy:50,trip:{routeId:'starfall-ruins',expectedReturnAt:ruinsStartAt+minutes(240)}});
    const frozen = instance.repo.transaction(tx=>({trip:tx.getTrip(ruinsId).snapshot,loadout:tx.getTripDepartureLoadout(ruinsId)}));
    expect(frozen.loadout).toMatchObject({level:10,battlePower:beforeRuins.battlePower,stats:beforeRuins.stats,energyCost10:500,
      supplies:[{itemId:'healing-potion',quantity:1},{itemId:'ration',quantity:2}],
      equipment:[{slot:'WEAPON',instanceId:staff,definitionId:'apprentice-staff',definitionVersion:1,enhancement:0,bonus:{atk:4}}]});
    expect(frozen.trip.power).toBe(frozen.loadout.battlePower);
    expect(instance.repo.transaction(tx=>tx.listInventory().filter(row=>row.itemId==='ration'||row.itemId==='healing-potion')))
      .toEqual([{itemId:'healing-potion',quantity:0},{itemId:'ration',quantity:0}]);
    const busy = readTravelPreview(instance.service,payload(petId,'starfall-ruins',[{itemId:'ration',quantity:2},{itemId:'healing-potion',quantity:1}]));
    expect(busy.travelPreview.eligible).toBe(false);
    expect(busy.travelPreview.reasons.map(reason=>reason.code)).toEqual(expect.arrayContaining(['PET_NOT_HOME','ACTIVE_TRIP','SUPPLY_OUT_OF_STOCK']));
    expectSuccess(f.request(instance.service,commerce('EQUIPMENT_UNEQUIP',{petId,slot:'WEAPON'},'ruins-release-in-flight')));
    expectSuccess(f.request(instance.service,commerce('EQUIPMENT_SALVAGE',{instanceId:staff,expectedEnhancement:0},'ruins-salvage-in-flight')));
    expect(instance.repo.transaction(tx=>tx.getItemInstance(staff))).toBeNull();
    expect(instance.repo.transaction(tx=>({trip:tx.getTrip(ruinsId).snapshot,loadout:tx.getTripDepartureLoadout(ruinsId)}))).toEqual(frozen);
    instance.close();
    instance=f.open();
    expect(expectSuccess(f.request(instance.service,ruins.raw))).toEqual(ruins.snapshot);
    expect(instance.repo.transaction(tx=>tx.getTripDepartureLoadout(ruinsId))).toEqual(frozen.loadout);
    f.advance(ruinsStartAt+minutes(240));
    const reports=readTravelReports(instance.service).travelReports;
    expect(reports.total).toBe(3);
    expect(reports.rows.map(report=>report.tripId)).toEqual([ruinsId,forestId,firstId]);
    expect(reports.rows[0]).toMatchObject({tripId:ruinsId,loadout:frozen.loadout,departurePower:frozen.trip.power});
    expect(reports.rows[0].facts).toEqual(instance.repo.transaction(tx=>tx.listTripFacts(ruinsId)));
    expect(reports.rows[0].rewards).toEqual(instance.repo.transaction(tx=>tx.listRewards(ruinsId).map(({kind,targetId,amount})=>({kind,targetId,amount}))));
    expect(readTravelReports(instance.service,{petId,offset:1,limit:1}).travelReports.rows).toEqual([reports.rows[1]]);
    const read=f.command('TRIP_REPORT_READ',{petId,tripId:ruinsId},'ruins-report-read');
    const marked=expectSuccess(f.request(instance.service,read));
    const markedReport=readTravelReports(instance.service).travelReports.rows[0];
    expect(markedReport).toEqual({...reports.rows[0],readAt:ruinsStartAt+minutes(240)});
    instance.close(); instance=f.open();
    expect(readTravelReports(instance.service).travelReports.rows[0]).toEqual(markedReport);
    expect(expectSuccess(f.request(instance.service,read))).toEqual(marked);
    expect(expectSuccess(f.request(instance.service,first.raw))).toEqual(first.snapshot);
    instance.close();
  });

  it('uses actual return time and stable trip ID tie-break for two pets, with bounded filtered pages', () => {
    const f=fixture(); const instance=f.open();
    const trips=[];
    // The still-supported legacy meadow intent also obtains a full v6 loadout.
    for(const petId of ['pet-1','pet-2']) {
      const start=expectSuccess(f.request(instance.service,f.command('TRIP_START',{petId,routeId:DEMO_ROUTE.routeId})));
      trips.push(start.pets.find(pet=>pet.petId===petId).trip.tripId);
    }
    expect(readTravelReports(instance.service).travelReports.total).toBe(0);
    f.advance(initialTime+minutes(15));
    const all=readTravelReports(instance.service).travelReports;
    expect(all.rows.map(report=>report.tripId)).toEqual([...trips].sort());
    expect(all.rows.map(report=>report.actualReturnedAt)).toEqual([initialTime+minutes(15),initialTime+minutes(15)]);
    expect(all.rows.every(report=>report.loadout!==null)).toBe(true);
    expect(readTravelReports(instance.service,{offset:1,limit:1}).travelReports.rows).toEqual([all.rows[1]]);
    expect(readTravelReports(instance.service,{petId:'pet-2',offset:0,limit:1}).travelReports.rows.map(report=>report.petId)).toEqual(['pet-2']);
    expect(readTravelReports(instance.service,{offset:9999,limit:20}).travelReports).toMatchObject({total:2,offset:9999,rows:[]});
    instance.close();
  });
});
