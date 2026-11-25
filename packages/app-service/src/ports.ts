import type {
  Activity, AppSnapshot, CgAssetRef, DomainEvent, HealthStatus, IpcErrorCode, Mood, Presence, Visibility, PinnedCgAssetRef,
} from '@pet-desktop/contracts';
import type { EventListQuery, EventReward } from '@pet-desktop/contracts/events';
import type { EventHistoryEntry, EventSelectionResult, EventTrigger, FrozenEventOccurrence } from '@pet-desktop/domain/event-engine';
import type { EquipmentSlot } from '@pet-desktop/contracts/inventory';
import type { TripDepartureLoadout, TravelReportsQuery } from '@pet-desktop/contracts/travel';
import type { TripDepartureLoadoutRecord } from './trip-departure-storage.js';
import type { AiStateStorage } from './ai-state-storage.js';
import type { AiProactiveStorage } from './ai-proactive-storage.js';
import type { WorkspaceStorage } from './workspace-storage.js';
import type { VoiceProfileStorage } from './voice-profile-storage.js';
import type { HostPreferenceStorage } from './host-preference-storage.js';
export type { TripDepartureLoadoutRecord } from './trip-departure-storage.js';
import type { RewardDraft, TripCheckpoint, TripFact, TripSnapshot } from '@pet-desktop/domain';

/** Storage numbers are fixed-point tenths. Renderer DTOs use 0–100. */
export interface PetRecord {
  petId: string;
  characterId: string;
  nickname: string;
  power: number;
  presence: Presence;
  activity: Activity | null;
  mood: Mood;
  healthStatus: HealthStatus;
  visibility: Visibility;
  moodScore10: number;
  healthPoints10: number;
  energy10: number;
  bond10: number;
  xp: number;
  revision: number;
}

/** Immutable metadata recorded with a newly obtained pet instance. Older
 * archives can contain a pet without this sidecar; its acquisition time is
 * unknown rather than invented during migration. */
export interface PetAcquisitionRecord {
  petId: string;
  acquiredAt: number;
  origin: 'STARTER' | 'GAME';
  catalogVersion: number;
  coinCost: number;
  commandId: string | null;
}

/** Persisted deterministic HOME simulation clock, independent of pet state. */
export interface HomeScheduleRecord {
  petId: string;
  lastSimAt: number;
  activityDueAt: number | null;
  energyRemainder: number;
  healthRemainder: number;
  moodRemainder: number;
  interactionDay: number;
  interactionCount: number;
  lastInteractionAt: number | null;
}

export interface PreferencesRecord {
  revision: number;
  logicalTime: number;
  primaryPetId: string | null;
  doNotDisturb: boolean;
  pausedRender: boolean;
}

export interface TripRecord {
  snapshot: TripSnapshot;
  checkpoint: TripCheckpoint;
  status: 'TRAVELING' | 'SETTLED';
  reportReadAt: number | null;
}

export type CommandOutcome =
  | { ok: true; snapshot: AppSnapshot }
  | { ok: false; error: { code: IpcErrorCode; message: string; retryable: boolean } };

export interface CommandReceipt {
  commandId: string;
  /** Exact canonical serialization of a parsed, closed command. */
  fingerprint: string;
  outcome: CommandOutcome;
  createdAt: number;
}

export interface RewardLine {
  rewardKey: string;
  sourceType: 'TRIP';
  sourceId: string;
  petId: string;
  kind: 'XP' | 'COIN' | 'ITEM' | 'CG';
  targetId: string;
  amount: number;
}

export interface SettlementRecord {
  tripId: string;
  settledAt: number;
  rewards: RewardDraft;
}

export interface InventoryItem {
  itemId: string;
  quantity: number;
}

/** Active equipment instance. The repository retains a private tombstone
 * when salvaged so that a previously granted ID can never be reused. */
export interface ItemInstanceRecord {
  instanceId: string;
  definitionId: string;
  definitionVersion: number;
  enhancement: number;
  acquiredAt: number;
}

export interface PetEquipmentRecord {
  petId: string;
  slot: EquipmentSlot;
  instanceId: string;
}

export interface CommerceMaterialAmount { itemId: string; quantity: number }
interface CommerceOperationBase { commandId: string; occurredAt: number; catalogVersion: number }

/** Game-coin/stack/equipment operations are separate from the deterministic
 * trip ledger. Exactly one operation belongs to each successful command. */
export type CommerceOperationRecord = CommerceOperationBase & (
  | { type: 'SHOP_PURCHASE'; offerId: string; itemId: string; quantity: number; coinCost: number;
    outputKind: 'STACK' | 'EQUIPMENT'; instanceIds: readonly string[] }
  | { type: 'EQUIPMENT_EQUIP'; petId: string; slot: EquipmentSlot; instanceId: string; previousInstanceId: string | null }
  | { type: 'EQUIPMENT_UNEQUIP'; petId: string; slot: EquipmentSlot; instanceId: string }
  | { type: 'EQUIPMENT_UPGRADE'; instanceId: string; fromEnhancement: number; toEnhancement: number;
    coinCost: number; materials: readonly CommerceMaterialAmount[] }
  | { type: 'EQUIPMENT_SALVAGE'; instanceId: string; enhancement: number; materials: readonly CommerceMaterialAmount[] }
  | { type: 'ITEM_USE'; petId: string; itemId: string }
);

export interface CgUnlockInput {
  petId: string;
  cgId: string;
  variant: string;
  sourceTripId: string;
  unlockedAt: number;
}

/** The first acquisition freezes its source event and asset identity forever. */
export interface CgUnlock extends CgUnlockInput {
  assetRef: CgAssetRef;
  historicalCharacterId: string | null;
  historicalEventDefId: string | null;
  favorite: boolean;
  viewedAt: number | null;
}

/** A potential CG and its content reference frozen at departure. */
export interface TripCgAssetPin {
  tripId: string;
  petId: string;
  cgId: string;
  variant: string;
  characterId: string;
  eventDefId: string;
  assetRef: Exclude<CgAssetRef, { state: 'LEGACY_UNVERSIONED' }>;
}

/** Persistent selection audit, including a decision not to create an event. */
export type EventTriggerReceipt = {
  triggerKey: string; petId: string; trigger: EventTrigger; seed: number; at: number;
  rngState: number; drawCount: 0 | 1 | 2; sourceTripId: string | null; routeId: string | null;
} & ({kind: 'NO_EVENT'; reason: Extract<EventSelectionResult, {kind:'NO_EVENT'}>['reason']}
  | {kind:'OCCURRENCE'; occurrenceId: string});

/** Frozen historical definition and separately committed actual effects. */
export interface EventOccurrenceRecord {
  occurrence: FrozenEventOccurrence;
  status: 'PENDING' | 'RESOLVED' | 'EXPIRED';
  resolvedAt: number | null; choiceId: string | null; resultText: string | null;
  rewards: EventReward[]; commandId: string | null;
}
export interface EventFinalizationRecord {
  occurrenceId: string; status: 'RESOLVED' | 'EXPIRED'; resolvedAt: number;
  choiceId: string | null; resultText: string; rewards: EventReward[]; commandId: string | null;
}
/** A narrative unlock has an occurrence source, never a fictitious trip. */
export interface EventCgUnlock {
  petId: string; cgId: string; variant: string; sourceEventId: string; unlockedAt: number;
  assetRef: PinnedCgAssetRef; historicalCharacterId: string; historicalEventDefId: string;
  favorite: boolean; viewedAt: number | null;
}

export interface OutboxRecord {
  seq: number;
  event: DomainEvent;
}

/** No method is callable from a renderer. Only app-service owns this transaction. */
export interface AppTransaction {
  /** Same exclusive SQLite transaction and lifetime; neither view owns a connection. */
  aiState(): AiStateStorage;
  proactive(): AiProactiveStorage;
  workspaceState(): WorkspaceStorage;
  voiceProfiles(): VoiceProfileStorage;
  hostPreferences(): HostPreferenceStorage;
  getPreferences(): PreferencesRecord | null;
  savePreferences(record: PreferencesRecord): void;
  listPets(): PetRecord[];
  getPet(petId: string): PetRecord | null;
  savePet(pet: PetRecord): void;
  getPetAcquisition(petId: string): PetAcquisitionRecord | null;
  insertPetAcquisition(record: PetAcquisitionRecord): void;
  getHomeSchedule(petId: string): HomeScheduleRecord | null;
  saveHomeSchedule(record: HomeScheduleRecord): void;
  listTrips(): TripRecord[];
  listSettledTrips(query: TravelReportsQuery): { total: number; trips: TripRecord[] };
  getFirstRuinsBossVictory(petId: string): { tripId: string; earnedAt: number } | null;
  getTrip(tripId: string): TripRecord | null;
  /** Authority sets the second argument for every new real departure; the
   * default false remains solely for old low-level fixture/legacy APIs. */
  insertTrip(trip: TripRecord, departureLoadoutRequired?: boolean): void;
  insertTripDepartureLoadout(record: TripDepartureLoadoutRecord): void;
  getTripDepartureLoadout(tripId: string): TripDepartureLoadout | null;
  updateTrip(trip: TripRecord): void;
  appendTripFacts(tripId: string, facts: readonly TripFact[]): void;
  listTripFacts(tripId: string): TripFact[];
  getSettlement(tripId: string): SettlementRecord | null;
  insertSettlement(settlement: SettlementRecord): boolean;
  insertReward(line: RewardLine): boolean;
  listRewards(sourceId: string): RewardLine[];
  getEventTriggerReceipt(triggerKey: string): EventTriggerReceipt | null;
  insertEventTriggerReceipt(record: EventTriggerReceipt): void;
  insertEventOccurrence(occurrence: FrozenEventOccurrence): void;
  getEventOccurrence(occurrenceId: string): EventOccurrenceRecord | null;
  listEventHistory(petId: string, at: number): EventHistoryEntry[];
  countPendingEvents(petId?: string): number;
  listDueEvents(at: number): EventOccurrenceRecord[];
  listEvents(query: EventListQuery): { total: number; pendingTotal: number; events: EventOccurrenceRecord[] };
  finalizeEventOccurrence(record: EventFinalizationRecord): boolean;
  getWalletCoins(): number;
  setWalletCoins(coins: number): void;
  listInventory(): InventoryItem[];
  addInventory(itemId: string, quantity: number): void;
  listItemInstances(): ItemInstanceRecord[];
  getItemInstance(instanceId: string): ItemInstanceRecord | null;
  insertItemInstance(record: ItemInstanceRecord): void;
  upgradeItemInstance(instanceId: string, expectedEnhancement: number): ItemInstanceRecord;
  deleteItemInstance(instanceId: string): void;
  listPetEquipment(petId?: string): PetEquipmentRecord[];
  getPetEquipment(petId: string, slot: EquipmentSlot): PetEquipmentRecord | null;
  getInstanceEquipment(instanceId: string): PetEquipmentRecord | null;
  equipItem(record: PetEquipmentRecord): void;
  unequipItem(petId: string, slot: EquipmentSlot, expectedInstanceId: string): void;
  getCommerceOperation(commandId: string): CommerceOperationRecord | null;
  insertCommerceOperation(record: CommerceOperationRecord): void;
  insertTripCgAssetPin(pin: TripCgAssetPin): void;
  listTripCgAssetPins(tripId: string): TripCgAssetPin[];
  getCgUnlock(petId: string, cgId: string, variant: string): CgUnlock | null;
  listCgUnlocks(petId: string): CgUnlock[];
  getEventCgUnlock(petId: string, cgId: string, variant: string): EventCgUnlock | null;
  listEventCgUnlocks(petId: string): EventCgUnlock[];
  unlockCg(unlock: CgUnlockInput): boolean;
  setCgFavorite(petId: string, cgId: string, variant: string, favorite: boolean): boolean;
  markCgViewed(petId: string, cgId: string, variant: string, characterId: string, eventDefId: string,
    assetVersion: string, assetHash: string, viewedAt: number): boolean;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  hasCommandReceipts(): boolean;
  saveCommandReceipt(receipt: CommandReceipt): void;
  appendOutbox(event: DomainEvent): void;
  listOutbox(afterSeq: number, limit: number): OutboxRecord[];
}

export interface AppRepository {
  transaction<T>(action: (tx: AppTransaction) => T): T;
  close(): void;
}

/** Narrow synchronous SQL interface; both candidate drivers are adapted here. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** Trusted filesystem boundary for an explicitly selected backup export.
 * The stage is a unique app-owned temporary path on the destination volume;
 * publication must be atomic and exclusive (never replace an existing file).
 * Neither this port nor a destination path is exposed to renderer IPC. */
export interface BackupExportStage {
  readonly filename: string;
  publishVerified(): void;
  dispose(): void;
}
export interface BackupExportIo {
  stage(destination: string): BackupExportStage;
  openReadOnly(filename: string): SqliteConnection;
}

export interface AppRuntime {
  now(): number;
  createId(kind: 'trip' | 'event' | 'request' | 'pet' | 'item'): string;
  seed(): number;
}
