import { describe, expect, it } from 'vitest';
import { CONTRACT_SCHEMA_VERSION, ipcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, DomainCommand, DomainEvent, GalleryPage, GalleryQuery } from '@pet-desktop/contracts';
import { DEMO_ROUTE } from '@pet-desktop/domain';
import { findBuiltinCg } from '@pet-desktop/domain/cg-catalog';
import type { TripFact } from '@pet-desktop/domain';
import { AppService } from '../src/app-service.js';
import type {
  AppRepository, AppRuntime, AppTransaction, CgUnlock, CgUnlockInput, CommandOutcome, CommandReceipt,
  InventoryItem, OutboxRecord, PetRecord, PreferencesRecord, RewardLine, SettlementRecord, TripCgAssetPin, TripRecord,
} from '../src/ports.js';

const MINUTE = 60_000;
const START = 1_000;
const OFFLINE_72H = 72 * 60 * MINUTE;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface MemoryState {
  preferences: PreferencesRecord | null;
  pets: PetRecord[];
  trips: TripRecord[];
  facts: TripFact[];
  settlements: SettlementRecord[];
  rewards: RewardLine[];
  wallet: number;
  inventory: InventoryItem[];
  cgs: CgUnlock[];
  cgPins: TripCgAssetPin[];
  receipts: CommandReceipt[];
  outbox: OutboxRecord[];
}

function emptyState(): MemoryState {
  return { preferences: null, pets: [], trips: [], facts: [], settlements: [], rewards: [],
    wallet: 0, inventory: [], cgs: [], cgPins: [], receipts: [], outbox: [] };
}

/** A transactional fake with value semantics, intentionally independent of SQL. */
class MemoryRepository implements AppRepository, AppTransaction {
  state: MemoryState;
  failOnEvent: string | null = null;
  closed = false;

  constructor(state: MemoryState = emptyState()) { this.state = copy(state); }

  transaction<T>(action: (tx: AppTransaction) => T): T {
    if (this.closed) throw new Error('Repository closed');
    const before = copy(this.state);
    try {
      return action(this);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  close(): void { this.closed = true; }
  getPreferences(): PreferencesRecord | null { return copy(this.state.preferences); }
  savePreferences(record: PreferencesRecord): void { this.state.preferences = copy(record); }
  listPets(): PetRecord[] { return copy(this.state.pets); }
  getPet(petId: string): PetRecord | null { return copy(this.state.pets.find((pet) => pet.petId === petId) ?? null); }
  savePet(pet: PetRecord): void {
    const index = this.state.pets.findIndex((entry) => entry.petId === pet.petId);
    if (index === -1) this.state.pets.push(copy(pet));
    else this.state.pets[index] = copy(pet);
  }
  listTrips(): TripRecord[] { return copy(this.state.trips); }
  getTrip(tripId: string): TripRecord | null {
    return copy(this.state.trips.find((trip) => trip.snapshot.tripId === tripId) ?? null);
  }
  insertTrip(trip: TripRecord): void {
    if (this.getTrip(trip.snapshot.tripId) !== null) throw new Error('Duplicate trip');
    if (this.state.trips.some((entry) => entry.status === 'TRAVELING' && entry.snapshot.petId === trip.snapshot.petId)) {
      throw new Error('Duplicate active trip');
    }
    this.state.trips.push(copy(trip));
  }
  updateTrip(trip: TripRecord): void {
    const index = this.state.trips.findIndex((entry) => entry.snapshot.tripId === trip.snapshot.tripId);
    if (index < 0) throw new Error('Missing trip');
    this.state.trips[index] = copy(trip);
  }
  appendTripFacts(tripId: string, facts: readonly TripFact[]): void {
    for (const fact of facts) {
      if (fact.tripId !== tripId || fact.sequence !== this.listTripFacts(tripId).length + 1) throw new Error('Unexpected fact');
      this.state.facts.push(copy(fact));
    }
  }
  listTripFacts(tripId: string): TripFact[] { return copy(this.state.facts.filter((fact) => fact.tripId === tripId)); }
  getSettlement(tripId: string): SettlementRecord | null {
    return copy(this.state.settlements.find((entry) => entry.tripId === tripId) ?? null);
  }
  insertSettlement(settlement: SettlementRecord): boolean {
    if (this.getSettlement(settlement.tripId) !== null) return false;
    this.state.settlements.push(copy(settlement));
    return true;
  }
  insertReward(line: RewardLine): boolean {
    if (this.state.rewards.some((entry) => entry.rewardKey === line.rewardKey)) return false;
    this.state.rewards.push(copy(line));
    return true;
  }
  listRewards(sourceId: string): RewardLine[] { return copy(this.state.rewards.filter((line) => line.sourceId === sourceId)); }
  getWalletCoins(): number { return this.state.wallet; }
  setWalletCoins(coins: number): void { this.state.wallet = coins; }
  listInventory(): InventoryItem[] { return copy(this.state.inventory); }
  addInventory(itemId: string, quantity: number): void {
    const existing = this.state.inventory.find((entry) => entry.itemId === itemId);
    if (existing === undefined) this.state.inventory.push({ itemId, quantity });
    else existing.quantity += quantity;
  }
  insertTripCgAssetPin(pin: TripCgAssetPin): void {
    const existing = this.state.cgPins.find((entry) => entry.tripId === pin.tripId && entry.cgId === pin.cgId && entry.variant === pin.variant);
    if (existing) throw new Error('Duplicate trip CG pin');
    this.state.cgPins.push(copy(pin));
  }
  listTripCgAssetPins(tripId: string): TripCgAssetPin[] { return copy(this.state.cgPins.filter((pin) => pin.tripId === tripId)); }
  getCgUnlock(petId: string, cgId: string, variant: string): CgUnlock | null {
    return copy(this.state.cgs.find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant) ?? null);
  }
  listCgUnlocks(petId: string): CgUnlock[] { return copy(this.state.cgs.filter((cg) => cg.petId === petId)); }
  unlockCg(unlock: CgUnlockInput): boolean {
    if (this.getCgUnlock(unlock.petId, unlock.cgId, unlock.variant) !== null) return false;
    const pin = this.state.cgPins.find((entry) => entry.tripId === unlock.sourceTripId && entry.petId === unlock.petId
      && entry.cgId === unlock.cgId && entry.variant === unlock.variant);
    this.state.cgs.push(copy({ ...unlock, assetRef: pin?.assetRef ?? { state: 'LEGACY_UNVERSIONED' },
      historicalCharacterId: pin?.characterId ?? null, historicalEventDefId: pin?.eventDefId ?? null,
      favorite: false, viewedAt: null }));
    return true;
  }
  setCgFavorite(petId: string, cgId: string, variant: string, favorite: boolean): boolean {
    const existing = this.state.cgs.find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant);
    if (!existing) throw new Error('Missing CG');
    if (existing.favorite === favorite) return false;
    existing.favorite = favorite;
    return true;
  }
  markCgViewed(petId: string, cgId: string, variant: string, characterId: string, eventDefId: string,
    assetVersion: string, assetHash: string, viewedAt: number): boolean {
    const existing = this.state.cgs.find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant);
    const ref = existing?.assetRef;
    if (!existing || ref?.state !== 'PINNED' || ref.characterId !== characterId || ref.eventDefId !== eventDefId
      || ref.assetVersion !== assetVersion || ref.assetHash !== assetHash) throw new Error('Missing historical CG');
    if (existing.viewedAt !== null) return false;
    existing.viewedAt = viewedAt;
    return true;
  }
  getCommandReceipt(commandId: string): CommandReceipt | null {
    return copy(this.state.receipts.find((entry) => entry.commandId === commandId) ?? null);
  }
  hasCommandReceipts(): boolean { return this.state.receipts.length > 0; }
  saveCommandReceipt(receipt: CommandReceipt): void {
    if (this.getCommandReceipt(receipt.commandId) !== null) throw new Error('Duplicate receipt');
    this.state.receipts.push(copy(receipt));
  }
  appendOutbox(event: DomainEvent): void {
    if (this.failOnEvent === event.type) throw new Error('fixture secret: simulated transaction failure');
    this.state.outbox.push({ seq: this.state.outbox.length + 1, event: copy(event) });
  }
  listOutbox(afterSeq: number, limit: number): OutboxRecord[] {
    return copy(this.state.outbox.filter((entry) => entry.seq > afterSeq).slice(0, limit));
  }
}

class FakeRuntime implements AppRuntime {
  at = START;
  nextSeed = 8;
  private serial = 0;
  now(): number { return this.at; }
  seed(): number { return this.nextSeed; }
  createId(kind: 'trip' | 'event' | 'request'): string { return `${kind}-${++this.serial}`; }
}

function fixture() {
  const repo = new MemoryRepository();
  const runtime = new FakeRuntime();
  const service = new AppService(repo, runtime);
  return { repo, runtime, service };
}

function command<T extends DomainCommand['type']>(commandId: string, type: T,
  payload: Extract<DomainCommand, { type: T }>['payload'], extra: { expectedRevision?: number; issuedAt?: number } = {}): DomainCommand {
  return { commandId, type, payload, issuedAt: 0, ...extra } as DomainCommand;
}

function success(outcome: CommandOutcome): AppSnapshot {
  if (!outcome.ok) throw new Error(`Expected command success, got ${outcome.error.code}`);
  return outcome.snapshot;
}

function depart(service: AppService, petId = 'pet-1', id = 'depart-1') {
  const app = success(service.dispatch(command(id, 'TRIP_START', { petId, routeId: DEMO_ROUTE.routeId })));
  return app.pets.find((pet) => pet.petId === petId)!.trip!.tripId;
}

const galleryQuery: GalleryQuery = { filter: 'ALL', offset: 0, limit: 50 };

function requestGallery(service: AppService, query: GalleryQuery = galleryQuery): { snapshot: AppSnapshot; gallery: GalleryPage } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'gallery-read', method: 'gallery/list', payload: query });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('gallery' in result)) throw new Error('Expected revisioned gallery result');
  expect(result.gallery.revision).toBe(result.snapshot.revision);
  return { snapshot: result.snapshot, gallery: result.gallery };
}

describe('application service request boundary', () => {
  it('atomically replaces the V1 visible companion slot without changing presence or primary pet', () => {
    const { service } = fixture();
    const tripId = depart(service, 'pet-1', 'slot-trip');
    const visible = success(service.dispatch(command('slot-swap', 'PET_SET_VISIBILITY', { petId: 'pet-2', visibility: 'VISIBLE' })));
    expect(visible.primaryPetId).toBe('pet-1');
    expect(visible.pets[0]).toMatchObject({ petId: 'pet-1', presence: 'AWAY', visibility: 'HIDDEN', trip: { tripId } });
    expect(visible.pets[1]).toMatchObject({ petId: 'pet-2', presence: 'HOME', visibility: 'VISIBLE' });
    expect(visible.pets.filter((pet) => pet.visibility === 'VISIBLE')).toHaveLength(1);
    expect(success(service.dispatch(command('slot-swap', 'PET_SET_VISIBILITY', { petId: 'pet-2', visibility: 'VISIBLE' })))).toEqual(visible);
  });

  it('initializes both demo pets and validates envelopes, preserving valid request IDs', () => {
    const { service, repo, runtime } = fixture();
    const app = service.getSnapshot();
    expect(app).toMatchObject({ revision: 0, primaryPetId: 'pet-1', walletCoins: 0, doNotDisturb: false, pausedRender: false });
    expect(app.pets.map(({ presence, energy, visibility }) => [presence, energy, visibility]))
      .toEqual([['HOME', 100, 'VISIBLE'], ['HOME', 100, 'HIDDEN']]);
    expect(repo.state.pets.map((p) => p.energy10)).toEqual([1000, 1000]);
    const valid = { schemaVersion: CONTRACT_SCHEMA_VERSION, method: 'snapshot/get', requestId: 'read-1', payload: {} };
    expect(service.handleRequest(valid)).toEqual({ schemaVersion: 1, ok: true, requestId: 'read-1', snapshot: app });
    const invalid = service.handleRequest({ ...valid, payload: { extraneous: true } });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', requestId: 'read-1' } });
    const invalidId = service.handleRequest({ ...valid, requestId: '<invalid>' });
    expect(invalidId).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', requestId: 'request-1' } });
    expect(ipcResultSchema.safeParse(invalidId).success).toBe(true);
    runtime.at += MINUTE;
    expect(service.handleRequest({ ...valid, schemaVersion: -1 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(repo.state.preferences!.logicalTime).toBe(START); // malformed requests cannot advance game time
    service.close();
    service.close();
    expect(service.handleRequest(valid)).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('returns exact historical receipts independent of key order, clock or IPC request ID', () => {
    const { service, repo, runtime } = fixture();
    const first = command('pet-once', 'PET_INTERACT', { petId: 'pet-1', interaction: 'PET' });
    const outcome = service.dispatch(first);
    expect(success(outcome).pets[0]).toMatchObject({ moodScore: 55, bond: 1, revision: 1 });
    depart(service);
    const previous = copy(repo.state);
    runtime.at += OFFLINE_72H;
    const reordered = { payload: { interaction: 'PET', petId: 'pet-1' }, type: 'PET_INTERACT', issuedAt: 0, commandId: 'pet-once' };
    for (let i = 0; i < 100; i++) {
      expect(service.handleRequest({ schemaVersion: 1, method: 'command/dispatch', requestId: `retry-${i}`,
        payload: { command: reordered } })).toEqual({ schemaVersion: 1, ok: true, requestId: `retry-${i}`, snapshot: success(outcome) });
    }
    expect(service.dispatch({ ...first, issuedAt: 1 })).toMatchObject({ ok: false, error: { code: 'COMMAND_CONFLICT' } });
    expect(repo.state).toEqual(previous); // even an overdue unrelated trip isn't replayed by a duplicate
    expect(service.getSnapshot().pets[0]!.presence).toBe('HOME');
  });

  it('persists business and stale-revision rejections without applying their effects', () => {
    const { service, repo, runtime } = fixture();
    depart(service);
    const original = service.getSnapshot();
    const denied = command('away-pet', 'PET_INTERACT', { petId: 'pet-1', interaction: 'PET' });
    expect(service.dispatch(denied)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.getCommandReceipt(denied.commandId)).not.toBeNull();
    expect(service.getSnapshot()).toEqual(original);
    runtime.at = START + 3 * MINUTE;
    // A scheduled event precedes a command with the same logical time.
    const stale = command('stale', 'PET_SELECT', { petId: 'pet-2' }, { expectedRevision: original.revision });
    expect(service.dispatch(stale)).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    const progressed = service.getSnapshot();
    expect(progressed.revision).toBeGreaterThan(original.revision);
    expect(progressed.primaryPetId).toBe('pet-1');
    expect(repo.state.facts.map((fact) => fact.type)).toEqual(['GATHER_RESOLVED']);
    runtime.at += OFFLINE_72H;
    expect(service.getSnapshot().pets[0]!.presence).toBe('HOME');
    expect(service.dispatch(denied)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(service.dispatch(stale)).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(success(service.dispatch(command('select-fresh', 'PET_SELECT', { petId: 'pet-2' }))).primaryPetId).toBe('pet-2');
  });
});

describe('pet and trip use cases', () => {
  it('keeps selection, visibility, modes, interactions and actual presence independent', () => {
    const { service, repo, runtime } = fixture();
    const tripId = depart(service);
    expect(service.getSnapshot().pets[0]).toMatchObject({ presence: 'AWAY', activity: null, energy: 85, visibility: 'VISIBLE' });
    expect(repo.getPet('pet-1')!.energy10).toBe(850);
    expect(repo.getTrip(tripId)!.snapshot.startAt).toBe(START); // ignores renderer issuedAt=0
    const initial = service.getSnapshot();
    expect(service.dispatch(command('start-again', 'TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(service.dispatch(command('away-rest', 'PET_INTERACT', { petId: 'pet-1', interaction: 'REST' })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(service.dispatch(command('report-early', 'TRIP_REPORT_READ', { petId: 'pet-1', tripId })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(service.getSnapshot()).toEqual(initial);
    expect(service.dispatch(command('wrong-pet', 'TRIP_RECALL', { petId: 'pet-2', tripId })))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    success(service.dispatch(command('select', 'PET_SELECT', { petId: 'pet-2' })));
    success(service.dispatch(command('hide', 'PET_SET_VISIBILITY', { petId: 'pet-1', visibility: 'HIDDEN' })));
    success(service.dispatch(command('mute', 'APP_SET_MODE', { flag: 'doNotDisturb', enabled: true })));
    const paused = success(service.dispatch(command('pause', 'APP_SET_MODE', { flag: 'pausedRender', enabled: true })));
    expect(paused).toMatchObject({ primaryPetId: 'pet-2', doNotDisturb: true, pausedRender: true });
    expect(paused.pets[0]).toMatchObject({ presence: 'AWAY', energy: 85, visibility: 'HIDDEN' });
    expect(paused.pets[1]).toMatchObject({ visibility: 'HIDDEN', revision: 0, presence: 'HOME' });

    runtime.at = START + 3 * MINUTE;
    const returning = success(service.dispatch(command('recall', 'TRIP_RECALL', { petId: 'pet-1', tripId }, { issuedAt: START + OFFLINE_72H })));
    expect(returning.pets[0]).toMatchObject({ presence: 'RETURNING', activity: null,
      trip: { status: 'TRAVELING', expectedReturnAt: START + 6 * MINUTE } });
    expect(repo.listTripFacts(tripId).map((fact) => fact.type)).toEqual(['GATHER_RESOLVED', 'RETURNING']);
    expect(success(service.dispatch(command('recall-again', 'TRIP_RECALL', { petId: 'pet-1', tripId })))).toEqual(returning);
    expect(repo.getWalletCoins()).toBe(0);
    expect(repo.listInventory()).toEqual([]);
    runtime.at = START + OFFLINE_72H;
    const home = service.getSnapshot();
    expect(home.pets[0]).toMatchObject({ presence: 'HOME', activity: 'IDLE', xp: 4,
      energy: 85, visibility: 'HIDDEN', trip: { tripId, status: 'SETTLED', expectedReturnAt: START + 6 * MINUTE } });
    expect(home.primaryPetId).toBe('pet-2');
    expect(repo.getSettlement(tripId)).toMatchObject({ settledAt: START + 6 * MINUTE, rewards: { xp: 4, coins: 0 } });
    expect(repo.getTrip(tripId)!.reportReadAt).toBeNull();
    const reported = success(service.dispatch(command('report', 'TRIP_REPORT_READ', { petId: 'pet-1', tripId })));
    expect(repo.getTrip(tripId)!.reportReadAt).toBe(runtime.at);
    expect(success(service.dispatch(command('report-again', 'TRIP_REPORT_READ', { petId: 'pet-1', tripId })))).toEqual(reported);
    const rested = success(service.dispatch(command('rest', 'PET_INTERACT', { petId: 'pet-1', interaction: 'REST' })));
    expect(rested.pets[0]).toMatchObject({ energy: 100, activity: 'REST' });
    expect(repo.listInventory()).toEqual([{ itemId: 'herb', quantity: 1 }]);
    expect(repo.listRewards(tripId)).toHaveLength(2);
  });

  it('rejects insufficient energy and clamps repeated interactions to fixed-point bounds', () => {
    const { service, repo, runtime } = fixture();
    repo.savePet({ ...repo.getPet('pet-1')!, energy10: 149 });
    const denied = command('no-energy', 'TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId });
    expect(service.dispatch(denied)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.getPet('pet-1')!.energy10).toBe(149);
    for (let i = 0; i < 110; i++) success(service.dispatch(command(`pet-${i}`, 'PET_INTERACT', { petId: 'pet-1', interaction: 'PET' })));
    expect(repo.getPet('pet-1')).toMatchObject({ moodScore10: 1000, bond10: 1000 });
    success(service.dispatch(command('rest-1', 'PET_INTERACT', { petId: 'pet-1', interaction: 'REST' })));
    expect(repo.getPet('pet-1')!.energy10).toBe(349);
    const tripId = depart(service);
    expect(repo.getPet('pet-1')!.energy10).toBe(199);
    expect(repo.getTrip(tripId)!.snapshot.startAt).toBe(runtime.at);
    expect(repo.getTrip(tripId)!.checkpoint.sequence).toBe(0);
  });

  it('clamps a system clock rollback, including recall, and advances neither revision nor reward for empty ticks', () => {
    const { service, runtime, repo } = fixture();
    const tripId = depart(service);
    runtime.at = START + 5 * MINUTE;
    const progress = service.getSnapshot();
    runtime.at = START + 6 * MINUTE;
    expect(service.getSnapshot()).toEqual(progress);
    expect(repo.getTrip(tripId)!.checkpoint.logicalTime).toBe(runtime.at);
    runtime.at = START + MINUTE;
    expect(service.getSnapshot()).toEqual(progress);
    expect(repo.getPreferences()!.logicalTime).toBe(START + 6 * MINUTE);
    const returning = success(service.dispatch(command('recall', 'TRIP_RECALL', { petId: 'pet-1', tripId })));
    expect(returning.pets[0]!.trip!.expectedReturnAt).toBe(START + 9 * MINUTE);
    expect(repo.getTrip(tripId)!.checkpoint.logicalTime).toBe(START + 6 * MINUTE);
    runtime.at = START + 9 * MINUTE;
    expect(service.getSnapshot().pets[0]).toMatchObject({ presence: 'HOME', xp: 4 });
    expect(repo.getSettlement(tripId)!.settledAt).toBe(runtime.at);
  });

  it('retains the early return time in a defeated trip summary without rewriting its nominal itinerary', () => {
    const { service, runtime, repo } = fixture();
    runtime.nextSeed = 4;
    const tripId = depart(service);
    runtime.at = START + 8 * MINUTE;
    expect(service.getSnapshot().pets[0]).toMatchObject({ presence: 'RETURNING', trip: { expectedReturnAt: START + 11 * MINUTE } });
    runtime.at = START + OFFLINE_72H;
    expect(service.getSnapshot().pets[0]).toMatchObject({ presence: 'HOME', xp: 9,
      trip: { status: 'SETTLED', expectedReturnAt: START + 11 * MINUTE } });
    expect(repo.getTrip(tripId)!.snapshot.expectedReturnAt).toBe(START + 15 * MINUTE);
    expect(repo.getTrip(tripId)!.checkpoint.returnReason).toBe('DEFEATED');
  });
});

describe('deterministic, atomic offline settlement', () => {
  it('advances two pets in global due order and gets the same facts, events and ledger after restart', () => {
    function run(segmented: boolean): MemoryState {
      let { service, repo, runtime } = fixture();
      const trip1 = depart(service, 'pet-1', 'depart-1');
      runtime.at += MINUTE;
      const trip2 = depart(service, 'pet-2', 'depart-2');
      if (segmented) {
        for (const minute of [3, 4, 5, 8, 9, 12, 13, 15, 16]) {
          runtime.at = START + minute * MINUTE;
          service.getSnapshot();
          service.close();
          repo = new MemoryRepository(repo.state);
          service = new AppService(repo, runtime);
        }
      }
      runtime.at = START + OFFLINE_72H;
      expect(service.getSnapshot()).toMatchObject({ walletCoins: 16, pets: [
        { petId: 'pet-1', presence: 'HOME', xp: 24 }, { petId: 'pet-2', presence: 'HOME', xp: 24 },
      ] });
      expect(repo.state.settlements).toHaveLength(2);
      expect(repo.state.rewards).toHaveLength(10);
      expect(repo.state.cgs).toHaveLength(2);
      expect(repo.state.inventory).toEqual([{ itemId: 'herb', quantity: 2 }, { itemId: 'slime-gel', quantity: 2 }]);
      expect(repo.getSettlement(trip1)!.settledAt).toBe(START + 15 * MINUTE);
      expect(repo.getSettlement(trip2)!.settledAt).toBe(START + 16 * MINUTE);
      expect(repo.state.facts.map((fact) => fact.scheduledAt)).toEqual([...repo.state.facts.map((fact) => fact.scheduledAt)].sort((a, b) => a - b));
      const settled = copy(repo.state);
      service.getSnapshot();
      service.close();
      service = new AppService(new MemoryRepository(settled), runtime);
      expect(service.getSnapshot().walletCoins).toBe(16);
      return repo.state;
    }
    expect(run(true)).toEqual(run(false));
  });

  it('rejects plausible but forged checkpoint rewards and facts without overwriting them or settling another pet', () => {
    for (const corrupt of ['checkpoint', 'fact'] as const) {
      const { service, runtime, repo } = fixture();
      const tripId = depart(service);
      depart(service, 'pet-2', 'depart-2');
      runtime.at = START + 3 * MINUTE;
      service.getSnapshot();
      if (corrupt === 'checkpoint') {
        const trip = repo.getTrip(tripId)!;
        repo.updateTrip({ ...trip, checkpoint: { ...trip.checkpoint,
          rewardDraft: { ...trip.checkpoint.rewardDraft, xp: 5 } } });
      } else {
        const fact = repo.state.facts[0]!;
        if (fact.type !== 'GATHER_RESOLVED') throw new Error('Unexpected fixture');
        repo.state.facts[0] = { ...fact, payload: { ...fact.payload, quantity: 2 } };
      }
      const before = copy(repo.state);
      runtime.at += OFFLINE_72H;
      expect(service.handleRequest({ schemaVersion: 1, method: 'snapshot/get', requestId: 'corrupt-read', payload: {} }))
        .toEqual({ schemaVersion: 1, ok: false, error: { code: 'INTERNAL_ERROR',
          message: 'The application could not complete the operation.', retryable: true, requestId: 'corrupt-read' } });
      expect(repo.state).toEqual(before);
      service.close();
      const reopened = new MemoryRepository(repo.state);
      expect(() => new AppService(reopened, runtime)).toThrow();
      expect(reopened.state).toEqual(before);
    }
  });

  it('rejects inconsistent settled report data rather than treating it as a new reward claim', () => {
    const { service, runtime, repo } = fixture();
    const tripId = depart(service);
    runtime.at += OFFLINE_72H;
    service.getSnapshot();
    const existing = repo.state.rewards[0]!;
    repo.state.rewards[0] = { ...existing, amount: existing.amount + 1 };
    const before = copy(repo.state);
    expect(service.dispatch(command('corrupt-report', 'TRIP_REPORT_READ', { petId: 'pet-1', tripId })))
      .toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
    expect(repo.getTrip(tripId)!.reportReadAt).toBeNull();
    expect(repo.getCommandReceipt('corrupt-report')).toBeNull();
    service.close();
    const reopened = new MemoryRepository(repo.state);
    expect(() => new AppService(reopened, runtime)).toThrow();
    expect(reopened.state).toEqual(before);
  });

  it('catches up all offline work on successful construction before any query or command', () => {
    const { service, runtime, repo } = fixture();
    const tripId = depart(service);
    runtime.at = START + 3 * MINUTE;
    success(service.dispatch(command('recall-before-restart', 'TRIP_RECALL', { petId: 'pet-1', tripId })));
    service.close();
    runtime.at = START + OFFLINE_72H;
    const reopened = new MemoryRepository(repo.state);
    const recovered = new AppService(reopened, runtime);
    expect(reopened.getPet('pet-1')).toMatchObject({ presence: 'HOME', xp: 4 });
    expect(reopened.getSettlement(tripId)!.settledAt).toBe(START + 6 * MINUTE);
    expect(reopened.getPreferences()!.logicalTime).toBe(runtime.at);
    expect(recovered.getSnapshot().pets[0]).toMatchObject({ presence: 'HOME', trip: { expectedReturnAt: START + 6 * MINUTE } });
  });

  it('rolls back all facts, balances, receipts, unlocks and outbox on a late failure, then safely retries', () => {
    const { service, runtime, repo } = fixture();
    const tripId = depart(service);
    const before = copy(repo.state);
    const next = command('recover-select', 'PET_SELECT', { petId: 'pet-2' });
    runtime.at += OFFLINE_72H;
    repo.failOnEvent = 'TripSettled';
    const failed = service.handleRequest({ schemaVersion: 1, method: 'command/dispatch', requestId: 'retry-fail', payload: { command: next } });
    expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', requestId: 'retry-fail' } });
    expect(JSON.stringify(failed)).not.toContain('fixture secret');
    expect(repo.state).toEqual(before);
    expect(repo.getCommandReceipt(next.commandId)).toBeNull();
    repo.failOnEvent = null;
    expect(success(service.dispatch(next))).toMatchObject({ walletCoins: 8, primaryPetId: 'pet-2', pets: [{ xp: 24 }, { xp: 0 }] });
    expect(repo.listRewards(tripId)).toHaveLength(5);
    expect(repo.state.outbox.filter((entry) => entry.event.type === 'TripSettled')).toHaveLength(1);
    const settled = copy(repo.state);
    service.dispatch(next);
    service.getSnapshot();
    expect(repo.state).toEqual(settled);
  });

  it('records repeated CG rewards by trip but unlocks each pet/variant only once', () => {
    const { service, runtime, repo } = fixture();
    const first = depart(service);
    runtime.at += 15 * MINUTE;
    service.getSnapshot();
    const second = depart(service, 'pet-1', 'depart-2');
    runtime.at += 15 * MINUTE;
    const app = service.getSnapshot();
    expect(app.pets[0]).toMatchObject({ xp: 48, trip: { tripId: second, status: 'SETTLED' } });
    expect(repo.getWalletCoins()).toBe(16);
    expect(repo.state.rewards.filter((line) => line.kind === 'CG')).toHaveLength(2);
    const pin = repo.listTripCgAssetPins(first)[0]!;
    expect(repo.listCgUnlocks('pet-1')).toEqual([{ petId: 'pet-1', cgId: 'morning-dew', variant: 'default', sourceTripId: first,
      unlockedAt: START + 15 * MINUTE, assetRef: pin.assetRef, historicalCharacterId: pin.characterId,
      historicalEventDefId: pin.eventDefId, favorite: false, viewedAt: null }]);
    expect(repo.state.outbox.filter((entry) => entry.event.type === 'CGUnlocked')).toHaveLength(1);
  });
});

describe('historical CG acquisition and gallery projection', () => {
  it('projects both pets with only locked metadata, has stable pagination, and filters on the authority', () => {
    const { service } = fixture();
    const { gallery } = requestGallery(service);
    expect(gallery.total).toBe(2);
    expect(gallery.rows.map((row) => [row.petId, row.characterId, row.unlockStatus])).toEqual([
      ['pet-1', 'star-singer', 'LOCKED'], ['pet-2', 'fluffy-ranger', 'LOCKED'],
    ]);
    for (const row of gallery.rows) {
      expect(Object.keys(row).sort()).toEqual([
        'petId', 'characterId', 'cgId', 'variant', 'title', 'hint', 'routeId', 'eventDefId', 'rarity', 'unlockStatus',
      ].sort());
    }
    expect(requestGallery(service, { ...galleryQuery, offset: 1, limit: 1 }).gallery.rows).toEqual([gallery.rows[1]]);
    expect(requestGallery(service, { ...galleryQuery, offset: 2, limit: 1 }).gallery.rows).toEqual([]);
    expect(requestGallery(service, { ...galleryQuery, petId: 'pet-2', characterId: 'fluffy-ranger', filter: 'LOCKED',
      routeId: DEMO_ROUTE.routeId, eventDefId: 'dew-postcard', rarity: 'COMMON' }).gallery.rows).toEqual([gallery.rows[1]]);
    expect(requestGallery(service, { ...galleryQuery, petId: 'pet-2', characterId: 'star-singer' }).gallery.total).toBe(0);
    expect(requestGallery(service, { ...galleryQuery, filter: 'FAVORITES' }).gallery.total).toBe(0);
    expect(service.handleRequest({ schemaVersion: 1, requestId: 'bad-pet', method: 'gallery/list',
      payload: { ...galleryQuery, petId: 'missing' } })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(service.handleRequest({ schemaVersion: 1, requestId: 'bad-page', method: 'gallery/list',
      payload: { ...galleryQuery, limit: 51 } })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('pins the exact CG identity at departure, then settles and queries it at one revision', () => {
    const { service, repo, runtime } = fixture();
    const tripId = depart(service);
    const entry = findBuiltinCg('star-singer', 'morning-dew')!;
    expect(entry.assetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(repo.listTripCgAssetPins(tripId)).toEqual([{
      tripId, petId: 'pet-1', characterId: 'star-singer', cgId: 'morning-dew', variant: 'default', eventDefId: 'dew-postcard',
      assetRef: { state: 'PINNED', characterId: 'star-singer', eventDefId: 'dew-postcard', assetVersion: entry.assetVersion, assetHash: entry.assetHash },
    }]);
    expect(requestGallery(service).gallery.rows[0]!.unlockStatus).toBe('LOCKED');
    runtime.at += 15 * MINUTE;
    // The query catches up the due trip and reflects the authoritative unlock
    // with exactly the same revision as the snapshot in its response.
    const result = requestGallery(service, { ...galleryQuery, filter: 'UNLOCKED' });
    expect(result.snapshot.pets[0]).toMatchObject({ presence: 'HOME', xp: 24 });
    expect(result.gallery.rows[0]).toMatchObject({ petId: 'pet-1', title: entry.title, hint: entry.hint,
      sourceTripId: tripId, unlockedAt: START + 15 * MINUTE, favorite: false, viewedAt: null,
      assetRef: repo.listTripCgAssetPins(tripId)[0]!.assetRef });
    expect(result.gallery.total).toBe(1);
    expect(result.gallery.rows[0]).not.toHaveProperty('caption');
    expect(result.gallery.rows[0]).not.toHaveProperty('image');
  });

  it('never replaces a missing acquisition version with the current picture', () => {
    const { service, repo, runtime } = fixture();
    const tripId = depart(service);
    // A realistic historical version not bundled in this build, frozen by the
    // earlier content release. This editing hook exists only in the test fake.
    const historicalRef = { state: 'PINNED' as const, assetVersion: '0.0.1', assetHash: '1'.repeat(64),
      characterId: 'star-singer', eventDefId: 'dew-postcard' };
    repo.state.cgPins[0]!.assetRef = historicalRef;
    runtime.at += 15 * MINUTE;
    const row = requestGallery(service, { ...galleryQuery, petId: 'pet-1' }).gallery.rows[0]!;
    expect(row).toMatchObject({ unlockStatus: 'UNLOCKED', title: '历史纪念画面', rarity: null, sourceTripId: tripId,
      assetRef: historicalRef });
    expect(row.title).not.toBe(findBuiltinCg('star-singer', 'morning-dew')!.title);
    const latest = findBuiltinCg('star-singer', 'morning-dew')!;
    expect(service.dispatch(command('view-wrong-version', 'CG_MARK_VIEWED', { petId: 'pet-1', cgId: latest.cgId, variant: latest.variant,
      characterId: latest.characterId, eventDefId: latest.eventDefId, assetVersion: latest.assetVersion, assetHash: latest.assetHash })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.getCgUnlock('pet-1', 'morning-dew', 'default')!.viewedAt).toBeNull();
  });

  it('preserves unavailable CG unlocks instead of erasing or mapping them to unrelated characters', () => {
    const { service, repo, runtime } = fixture();
    repo.savePet({ ...repo.getPet('pet-1')!, characterId: 'unreleased-character' });
    const tripId = depart(service);
    expect(repo.listTripCgAssetPins(tripId)[0]).toMatchObject({ characterId: 'unreleased-character',
      assetRef: { state: 'UNAVAILABLE_AT_DEPARTURE' } });
    runtime.at += 15 * MINUTE;
    const result = requestGallery(service, { ...galleryQuery, petId: 'pet-1' });
    expect(result.snapshot.walletCoins).toBe(8); // missing art cannot alter travel rewards
    expect(result.gallery.rows).toEqual([expect.objectContaining({ characterId: 'unreleased-character',
      eventDefId: 'dew-postcard', unlockStatus: 'UNLOCKED', assetRef: { state: 'UNAVAILABLE_AT_DEPARTURE' }, rarity: null })]);
    const favorite = command('unavailable-fav', 'CG_SET_FAVORITE', { petId: 'pet-1', cgId: 'morning-dew', variant: 'default', favorite: true });
    expect(service.dispatch(favorite).ok).toBe(true);
    expect(requestGallery(service, { ...galleryQuery, filter: 'FAVORITES' }).gallery.total).toBe(1);
    expect(service.dispatch(command('unavailable-view', 'CG_MARK_VIEWED', { petId: 'pet-1', cgId: 'morning-dew', variant: 'default',
      characterId: 'unreleased-character', eventDefId: 'dew-postcard', assetVersion: '1.0.0', assetHash: 'a'.repeat(64) })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
  });

  it('changes favorite and first-view only, with idempotent receipts and authoritative timestamps', () => {
    const { service, repo, runtime } = fixture();
    const keys = { petId: 'pet-1', cgId: 'morning-dew', variant: 'default' };
    expect(service.dispatch(command('locked-fav', 'CG_SET_FAVORITE', { ...keys, favorite: true })))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const tripId = depart(service);
    runtime.at += 15 * MINUTE;
    const original = service.getSnapshot();
    const rewards = repo.listRewards(tripId);
    const ref = repo.getCgUnlock(keys.petId, keys.cgId, keys.variant)!.assetRef;
    if (ref.state !== 'PINNED') throw new Error('Expected built-in CG pin');
    const viewPayload = { ...keys, characterId: ref.characterId, eventDefId: ref.eventDefId,
      assetVersion: ref.assetVersion, assetHash: ref.assetHash };
    expect(service.dispatch(command('other-pet-fav', 'CG_SET_FAVORITE', { ...keys, petId: 'pet-2', favorite: true })))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(service.dispatch(command('wrong-hash', 'CG_MARK_VIEWED', { ...viewPayload, assetHash: 'f'.repeat(64) })))
      .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    const favorite = command('favorite', 'CG_SET_FAVORITE', { ...keys, favorite: true });
    const favorited = success(service.dispatch(favorite));
    expect(favorited.revision).toBe(original.revision + 1);
    expect(success(service.dispatch(command('favorite-noop', 'CG_SET_FAVORITE', { ...keys, favorite: true })))).toEqual(favorited);
    runtime.at += 1_000;
    const viewedAt = runtime.at;
    const view = command('view-once', 'CG_MARK_VIEWED', viewPayload, { issuedAt: 0 });
    const viewed = success(service.dispatch(view));
    expect(viewed.revision).toBe(favorited.revision + 1);
    runtime.at += 2_000;
    expect(success(service.dispatch(command('view-noop', 'CG_MARK_VIEWED', viewPayload)))).toEqual(viewed);
    expect(success(service.dispatch(favorite))).toEqual(favorited); // original receipt stays immutable
    expect(success(service.dispatch(view))).toEqual(viewed);
    expect(repo.getCgUnlock(keys.petId, keys.cgId, keys.variant)).toMatchObject({ favorite: true, viewedAt });
    expect(requestGallery(service, { ...galleryQuery, filter: 'FAVORITES' }).gallery.rows[0]).toMatchObject({ favorite: true, viewedAt });
    expect(service.getSnapshot()).toEqual({ ...original, revision: viewed.revision });
    expect(repo.listRewards(tripId)).toEqual(rewards);
    expect(repo.state.outbox.filter((record) => record.event.type === 'CGFavoriteChanged')).toHaveLength(1);
    expect(repo.state.outbox.filter((record) => record.event.type === 'CGViewed')).toHaveLength(1);
  });
});
