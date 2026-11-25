import { describe, expect, it } from 'vitest';
import { CONTRACT_SCHEMA_VERSION, ipcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, CharacterCatalogPage, DomainCommand, DomainEvent, GalleryPage, GalleryQuery, InventoryPage } from '@pet-desktop/contracts';
import type { EquipmentSlot } from '@pet-desktop/contracts/inventory';
import type { TravelCatalog, TravelPreview, TravelReportsPage, TravelReportsQuery, TripDepartureLoadout, TripPreparationPayload } from '@pet-desktop/contracts/travel';
import { DEMO_ROUTE } from '@pet-desktop/domain';
import { findBuiltinCg } from '@pet-desktop/domain/cg-catalog';
import { CHARACTER_CATALOG_VERSION } from '@pet-desktop/domain/character-catalog';
import { HOME_RULES, advanceHomeState } from '@pet-desktop/domain/home-simulation';
import { ITEM_CATALOG_VERSION } from '@pet-desktop/domain/item-catalog';
import { ROUTE_CATALOG_VERSION } from '@pet-desktop/domain/route-catalog';
import { cumulativeXpAtLevel } from '@pet-desktop/domain/progression';
import type { TripFact } from '@pet-desktop/domain';
import type { EventHistoryEntry, FrozenEventOccurrence } from '@pet-desktop/domain/event-engine';
import type { EventListQuery } from '@pet-desktop/contracts/events';
import type { EventPolicy } from '../src/event-service.js';
import { AppService } from '../src/app-service.js';
import type {
  AppRepository, AppRuntime, AppTransaction, CgUnlock, CgUnlockInput, CommandOutcome, CommandReceipt,
  CommerceOperationRecord, HomeScheduleRecord, InventoryItem, ItemInstanceRecord, OutboxRecord, PetAcquisitionRecord, PetEquipmentRecord, PetRecord, PreferencesRecord, RewardLine, SettlementRecord, TripCgAssetPin, TripDepartureLoadoutRecord, TripRecord,
  EventCgUnlock, EventFinalizationRecord, EventOccurrenceRecord, EventTriggerReceipt,
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
  acquisitions: PetAcquisitionRecord[];
  homeSchedules: HomeScheduleRecord[];
  trips: TripRecord[];
  requiredDepartureLoadouts: string[];
  departureLoadouts: TripDepartureLoadoutRecord[];
  facts: TripFact[];
  settlements: SettlementRecord[];
  rewards: RewardLine[];
  wallet: number;
  inventory: InventoryItem[];
  itemInstances: ItemInstanceRecord[];
  retiredItemIds: string[];
  equipment: PetEquipmentRecord[];
  commerceOperations: CommerceOperationRecord[];
  cgs: CgUnlock[];
  cgPins: TripCgAssetPin[];
  eventTriggers: EventTriggerReceipt[];
  occurrences: EventOccurrenceRecord[];
  eventCgs: EventCgUnlock[];
  receipts: CommandReceipt[];
  outbox: OutboxRecord[];
}

function emptyState(): MemoryState {
  return { preferences: null, pets: [], acquisitions: [], homeSchedules: [], trips: [], requiredDepartureLoadouts: [], departureLoadouts: [], facts: [], settlements: [], rewards: [],
    wallet: 0, inventory: [], itemInstances: [], retiredItemIds: [], equipment: [], commerceOperations: [],
    cgs: [], cgPins: [], eventTriggers: [], occurrences: [], eventCgs: [], receipts: [], outbox: [] };
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
  aiState(): never { throw new Error('AI storage is not part of this game-only fake'); }
  workspaceState(): never { throw new Error('Workspace storage is not part of this game-only fake'); }
  voiceProfiles(): never { throw new Error('Voice storage is not part of this game-only fake'); }
  hostPreferences(): never { throw new Error('Host preferences are not part of this game-only fake'); }
  getPreferences(): PreferencesRecord | null { return copy(this.state.preferences); }
  savePreferences(record: PreferencesRecord): void { this.state.preferences = copy(record); }
  listPets(): PetRecord[] { return copy(this.state.pets); }
  getPet(petId: string): PetRecord | null { return copy(this.state.pets.find((pet) => pet.petId === petId) ?? null); }
  savePet(pet: PetRecord): void {
    const index = this.state.pets.findIndex((entry) => entry.petId === pet.petId);
    if (index === -1) this.state.pets.push(copy(pet));
    else this.state.pets[index] = copy(pet);
  }
  getPetAcquisition(petId: string): PetAcquisitionRecord | null {
    return copy(this.state.acquisitions.find(record => record.petId === petId) ?? null);
  }
  insertPetAcquisition(record: PetAcquisitionRecord): void {
    if (!this.getPet(record.petId) || this.getPetAcquisition(record.petId)
      || (record.commandId !== null && this.state.acquisitions.some(entry => entry.commandId === record.commandId))) {
      throw new Error('Invalid or duplicate pet acquisition');
    }
    this.state.acquisitions.push(copy(record));
  }
  getHomeSchedule(petId: string): HomeScheduleRecord | null {
    return copy(this.state.homeSchedules.find((entry) => entry.petId === petId) ?? null);
  }
  saveHomeSchedule(record: HomeScheduleRecord): void {
    const previous = this.getHomeSchedule(record.petId);
    if (!this.getPet(record.petId) || record.lastSimAt > (this.state.preferences?.logicalTime ?? record.lastSimAt)
      || (previous && record.lastSimAt < previous.lastSimAt)) throw new Error('Invalid or regressing home schedule');
    const index = this.state.homeSchedules.findIndex((entry) => entry.petId === record.petId);
    if (index < 0) this.state.homeSchedules.push(copy(record));
    else this.state.homeSchedules[index] = copy(record);
  }
  listTrips(): TripRecord[] { return copy(this.state.trips); }
  listSettledTrips(query: TravelReportsQuery): { total: number; trips: TripRecord[] } {
    const matches = this.state.trips.filter(trip => trip.status === 'SETTLED' && (query.petId === undefined || query.petId === trip.snapshot.petId))
      .sort((a, b) => b.checkpoint.actualReturnedAt! - a.checkpoint.actualReturnedAt!
        || (a.snapshot.tripId < b.snapshot.tripId ? -1 : a.snapshot.tripId > b.snapshot.tripId ? 1 : 0));
    return { total: matches.length, trips: copy(matches.slice(query.offset, query.offset + query.limit)) };
  }
  getTrip(tripId: string): TripRecord | null {
    return copy(this.state.trips.find((trip) => trip.snapshot.tripId === tripId) ?? null);
  }
  insertTrip(trip: TripRecord, departureLoadoutRequired = false): void {
    if (this.getTrip(trip.snapshot.tripId) !== null) throw new Error('Duplicate trip');
    if (this.state.trips.some((entry) => entry.status === 'TRAVELING' && entry.snapshot.petId === trip.snapshot.petId)) {
      throw new Error('Duplicate active trip');
    }
    this.state.trips.push(copy(trip));
    if (departureLoadoutRequired) this.state.requiredDepartureLoadouts.push(trip.snapshot.tripId);
  }
  insertTripDepartureLoadout(record: TripDepartureLoadoutRecord): void {
    if (!this.state.requiredDepartureLoadouts.includes(record.tripId) || this.getTripDepartureLoadout(record.tripId) !== null
      || this.state.departureLoadouts.some(row => row.commandId === record.commandId)) throw new Error('Invalid departure loadout identity');
    this.state.departureLoadouts.push(copy(record));
  }
  getTripDepartureLoadout(tripId: string): TripDepartureLoadout | null {
    return copy(this.state.departureLoadouts.find(row => row.tripId === tripId)?.loadout ?? null);
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
    const next = (existing?.quantity ?? 0) + quantity;
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid inventory balance');
    if (existing === undefined && quantity > 0) this.state.inventory.push({ itemId, quantity });
    else if (existing !== undefined) existing.quantity = next;
  }
  listItemInstances(): ItemInstanceRecord[] { return copy(this.state.itemInstances); }
  getItemInstance(instanceId: string): ItemInstanceRecord | null {
    return copy(this.state.itemInstances.find((entry) => entry.instanceId === instanceId) ?? null);
  }
  insertItemInstance(record: ItemInstanceRecord): void {
    if (this.getItemInstance(record.instanceId) || this.state.retiredItemIds.includes(record.instanceId) || record.enhancement !== 0) {
      throw new Error('Duplicate, retired or invalid equipment instance');
    }
    this.state.itemInstances.push(copy(record));
  }
  upgradeItemInstance(instanceId: string, expectedEnhancement: number): ItemInstanceRecord {
    const record = this.state.itemInstances.find((entry) => entry.instanceId === instanceId);
    if (!record || record.enhancement !== expectedEnhancement || record.enhancement >= 5) throw new Error('Invalid upgrade');
    record.enhancement++;
    return copy(record);
  }
  deleteItemInstance(instanceId: string): void {
    const at = this.state.itemInstances.findIndex((entry) => entry.instanceId === instanceId);
    if (at < 0 || this.getInstanceEquipment(instanceId)) throw new Error('Equipment unavailable or still equipped');
    this.state.itemInstances.splice(at, 1);
    this.state.retiredItemIds.push(instanceId);
  }
  listPetEquipment(petId?: string): PetEquipmentRecord[] { return copy(this.state.equipment.filter(entry => petId === undefined || entry.petId === petId)); }
  getPetEquipment(petId: string, slot: EquipmentSlot): PetEquipmentRecord | null {
    return copy(this.state.equipment.find(entry => entry.petId === petId && entry.slot === slot) ?? null);
  }
  getInstanceEquipment(instanceId: string): PetEquipmentRecord | null {
    return copy(this.state.equipment.find(entry => entry.instanceId === instanceId) ?? null);
  }
  equipItem(record: PetEquipmentRecord): void {
    if (!this.getItemInstance(record.instanceId) || !this.getPet(record.petId) || this.getInstanceEquipment(record.instanceId)
      || this.getPetEquipment(record.petId, record.slot)) throw new Error('Invalid equipment assignment');
    this.state.equipment.push(copy(record));
  }
  unequipItem(petId: string, slot: EquipmentSlot, expectedInstanceId: string): void {
    const at = this.state.equipment.findIndex(entry => entry.petId === petId && entry.slot === slot && entry.instanceId === expectedInstanceId);
    if (at < 0) throw new Error('Invalid equipment removal');
    this.state.equipment.splice(at, 1);
  }
  getCommerceOperation(commandId: string): CommerceOperationRecord | null {
    return copy(this.state.commerceOperations.find(entry => entry.commandId === commandId) ?? null);
  }
  insertCommerceOperation(record: CommerceOperationRecord): void {
    if (this.getCommerceOperation(record.commandId)) throw new Error('Duplicate commerce operation');
    this.state.commerceOperations.push(copy(record));
  }
  insertTripCgAssetPin(pin: TripCgAssetPin): void {
    const existing = this.state.cgPins.find((entry) => entry.tripId === pin.tripId && entry.cgId === pin.cgId && entry.variant === pin.variant);
    if (existing) throw new Error('Duplicate trip CG pin');
    this.state.cgPins.push(copy(pin));
  }
  listTripCgAssetPins(tripId: string): TripCgAssetPin[] { return copy(this.state.cgPins.filter((pin) => pin.tripId === tripId)); }
  getEventTriggerReceipt(key: string): EventTriggerReceipt | null {
    return copy(this.state.eventTriggers.find(row => row.triggerKey === key) ?? null);
  }
  insertEventTriggerReceipt(record: EventTriggerReceipt): void {
    if (this.getEventTriggerReceipt(record.triggerKey)) throw new Error('Duplicate event trigger');
    this.state.eventTriggers.push(copy(record));
  }
  insertEventOccurrence(occurrence: FrozenEventOccurrence): void {
    if (this.getEventOccurrence(occurrence.occurrenceId)) throw new Error('Duplicate event occurrence');
    this.state.occurrences.push(copy({ occurrence, status: 'PENDING', resolvedAt: null, choiceId: null, resultText: null, rewards: [], commandId: null }));
  }
  getEventOccurrence(id: string): EventOccurrenceRecord | null {
    return copy(this.state.occurrences.find(row => row.occurrence.occurrenceId === id) ?? null);
  }
  listEventHistory(petId: string, at: number): EventHistoryEntry[] {
    return this.state.occurrences.filter(row => row.occurrence.petId === petId && row.occurrence.occurredAt <= at).map(row => {
      const { occurrenceId, triggerKey, eventId, eventVersion, occurredAt } = row.occurrence;
      const final = row.resolvedAt !== null && row.resolvedAt <= at;
      return { occurrenceId, triggerKey, petId, eventId, eventVersion, occurredAt, status: final ? row.status : 'PENDING',
        resolvedAt: final ? row.resolvedAt : null, choiceId: final ? row.choiceId : null };
    });
  }
  countPendingEvents(petId?: string): number {
    return this.state.occurrences.filter(row => row.status === 'PENDING' && (petId === undefined || row.occurrence.petId === petId)).length;
  }
  listDueEvents(at: number): EventOccurrenceRecord[] {
    return copy(this.state.occurrences.filter(row => row.status === 'PENDING' && row.occurrence.deadlineAt !== null && row.occurrence.deadlineAt <= at)
      .sort((a,b) => a.occurrence.deadlineAt! - b.occurrence.deadlineAt! || (a.occurrence.occurrenceId < b.occurrence.occurrenceId ? -1 : 1)));
  }
  listEvents(query: EventListQuery): { total: number; pendingTotal: number; events: EventOccurrenceRecord[] } {
    const rows = this.state.occurrences.filter(row => (query.petId === undefined || row.occurrence.petId === query.petId)
      && (query.filter === 'ALL' || (query.filter === 'PENDING') === (row.status === 'PENDING')))
      .sort((a,b) => b.occurrence.occurredAt - a.occurrence.occurredAt || (a.occurrence.occurrenceId < b.occurrence.occurrenceId ? -1 : 1));
    return { total: rows.length, pendingTotal: this.countPendingEvents(query.petId), events: copy(rows.slice(query.offset, query.offset+query.limit)) };
  }
  finalizeEventOccurrence(record: EventFinalizationRecord): boolean {
    const existing = this.state.occurrences.find(row => row.occurrence.occurrenceId === record.occurrenceId);
    if (!existing || existing.status !== 'PENDING') return false;
    const { occurrenceId: _, ...fields } = record;
    Object.assign(existing, copy(fields));
    for (const reward of record.rewards) if (reward.kind === 'CG_UNLOCK' && reward.newlyUnlocked) {
      const asset = existing.occurrence.asset;
      if (asset?.state !== 'PINNED') throw new Error('Unpinned event CG');
      const { cgId, variant, ...assetRef } = asset;
      this.state.eventCgs.push(copy({ petId: existing.occurrence.petId, cgId, variant, sourceEventId: record.occurrenceId,
        unlockedAt: record.resolvedAt, assetRef, historicalCharacterId: asset.characterId, historicalEventDefId: asset.eventDefId,
        favorite: false, viewedAt: null }));
    }
    return true;
  }
  getEventCgUnlock(petId: string, cgId: string, variant: string): EventCgUnlock | null {
    return copy(this.state.eventCgs.find(row => row.petId === petId && row.cgId === cgId && row.variant === variant) ?? null);
  }
  listEventCgUnlocks(petId: string): EventCgUnlock[] { return copy(this.state.eventCgs.filter(row => row.petId === petId)); }
  getCgUnlock(petId: string, cgId: string, variant: string): CgUnlock | null {
    return copy(this.state.cgs.find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant) ?? null);
  }
  listCgUnlocks(petId: string): CgUnlock[] { return copy(this.state.cgs.filter((cg) => cg.petId === petId)); }
  unlockCg(unlock: CgUnlockInput): boolean {
    if (this.getCgUnlock(unlock.petId, unlock.cgId, unlock.variant) !== null || this.getEventCgUnlock(unlock.petId, unlock.cgId, unlock.variant) !== null) return false;
    const pin = this.state.cgPins.find((entry) => entry.tripId === unlock.sourceTripId && entry.petId === unlock.petId
      && entry.cgId === unlock.cgId && entry.variant === unlock.variant);
    this.state.cgs.push(copy({ ...unlock, assetRef: pin?.assetRef ?? { state: 'LEGACY_UNVERSIONED' },
      historicalCharacterId: pin?.characterId ?? null, historicalEventDefId: pin?.eventDefId ?? null,
      favorite: false, viewedAt: null }));
    return true;
  }
  setCgFavorite(petId: string, cgId: string, variant: string, favorite: boolean): boolean {
    const existing = [...this.state.cgs, ...this.state.eventCgs].find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant);
    if (!existing) throw new Error('Missing CG');
    if (existing.favorite === favorite) return false;
    existing.favorite = favorite;
    return true;
  }
  markCgViewed(petId: string, cgId: string, variant: string, characterId: string, eventDefId: string,
    assetVersion: string, assetHash: string, viewedAt: number): boolean {
    const existing = [...this.state.cgs, ...this.state.eventCgs].find((cg) => cg.petId === petId && cg.cgId === cgId && cg.variant === variant);
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
  forcedPetId: string | null = null;
  forcedItemId: string | null = null;
  private serial = 0;
  now(): number { return this.at; }
  seed(): number { return this.nextSeed; }
  createId(kind: 'trip' | 'event' | 'request' | 'pet' | 'item'): string {
    return kind === 'pet' && this.forcedPetId !== null ? this.forcedPetId
      : kind === 'item' && this.forcedItemId !== null ? this.forcedItemId : `${kind}-${++this.serial}`;
  }
}

function fixture(policy: EventPolicy = false) {
  const repo = new MemoryRepository();
  const runtime = new FakeRuntime();
  const service = new AppService(repo, runtime, policy);
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

function requestCharacters(service: AppService): { snapshot: AppSnapshot; characters: CharacterCatalogPage } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'characters-read', method: 'characters/list', payload: {} });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('characters' in result)) throw new Error('Expected revisioned character catalog result');
  expect(result.characters.revision).toBe(result.snapshot.revision);
  expect(result.characters.walletCoins).toBe(result.snapshot.walletCoins);
  return { snapshot: result.snapshot, characters: result.characters };
}

function requestInventory(service: AppService, legacyOffset?: number): { snapshot: AppSnapshot; inventory: InventoryPage } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'inventory-query', method: 'inventory/list',
    payload: legacyOffset === undefined ? {} : { legacyOffset } });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('inventory' in result)) throw new Error('Expected revisioned inventory result');
  expect(result.inventory.revision).toBe(result.snapshot.revision);
  expect(result.inventory.walletCoins).toBe(result.snapshot.walletCoins);
  return { snapshot: result.snapshot, inventory: result.inventory };
}

function requestTravelCatalog(service: AppService): { snapshot: AppSnapshot; catalog: TravelCatalog } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-catalog', method: 'travel/catalog', payload: {} });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('travelCatalog' in result)) throw new Error('Expected travel catalog');
  expect(result.travelCatalog.revision).toBe(result.snapshot.revision);
  return { snapshot: result.snapshot, catalog: result.travelCatalog };
}

function requestTravelPreview(service: AppService, payload: TripPreparationPayload): { snapshot: AppSnapshot; preview: TravelPreview } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-preview', method: 'travel/preview', payload });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('travelPreview' in result)) throw new Error('Expected travel preview');
  expect(result.travelPreview.revision).toBe(result.snapshot.revision);
  return { snapshot: result.snapshot, preview: result.travelPreview };
}

function requestTravelReports(service: AppService, payload: TravelReportsQuery = { offset: 0, limit: 20 }): { snapshot: AppSnapshot; reports: TravelReportsPage } {
  const result = service.handleRequest({ schemaVersion: 1, requestId: 'travel-reports', method: 'travel/reports', payload });
  expect(ipcResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok || !('travelReports' in result)) throw new Error('Expected travel reports');
  expect(result.travelReports.revision).toBe(result.snapshot.revision);
  return { snapshot: result.snapshot, reports: result.travelReports };
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
      energy: 100, visibility: 'HIDDEN', trip: { tripId, status: 'SETTLED', expectedReturnAt: START + 6 * MINUTE } });
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

  it('rejects insufficient energy, limits repeated feedback, and recovers needs only through elapsed HOME time', () => {
    const { service, repo, runtime } = fixture();
    repo.savePet({ ...repo.getPet('pet-1')!, energy10: 149 });
    const denied = command('no-energy', 'TRIP_START', { petId: 'pet-1', routeId: DEMO_ROUTE.routeId });
    expect(service.dispatch(denied)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.getPet('pet-1')!.energy10).toBe(149);
    for (let i = 0; i < 110; i++) success(service.dispatch(command(`pet-${i}`, 'PET_INTERACT', { petId: 'pet-1', interaction: 'PET' })));
    expect(repo.getPet('pet-1')).toMatchObject({ moodScore10: 550, bond10: 10 });
    expect(repo.getHomeSchedule('pet-1')?.interactionCount).toBe(1);
    const interactions = repo.state.outbox.filter((entry) => entry.event.type === 'PetInteracted');
    expect(interactions.filter((entry) => entry.event.payload.rewardGranted)).toHaveLength(1);
    expect(interactions.filter((entry) => entry.event.payload.reason === 'COOLDOWN')).toHaveLength(109);
    success(service.dispatch(command('rest-1', 'PET_INTERACT', { petId: 'pet-1', interaction: 'REST' })));
    expect(repo.getPet('pet-1')!.energy10).toBe(149);
    runtime.at += HOME_RULES.hourMs;
    service.getSnapshot();
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
          service = new AppService(repo, runtime, false);
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
      service = new AppService(new MemoryRepository(settled), runtime, false);
      expect(service.getSnapshot().walletCoins).toBe(16);
      return repo.state;
    }
    // Visible state can be published at different intermediate poll times,
    // so revision watermarks legitimately differ; durable travel facts,
    // economy, receipts, event content/order and final simulated state do not.
    const comparable = (state: MemoryState) => ({
      ...state, preferences: { ...state.preferences, revision: 0 },
      pets: state.pets.map((pet) => ({ ...pet, revision: 0 })),
      homeSchedules: state.pets.map(({ revision: _revision, ...pet }) => advanceHomeState({ ...pet,
        ...state.homeSchedules.find((schedule) => schedule.petId === pet.petId)! }, state.preferences!.logicalTime)),
      outbox: state.outbox.map((entry) => ({ ...entry, event: { ...entry.event, revision: 0 } })),
    });
    expect(comparable(run(true))).toEqual(comparable(run(false)));
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
      expect(() => new AppService(reopened, runtime, false)).toThrow();
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
    expect(() => new AppService(reopened, runtime, false)).toThrow();
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
    const recovered = new AppService(reopened, runtime, false);
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
    expect(gallery.total).toBe(4);
    expect(gallery.rows.map((row) => [row.petId, row.characterId, row.unlockStatus])).toEqual([
      ['pet-1', 'star-singer', 'LOCKED'], ['pet-1', 'star-singer', 'LOCKED'],
      ['pet-2', 'fluffy-ranger', 'LOCKED'], ['pet-2', 'fluffy-ranger', 'LOCKED'],
    ]);
    for (const row of gallery.rows) {
      expect(Object.keys(row).sort()).toEqual([
        'petId', 'characterId', 'cgId', 'variant', 'title', 'hint', 'routeId', 'eventDefId', 'rarity', 'unlockStatus',
      ].sort());
    }
    expect(requestGallery(service, { ...galleryQuery, offset: 1, limit: 1 }).gallery.rows).toEqual([gallery.rows[1]]);
    expect(requestGallery(service, { ...galleryQuery, offset: 4, limit: 1 }).gallery.rows).toEqual([]);
    expect(requestGallery(service, { ...galleryQuery, petId: 'pet-2', characterId: 'fluffy-ranger', filter: 'LOCKED',
      routeId: DEMO_ROUTE.routeId, eventDefId: 'dew-postcard', rarity: 'COMMON' }).gallery.rows).toEqual([gallery.rows.find(row => row.petId === 'pet-2' && row.cgId === 'morning-dew')]);
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

describe('authoritative character catalog, acquisition and nickname', () => {
  const acquireNova = { characterId: 'nova', catalogVersion: CHARACTER_CATALOG_VERSION };

  function settleTrips(service: AppService, runtime: FakeRuntime, count: number, prefix: string): void {
    for (let i = 0; i < count; i++) {
      depart(service, 'pet-1', `${prefix}-${i}`);
      runtime.at += 15 * MINUTE;
      service.getSnapshot();
    }
  }

  it('records actual fresh starter origins without changing historic instance IDs, stats or visibility', () => {
    const { service, repo } = fixture();
    const result = requestCharacters(service);
    expect(result.snapshot).toMatchObject({ revision: 0, primaryPetId: 'pet-1', walletCoins: 0, pets: [
      { petId: 'pet-1', characterId: 'star-singer', nickname: '星咏', visibility: 'VISIBLE', presence: 'HOME', xp: 0, energy: 100 },
      { petId: 'pet-2', characterId: 'fluffy-ranger', nickname: '绒绒', visibility: 'HIDDEN', presence: 'HOME', xp: 0, energy: 100 },
    ] });
    expect(repo.state.pets.map(pet => pet.power)).toEqual([30, 25]);
    expect(repo.state.acquisitions).toEqual(['pet-1', 'pet-2'].map(petId => ({ petId, acquiredAt: START,
      origin: 'STARTER', catalogVersion: CHARACTER_CATALOG_VERSION, coinCost: 0, commandId: null })));
    expect(result.characters.rows.map(row => [row.characterId, row.availability])).toEqual([
      ['star-singer','ALREADY_OWNED'], ['fluffy-ranger','ALREADY_OWNED'], ['nova','UNMET_REQUIREMENT'],
    ]);
    expect(result.characters.rows[0]?.instances).toEqual([{ petId: 'pet-1', nickname: '星咏', origin: 'STARTER', acquiredAt: START }]);
    expect(repo.state.outbox).toEqual([]);
  });

  it('recomputes gate and coin requirement in the write transaction; one purchase creates exactly one independent pet', () => {
    const { service, repo, runtime } = fixture();
    settleTrips(service, runtime, 2, 'unlock-prefix');
    const before = requestCharacters(service);
    expect(before.characters.settledTrips).toBe(2);
    expect(before.characters.walletCoins).toBe(16);
    expect(service.dispatch(command('too-early', 'PET_ACQUIRE', acquireNova))).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.state.pets).toHaveLength(2);
    expect(repo.state.wallet).toBe(16);
    settleTrips(service, runtime, 1, 'unlock-final');
    const ready = requestCharacters(service);
    expect(ready.characters.rows.find(row => row.characterId === 'nova')?.availability).toBe('AVAILABLE');
    expect(ready.snapshot.walletCoins).toBe(24);
    const purchase = command('nova-acquire', 'PET_ACQUIRE', acquireNova, { expectedRevision: ready.snapshot.revision });
    const accepted = success(service.dispatch(purchase));
    const newPet = accepted.pets.find(pet => pet.characterId === 'nova')!;
    expect(newPet).toMatchObject({ characterId: 'nova', nickname: '诺瓦', visibility: 'HIDDEN', presence: 'HOME', activity: 'IDLE',
      level: 1, xp: 0, revision: 0, energy: 100, healthPoints: 100, moodScore: 50, bond: 0 });
    expect(newPet.petId).not.toBe('pet-1');
    expect(newPet.petId).not.toBe('pet-2');
    expect(accepted.pets.filter(pet => pet.characterId !== 'nova')).toEqual(ready.snapshot.pets);
    expect(accepted.primaryPetId).toBe(ready.snapshot.primaryPetId);
    expect(accepted.revision).toBe(ready.snapshot.revision + 1);
    expect(accepted.walletCoins).toBe(8);
    expect(repo.getPet(newPet.petId)?.power).toBe(28);
    expect(repo.getPetAcquisition(newPet.petId)).toEqual({ petId: newPet.petId, origin: 'GAME', acquiredAt: runtime.at,
      catalogVersion: CHARACTER_CATALOG_VERSION, coinCost: 16, commandId: purchase.commandId });
    expect(repo.state.outbox.filter(entry => entry.event.type === 'PetAcquired')).toHaveLength(1);
    expect(success(service.dispatch(purchase))).toEqual(accepted); // command receipt, not another debit
    expect(service.dispatch(command('another-purchase', 'PET_ACQUIRE', acquireNova))).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.state.wallet).toBe(8);
    expect(repo.state.acquisitions).toHaveLength(3);
    expect(requestCharacters(service).characters.rows.find(row => row.characterId === 'nova')).toMatchObject({ availability: 'ALREADY_OWNED',
      instances: [{ petId: newPet.petId, nickname: '诺瓦', origin: 'GAME', acquiredAt: runtime.at }] });
  });

  it('rejects stale catalog/revision and unknown template identities without spending', () => {
    const { service, repo } = fixture();
    expect(service.dispatch(command('wrong-catalog', 'PET_ACQUIRE', { ...acquireNova, catalogVersion: 99 })))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(service.dispatch(command('stale-acquire', 'PET_ACQUIRE', acquireNova, { expectedRevision: 5 })))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(service.dispatch(command('missing-character', 'PET_ACQUIRE', { ...acquireNova, characterId: 'not-in-catalog' })))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(repo.state.wallet).toBe(0);
    expect(repo.state.pets).toHaveLength(2);
    expect(repo.state.acquisitions).toHaveLength(2);
  });

  it('requires sixteen in-game coins even after three real settled recall trips', () => {
    const { service, repo, runtime } = fixture();
    for (let i = 0; i < 3; i++) {
      const tripId = depart(service, 'pet-1', `short-trip-${i}`);
      success(service.dispatch(command(`recall-short-${i}`, 'TRIP_RECALL', { petId: 'pet-1', tripId })));
      runtime.at += 15 * MINUTE;
      service.getSnapshot();
    }
    const page = requestCharacters(service).characters;
    expect(page.settledTrips).toBe(3);
    expect(page.walletCoins).toBe(0);
    expect(page.rows.find(row => row.characterId === 'nova')?.availability).toBe('INSUFFICIENT_COINS');
    expect(service.dispatch(command('poor-acquire', 'PET_ACQUIRE', acquireNova))).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.state.pets).toHaveLength(2);
    expect(repo.state.wallet).toBe(0);
  });

  it('rolls back every acquisition effect when event persistence fails and retries the same command safely', () => {
    const { service, repo, runtime } = fixture();
    settleTrips(service, runtime, 3, 'acquire-rollback');
    const before = copy(repo.state);
    const purchase = command('rollback-purchase', 'PET_ACQUIRE', acquireNova);
    repo.failOnEvent = 'PetAcquired';
    expect(service.dispatch(purchase)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
    expect(repo.getCommandReceipt(purchase.commandId)).toBeNull();
    repo.failOnEvent = null;
    expect(success(service.dispatch(purchase)).walletCoins).toBe(8);
    expect(repo.state.acquisitions).toHaveLength(3);
  });

  it('refuses a generated pet ID collision instead of overwriting an existing pet or taking coins', () => {
    const { service, repo, runtime } = fixture();
    settleTrips(service, runtime, 3, 'collision-trip');
    const before = copy(repo.state);
    runtime.forcedPetId = 'pet-1';
    expect(service.dispatch(command('collision-acquire', 'PET_ACQUIRE', acquireNova))).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
  });

  it('renames an away pet with Unicode normalization without changing frozen trip, other pet or acquisition', () => {
    const { service, repo } = fixture();
    const tripId = depart(service);
    const before = service.getSnapshot();
    const tripBefore = repo.getTrip(tripId);
    const acquisitionBefore = repo.getPetAcquisition('pet-1');
    const factsBefore = repo.listTripFacts(tripId);
    const rename = command('away-rename', 'PET_RENAME', { petId: 'pet-1', nickname: '  e\u0301 星咏  ' });
    const after = success(service.dispatch(rename));
    expect(after.pets[0]).toEqual({ ...before.pets[0], nickname: 'é 星咏', revision: before.pets[0]!.revision + 1 });
    expect(after.pets[1]).toEqual(before.pets[1]);
    expect(after.revision).toBe(before.revision + 1);
    expect(repo.getTrip(tripId)).toEqual(tripBefore);
    expect(repo.listTripFacts(tripId)).toEqual(factsBefore);
    expect(repo.getPetAcquisition('pet-1')).toEqual(acquisitionBefore);
    expect(success(service.dispatch(rename))).toEqual(after);
    expect(success(service.dispatch(command('rename-no-op', 'PET_RENAME', { petId: 'pet-1', nickname: 'é 星咏' })))).toEqual(after);
    expect(repo.state.outbox.filter(entry => entry.event.type === 'PetRenamed')).toHaveLength(1);
    expect(requestCharacters(service).characters.rows.find(row => row.characterId === 'star-singer')?.instances[0]?.nickname).toBe('é 星咏');
  });

  it('rejects whitespace-only or control-character nicknames and missing pets', () => {
    const { service, repo } = fixture();
    const before = service.getSnapshot();
    expect(service.dispatch(command('blank-name', 'PET_RENAME', { petId: 'pet-1', nickname: '   ' })))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(service.dispatch(command('control-name', 'PET_RENAME', { petId: 'pet-1', nickname: '隐\u202e名' })))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(service.dispatch(command('absent-name', 'PET_RENAME', { petId: 'pet-999', nickname: '新名称' })))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(service.getSnapshot()).toEqual(before);
    expect(repo.state.outbox.filter(entry => entry.event.type === 'PetRenamed')).toHaveLength(0);
  });

  it('does not synthesize missing acquisition dates or erase unknown historical characters on reload', () => {
    const { repo, runtime } = fixture();
    const legacy = copy(repo.state);
    legacy.acquisitions = [];
    legacy.pets[1]!.characterId = 'retired-character';
    legacy.pets[1]!.nickname = '历史角色';
    const reopened = new MemoryRepository(legacy);
    runtime.at += 100_000;
    const service = new AppService(reopened, runtime, false);
    const result = requestCharacters(service);
    expect(result.snapshot.pets.find(pet => pet.petId === 'pet-2')).toMatchObject({ characterId: 'retired-character', nickname: '历史角色' });
    expect(result.characters.rows.find(row => row.characterId === 'star-singer')?.instances)
      .toEqual([{ petId: 'pet-1', nickname: '星咏', acquiredAt: null, origin: 'LEGACY' }]);
    expect(result.characters.rows.find(row => row.characterId === 'fluffy-ranger')).toMatchObject({ availability: 'AVAILABLE', instances: [] });
    expect(reopened.state.acquisitions).toEqual([]);
  });
});

describe('authoritative shared inventory and independent equipment', () => {
  const catalogVersion = ITEM_CATALOG_VERSION;
  type CommerceType = 'SHOP_PURCHASE' | 'EQUIPMENT_EQUIP' | 'EQUIPMENT_UNEQUIP' | 'EQUIPMENT_UPGRADE' | 'EQUIPMENT_SALVAGE' | 'ITEM_USE';
  function execute<T extends CommerceType>(service: AppService, id: string, type: T, payload: Extract<DomainCommand, { type: T }>['payload']): AppSnapshot {
    return success(service.dispatch({ commandId: id, issuedAt: 0, type, payload, expectedRevision: service.getSnapshot().revision } as DomainCommand));
  }
  function purchase(service: AppService, id: string, offerId: string, quantity = 1): AppSnapshot {
    return execute(service, id, 'SHOP_PURCHASE', { offerId, quantity, catalogVersion });
  }
  function deny<T extends CommerceType>(service: AppService, id: string, type: T, payload: Extract<DomainCommand, { type: T }>['payload'], code = 'BUSINESS_RULE') {
    expect(service.dispatch({ commandId: id, issuedAt: 0, type, payload, expectedRevision: service.getSnapshot().revision } as DomainCommand))
      .toMatchObject({ ok: false, error: { code } });
  }

  it('projects complete offers, known and legacy stacks, progression and compatible equipment without fabricating old data', () => {
    const { service, repo } = fixture();
    repo.addInventory('herb', 3);
    repo.addInventory('old-unknown-item', 2);
    repo.insertItemInstance({ instanceId: 'old-equipment', definitionId: 'apprentice-staff', definitionVersion: 2, enhancement: 0, acquiredAt: START });
    repo.equipItem({ petId: 'pet-1', slot: 'WEAPON', instanceId: 'old-equipment' });
    repo.savePet({ ...repo.getPet('pet-2')!, characterId: 'legacy-unreleased-character', power: 37, xp: 100 });
    const { inventory, snapshot } = requestInventory(service);
    expect(inventory.stacks).toEqual([{ itemId: 'herb', quantity: 3, definitionState: 'AVAILABLE' },
      { itemId: 'old-unknown-item', quantity: 2, definitionState: 'LEGACY_UNKNOWN' }]);
    expect(inventory.definitions.some(item => item.itemId === 'ration')).toBe(true);
    expect(inventory.offers.some(offer => offer.offerId === 'shop-apprentice-staff')).toBe(true);
    expect(inventory.instances).toEqual([expect.objectContaining({ instanceId: 'old-equipment', definitionState: 'UNAVAILABLE', bonus: null,
      upgrade: { ok: false, reason: 'UNAVAILABLE' }, salvage: { canSalvage: false, materials: [], reason: 'UNAVAILABLE' }, equipped: { petId: 'pet-1', slot: 'WEAPON' } })]);
    expect(inventory.pets[0]).toMatchObject({ battlePower: 30, stats: { atk: 22 }, progression: { level: 1, cumulativeXp: 0 } });
    expect(inventory.pets[1]).toMatchObject({ battlePower: 37, stats: null, progression: { level: 2, cumulativeXp: 100 } });
    expect(snapshot.pets[1]!.level).toBe(2);
    deny(service, 'legacy-upgrade', 'EQUIPMENT_UPGRADE', { instanceId: 'old-equipment', expectedEnhancement: 0, catalogVersion });
    execute(service, 'legacy-unbind', 'EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON', catalogVersion });
    deny(service, 'legacy-rebind', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId: 'old-equipment', catalogVersion });
    deny(service, 'legacy-salvage', 'EQUIPMENT_SALVAGE', { instanceId: 'old-equipment', expectedEnhancement: 0, catalogVersion });
    deny(service, 'legacy-use', 'ITEM_USE', { petId: 'pet-1', itemId: 'old-unknown-item', catalogVersion });
    expect(repo.state.commerceOperations).toHaveLength(1);
  });

  it('re-quotes purchases using current coins and mandatory revisions, creates distinct stable equipment IDs, and never repeats a debit', () => {
    const { service, repo } = fixture();
    repo.setWalletCoins(100);
    const revision = service.getSnapshot().revision;
    const payload = { offerId: 'shop-ration', quantity: 3, catalogVersion };
    expect(service.dispatch(command('no-revision', 'SHOP_PURCHASE', payload))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(service.dispatch(command('bad-catalog', 'SHOP_PURCHASE', { ...payload, catalogVersion: 2 }, { expectedRevision: revision })))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    const exact = command('ration-once', 'SHOP_PURCHASE', payload, { expectedRevision: revision });
    const bought = success(service.dispatch(exact));
    expect(bought.walletCoins).toBe(94);
    expect(repo.listInventory()).toEqual([{ itemId: 'ration', quantity: 3 }]);
    expect(repo.getCommerceOperation(exact.commandId)).toEqual({ type: 'SHOP_PURCHASE', commandId: exact.commandId, occurredAt: START, catalogVersion,
      offerId: payload.offerId, itemId: 'ration', quantity: 3, coinCost: 6, outputKind: 'STACK', instanceIds: [] });
    expect(success(service.dispatch(exact))).toEqual(bought);
    expect(service.dispatch(command('stale-purchase', 'SHOP_PURCHASE', payload, { expectedRevision: revision })))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    expect(repo.getCommerceOperation('stale-purchase')).toBeNull();
    expect(purchase(service, 'staff-pair', 'shop-apprentice-staff', 2).walletCoins).toBe(70);
    const instances = repo.listItemInstances();
    expect(new Set(instances.map(instance => instance.instanceId)).size).toBe(2);
    expect(instances).toEqual([expect.objectContaining({ definitionId: 'apprentice-staff', definitionVersion: 1, enhancement: 0, acquiredAt: START }),
      expect.objectContaining({ definitionId: 'apprentice-staff', definitionVersion: 1, enhancement: 0, acquiredAt: START })]);
    expect(repo.getCommerceOperation('staff-pair')).toMatchObject({ coinCost: 24, outputKind: 'EQUIPMENT', instanceIds: instances.map(row => row.instanceId).sort() });
    deny(service, 'over-offer', 'SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 4, catalogVersion });
    deny(service, 'missing-offer', 'SHOP_PURCHASE', { offerId: 'nonexistent', quantity: 1, catalogVersion }, 'NOT_FOUND');
    repo.setWalletCoins(69);
    deny(service, 'poor', 'SHOP_PURCHASE', { offerId: 'shop-glimmer-dust', quantity: 10, catalogVersion }, 'BUSINESS_RULE');
    expect(repo.getWalletCoins()).toBe(69);
  });

  it('atomically replaces a same-pet slot, forbids stealing equipment, and updates only the affected pet', () => {
    const { service, repo } = fixture();
    repo.setWalletCoins(100);
    purchase(service, 'two-weapons', 'shop-apprentice-staff', 2);
    const [first, second] = repo.listItemInstances();
    const base = requestInventory(service);
    deny(service, 'wrong-slot', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'ARMOR', instanceId: first!.instanceId, catalogVersion });
    execute(service, 'equip-first', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId: first!.instanceId, catalogVersion });
    const equipped = requestInventory(service);
    expect(equipped.inventory.pets[0]!.battlePower).toBeGreaterThan(base.inventory.pets[0]!.battlePower);
    expect(equipped.snapshot.pets[0]!.revision).toBe(base.snapshot.pets[0]!.revision + 1);
    expect(equipped.inventory.pets[1]).toEqual(base.inventory.pets[1]);
    deny(service, 'steal-other-pet', 'EQUIPMENT_EQUIP', { petId: 'pet-2', slot: 'WEAPON', instanceId: first!.instanceId, catalogVersion });
    deny(service, 'equip-noop', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId: first!.instanceId, catalogVersion });
    const before = copy(repo.state);
    const replace = command('replace-weapon', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId: second!.instanceId, catalogVersion },
      { expectedRevision: service.getSnapshot().revision });
    repo.failOnEvent = 'EquipmentEquipped';
    expect(service.dispatch(replace)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
    repo.failOnEvent = null;
    success(service.dispatch(replace));
    expect(repo.getPetEquipment('pet-1', 'WEAPON')?.instanceId).toBe(second!.instanceId);
    expect(repo.getInstanceEquipment(first!.instanceId)).toBeNull();
    expect(repo.getCommerceOperation(replace.commandId)).toMatchObject({ previousInstanceId: first!.instanceId, instanceId: second!.instanceId });
    execute(service, 'equip-other', 'EQUIPMENT_EQUIP', { petId: 'pet-2', slot: 'WEAPON', instanceId: first!.instanceId, catalogVersion });
    expect(repo.listPetEquipment()).toHaveLength(2);
    execute(service, 'unequip-first', 'EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON', catalogVersion });
    deny(service, 'empty-slot', 'EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON', catalogVersion });
    expect(repo.getPetEquipment('pet-2', 'WEAPON')?.instanceId).toBe(first!.instanceId);
  });

  it('enforces exact upgrade cost and cap, exact enhancement versions, unequipped salvage, and retired identity uniqueness', () => {
    const { service, repo, runtime } = fixture();
    repo.setWalletCoins(500);
    purchase(service, 'staff', 'shop-apprentice-staff');
    const instanceId = repo.listItemInstances()[0]!.instanceId;
    repo.addInventory('iron-ore', 20);
    execute(service, 'equip-before-upgrade', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId, catalogVersion });
    for (let enhancement = 0; enhancement < 5; enhancement++) {
      const current = requestInventory(service);
      const quote = current.inventory.instances[0]!.upgrade;
      if (!quote.ok) throw new Error('Expected upgrade quote');
      const costsBefore = new Map(repo.listInventory().map(row => [row.itemId, row.quantity]));
      const upgraded = execute(service, `upgrade-${enhancement}`, 'EQUIPMENT_UPGRADE', { instanceId, expectedEnhancement: enhancement, catalogVersion });
      expect(upgraded.walletCoins).toBe(current.snapshot.walletCoins - quote.cost.coins);
      expect(repo.getItemInstance(instanceId)?.enhancement).toBe(enhancement + 1);
      for (const material of quote.cost.materials) expect(repo.listInventory().find(row => row.itemId === material.itemId)?.quantity)
        .toBe(costsBefore.get(material.itemId)! - material.quantity);
      expect(upgraded.pets[0]!.revision).toBe(current.snapshot.pets[0]!.revision + 1);
    }
    expect(requestInventory(service).inventory.instances[0]!.upgrade).toEqual({ ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 });
    deny(service, 'stale-enhancement', 'EQUIPMENT_UPGRADE', { instanceId, expectedEnhancement: 1, catalogVersion }, 'REVISION_CONFLICT');
    deny(service, 'upgrade-cap', 'EQUIPMENT_UPGRADE', { instanceId, expectedEnhancement: 5, catalogVersion });
    deny(service, 'salvage-equipped', 'EQUIPMENT_SALVAGE', { instanceId, expectedEnhancement: 5, catalogVersion });
    execute(service, 'unequip-for-salvage', 'EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON', catalogVersion });
    const previous = service.getSnapshot();
    const salvage = command('salvage-once', 'EQUIPMENT_SALVAGE', { instanceId, expectedEnhancement: 5, catalogVersion }, { expectedRevision: previous.revision });
    const result = success(service.dispatch(salvage));
    expect(result.walletCoins).toBe(previous.walletCoins);
    expect(repo.listInventory().find(row => row.itemId === 'iron-scrap')?.quantity).toBe(3);
    expect(repo.getItemInstance(instanceId)).toBeNull();
    expect(success(service.dispatch(salvage))).toEqual(result);
    expect(repo.getCommerceOperation(salvage.commandId)).toMatchObject({ enhancement: 5, materials: [{ itemId: 'iron-scrap', quantity: 3 }] });
    runtime.forcedItemId = instanceId;
    const before = copy(repo.state);
    expect(service.dispatch(command('reuse-retired', 'SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 1, catalogVersion }, { expectedRevision: result.revision })))
      .toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
  });

  it('uses one authoritative consumable at HOME, preserving exact fractions except directional or saturated needs', () => {
    const { service, repo, runtime } = fixture();
    repo.addInventory('ration', 3);
    repo.addInventory('healing-potion', 2);
    repo.addInventory('sweet-biscuit', 2);
    repo.savePet({ ...repo.getPet('pet-1')!, energy10: 400, healthPoints10: 800, healthStatus: 'INJURED', moodScore10: 490 });
    runtime.at += 1_000;
    execute(service, 'eat-ration', 'ITEM_USE', { petId: 'pet-1', itemId: 'ration', catalogVersion });
    expect(repo.getPet('pet-1')).toMatchObject({ energy10: 600, activity: 'EAT' });
    expect(repo.getHomeSchedule('pet-1')).toMatchObject({ energyRemainder: 200_000, healthRemainder: 100_000, moodRemainder: 100_000 });
    runtime.at = START + 18_000;
    expect(service.getSnapshot().pets[0]!.energy).toBe(60.1);
    execute(service, 'heal-fully', 'ITEM_USE', { petId: 'pet-1', itemId: 'healing-potion', catalogVersion });
    expect(repo.getPet('pet-1')).toMatchObject({ healthPoints10: 1000, healthStatus: 'NORMAL' });
    expect(repo.getHomeSchedule('pet-1')!.healthRemainder).toBe(0);
    deny(service, 'full-health', 'ITEM_USE', { petId: 'pet-1', itemId: 'healing-potion', catalogVersion });
    expect(repo.listInventory().find(row => row.itemId === 'healing-potion')?.quantity).toBe(1);
    execute(service, 'gift', 'ITEM_USE', { petId: 'pet-1', itemId: 'sweet-biscuit', catalogVersion });
    expect(repo.getPet('pet-1')).toMatchObject({ bond10: 10, moodScore10: 530 });
    expect(repo.getHomeSchedule('pet-1')).toMatchObject({ moodRemainder: 0, interactionCount: 0, lastInteractionAt: null });
    depart(service);
    deny(service, 'feed-away', 'ITEM_USE', { petId: 'pet-1', itemId: 'ration', catalogVersion });
    expect(repo.listInventory().find(row => row.itemId === 'ration')?.quantity).toBe(2);
    expect(repo.getPet('pet-2')!.bond10).toBe(0);
  });

  it('freezes new departure power while every later gear change leaves the active deterministic trip untouched', () => {
    const { service, repo, runtime } = fixture();
    repo.setWalletCoins(100);
    purchase(service, 'travel-staff', 'shop-apprentice-staff');
    const instanceId = repo.listItemInstances()[0]!.instanceId;
    execute(service, 'travel-equip', 'EQUIPMENT_EQUIP', { petId: 'pet-1', slot: 'WEAPON', instanceId, catalogVersion });
    const projected = requestInventory(service).inventory.pets[0]!.battlePower;
    expect(projected).toBeGreaterThan(30);
    const tripId = depart(service);
    const frozen = repo.getTrip(tripId)!.snapshot;
    expect(frozen.power).toBe(projected);
    execute(service, 'change-in-flight', 'EQUIPMENT_UNEQUIP', { petId: 'pet-1', slot: 'WEAPON', catalogVersion });
    expect(repo.getTrip(tripId)!.snapshot).toEqual(frozen);
    expect(requestInventory(service).inventory.pets[0]!.battlePower).toBe(30);
    runtime.at += 15 * MINUTE;
    service.getSnapshot();
    const current = requestInventory(service).inventory.pets[0]!.battlePower;
    const next = depart(service, 'pet-1', 'next-travel');
    expect(repo.getTrip(next)!.snapshot.power).toBe(current);
    expect(repo.getTrip(tripId)!.snapshot).toEqual(frozen);
  });

  it('checks instance capacity before writes, keeps legacy stack pages separate, and rolls back injected purchase failures', () => {
    const { service, repo, runtime } = fixture();
    repo.setWalletCoins(100_000);
    const first = command('failed-purchase', 'SHOP_PURCHASE', { offerId: 'shop-apprentice-staff', quantity: 2, catalogVersion },
      { expectedRevision: service.getSnapshot().revision });
    const before = copy(repo.state);
    repo.failOnEvent = 'ShopPurchased';
    expect(service.dispatch(first)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
    repo.failOnEvent = null;
    runtime.forcedItemId = 'repeated-allocation';
    expect(service.dispatch(first)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(before);
    runtime.forcedItemId = null;
    success(service.dispatch(first));
    for (let i = repo.state.itemInstances.length; i < 500; i++) repo.insertItemInstance({ instanceId: `cap-${i}`, definitionId: 'lucky-charm', definitionVersion: 1, enhancement: 0, acquiredAt: START });
    const wallet = repo.getWalletCoins();
    deny(service, 'instance-cap', 'SHOP_PURCHASE', { offerId: 'shop-lucky-charm', quantity: 1, catalogVersion });
    expect(repo.state.itemInstances).toHaveLength(500);
    for (let i = 0; i < 256; i++) repo.addInventory(`legacy-cap-${i}`, 1);
    purchase(service, 'legacy-does-not-consume-stack-capacity', 'shop-ration');
    expect(repo.state.inventory).toHaveLength(257);
    expect(repo.getWalletCoins()).toBe(wallet - 2);
    for (const offset of [0, 128, 256]) {
      const page = requestInventory(service, offset).inventory;
      expect(page.legacyStackOffset).toBe(offset);
      expect(page.legacyStackTotal).toBe(256);
      expect(page.stacks[0]).toEqual({ itemId: 'ration', quantity: 1, definitionState: 'AVAILABLE' });
      expect(page.stacks.filter(row => row.definitionState === 'LEGACY_UNKNOWN')).toHaveLength(Math.min(128, 256 - offset));
    }
  });
});

describe('versioned travel preparation and immutable report projection', () => {
  const version = ROUTE_CATALOG_VERSION;
  const input = (petId: string, routeId: string, selectedSupplies: TripPreparationPayload['selectedSupplies'] = []): TripPreparationPayload =>
    ({ petId, routeId, routeCatalogVersion: version, selectedSupplies });
  const departPrepared = (service: AppService, id: string, prepared: TripPreparationPayload) => {
    const quote = requestTravelPreview(service, prepared);
    expect(quote.preview.eligible).toBe(true);
    const raw = command(id, 'TRIP_START_PREPARED', prepared, { expectedRevision: quote.snapshot.revision });
    return { raw, snapshot: success(service.dispatch(raw)) };
  };

  it('exposes three bounded routes and exact current supply stock without simulator definitions or legacy inventory leakage', () => {
    const { service, repo } = fixture();
    repo.addInventory('ration', 3);
    for (let i = 0; i < 4_103; i++) repo.addInventory(`legacy-stack-${i}`, 1);
    const { catalog } = requestTravelCatalog(service);
    expect(catalog.routeCatalogVersion).toBe(version);
    expect(catalog.routes.map(route => ({ routeId: route.routeId, energy: route.energyCost10, duration: route.durationMs, minLevel: route.minLevel }))).toEqual([
      { routeId: DEMO_ROUTE.routeId, energy: 150, duration: 15 * MINUTE, minLevel: 1 },
      { routeId: 'mist-forest', energy: 300, duration: 60 * MINUTE, minLevel: 4 },
      { routeId: 'starfall-ruins', energy: 500, duration: 240 * MINUTE, minLevel: 10 },
    ]);
    expect(catalog.supplyStock).toEqual([{ itemId: 'healing-potion', quantity: 0 }, { itemId: 'ration', quantity: 3 }]);
    expect(catalog.routes.every(route => !Object.hasOwn(route, 'route') && !Object.hasOwn(route, 'nodes') && !Object.hasOwn(route, 'seed'))).toBe(true);
    expect(requestTravelPreview(service, input('pet-1', DEMO_ROUTE.routeId)).preview.eligible).toBe(true);
  });

  it('projects exact eligibility reasons and rejects equivalent stale or busy departures without debiting', () => {
    const { service, repo } = fixture();
    const forest = input('pet-1', 'mist-forest');
    const quote = requestTravelPreview(service, forest);
    expect(quote.preview.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'LEVEL_TOO_LOW', 'MISSING_REQUIRED_SUPPLY', 'SUPPLY_OUT_OF_STOCK',
    ]));
    const bad = command('underlevel-forest', 'TRIP_START_PREPARED', forest, { expectedRevision: quote.snapshot.revision });
    expect(service.dispatch(bad)).toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    expect(repo.state.trips).toEqual([]);
    expect(repo.getPet('pet-1')!.energy10).toBe(1000);
    expect(service.dispatch(command('no-prepared-revision', 'TRIP_START_PREPARED', input('pet-1', DEMO_ROUTE.routeId))))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const staleInput = { ...input('pet-1', DEMO_ROUTE.routeId), routeCatalogVersion: 2 };
    const stale = requestTravelPreview(service, staleInput);
    expect(stale.preview).toMatchObject({ eligible: false, route: null, energyCost10: 0, durationMs: 0,
      reasons: [{ code: 'ROUTE_CATALOG_VERSION_MISMATCH', expectedVersion: version, receivedVersion: 2 }] });
    expect(service.dispatch(command('catalog-stale-depart', 'TRIP_START_PREPARED', staleInput, { expectedRevision: stale.snapshot.revision })))
      .toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
    const unavailable = requestTravelPreview(service, input('pet-1','missing-route'));
    expect(unavailable.preview).toMatchObject({ route: null, reasons: [{ code: 'ROUTE_NOT_FOUND', routeId: 'missing-route' }] });
    expect(service.handleRequest({ schemaVersion: 1, requestId: 'missing-pet-preview', method: 'travel/preview', payload: input('missing-pet',DEMO_ROUTE.routeId) }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    for (const activity of ['CHAT', 'DRAG'] as const) {
      repo.savePet({ ...repo.getPet('pet-1')!, activity });
      const busy = requestTravelPreview(service, input('pet-1', DEMO_ROUTE.routeId));
      expect(busy.preview).toMatchObject({ eligible: false, reasons: [{ code: 'PET_BUSY', activity }] });
      expect(service.dispatch(command(`blocked-${activity.toLowerCase()}`, 'TRIP_START_PREPARED', input('pet-1', DEMO_ROUTE.routeId), { expectedRevision: busy.snapshot.revision })))
        .toMatchObject({ ok: false, error: { code: 'BUSINESS_RULE' } });
    }
    expect(repo.state.trips).toEqual([]);
    expect(repo.state.departureLoadouts).toEqual([]);
  });

  it('revalidates supply selection and actual stock at commit, with exact rollback and retry when departure persistence fails', () => {
    const { service, repo } = fixture();
    repo.savePet({ ...repo.getPet('pet-1')!, xp: cumulativeXpAtLevel(4) });
    repo.addInventory('ration', 2);
    const exact = input('pet-1', 'mist-forest', [{ itemId: 'ration', quantity: 1 }]);
    const extra = requestTravelPreview(service, input('pet-1', 'mist-forest', [{ itemId: 'ration', quantity: 2 }]));
    expect(extra.preview).toMatchObject({ eligible: false, supplyConsumption: [],
      reasons: [expect.objectContaining({ code: 'EXCESS_SUPPLY' })] });
    const unauthorized = requestTravelPreview(service, input('pet-1', 'mist-forest', [{ itemId: 'ration', quantity: 1 }, { itemId: 'healing-potion', quantity: 1 }]));
    expect(unauthorized.preview.reasons).toContainEqual({ code: 'SUPPLY_NOT_ALLOWED', itemId: 'healing-potion', selectedQuantity: 1 });
    const quote = requestTravelPreview(service, exact);
    expect(quote.preview).toMatchObject({ eligible: true, energyCost10: 300, supplyConsumption: [{ itemId: 'ration', quantity: 1 }] });
    const departure = command('forest-retry', 'TRIP_START_PREPARED', exact, { expectedRevision: quote.snapshot.revision });
    const baseline = copy(repo.state);
    repo.failOnEvent = 'TripStarted';
    expect(service.dispatch(departure)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(repo.state).toEqual(baseline);
    repo.failOnEvent = null;
    const started = success(service.dispatch(departure));
    expect(started.pets[0]).toMatchObject({ energy: 70, presence: 'AWAY', trip: { routeId: 'mist-forest' } });
    expect(repo.listInventory().find(row => row.itemId === 'ration')?.quantity).toBe(1);
    const tripId = started.pets[0]!.trip!.tripId;
    expect(repo.getTripDepartureLoadout(tripId)).toMatchObject({ energyCost10: 300, level: 4, supplies: [{ itemId: 'ration', quantity: 1 }] });
    expect(success(service.dispatch(departure))).toEqual(started);
    expect(repo.listInventory().find(row => row.itemId === 'ration')?.quantity).toBe(1);
    const awayQuote = requestTravelPreview(service, exact);
    expect(awayQuote.preview.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['PET_NOT_HOME', 'ACTIVE_TRIP']));
    expect(requestTravelReports(service).reports.rows).toHaveLength(0);
  });

  it('sorts paginated settled reports by actual return and preserves facts, ledger and the first frozen power/equipment', () => {
    const { service, repo, runtime } = fixture();
    repo.savePet({ ...repo.getPet('pet-2')!, xp: cumulativeXpAtLevel(4) });
    repo.addInventory('ration', 1);
    const first = departPrepared(service, 'meadow-prepared', input('pet-1', DEMO_ROUTE.routeId));
    const second = departPrepared(service, 'forest-prepared', input('pet-2', 'mist-forest', [{ itemId: 'ration', quantity: 1 }]));
    const firstId = first.snapshot.pets[0]!.trip!.tripId;
    const secondId = second.snapshot.pets[1]!.trip!.tripId;
    runtime.at = START + 60 * MINUTE;
    const settled = requestTravelReports(service);
    const reports = settled.reports;
    expect(reports.total).toBe(2);
    expect(reports.rows.map(report => report.tripId)).toEqual([secondId, firstId]);
    expect(reports.rows.every(report => report.loadout !== null && report.facts.at(-1)?.type === 'TRIP_RETURNED')).toBe(true);
    expect(requestTravelReports(service, { offset: 1, limit: 1 }).reports.rows).toEqual([reports.rows[1]]);
    expect(requestTravelReports(service, { petId: 'pet-1', offset: 0, limit: 1 }).reports.rows).toEqual([reports.rows[1]]);
    expect(requestTravelReports(service, { offset: 20, limit: 20 }).reports.rows).toEqual([]);
    const raw = command('report-marked', 'TRIP_REPORT_READ', { petId: 'pet-1', tripId: firstId });
    const marked = success(service.dispatch(raw));
    const read = requestTravelReports(service, { petId: 'pet-1', offset: 0, limit: 1 }).reports.rows[0]!;
    expect(read).toEqual({ ...reports.rows[1], readAt: runtime.at });
    expect(success(service.dispatch(raw))).toEqual(marked);
    expect(repo.getTripDepartureLoadout(firstId)).toEqual(read.loadout);
    expect(repo.listRewards(firstId).map(({kind,targetId,amount}) => ({kind,targetId,amount}))).toEqual(read.rewards);
    expect(service.handleRequest({ schemaVersion: 1, requestId: 'missing-pet-history', method: 'travel/reports', payload: { petId: 'absent', offset: 0, limit: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
