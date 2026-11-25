import type {
  Activity, AppSnapshot, CgAssetRef, DomainEvent, HealthStatus, IpcErrorCode, Mood, Presence, Visibility,
} from '@pet-desktop/contracts';
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

export interface OutboxRecord {
  seq: number;
  event: DomainEvent;
}

/** No method is callable from a renderer. Only app-service owns this transaction. */
export interface AppTransaction {
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
  getTrip(tripId: string): TripRecord | null;
  insertTrip(trip: TripRecord): void;
  updateTrip(trip: TripRecord): void;
  appendTripFacts(tripId: string, facts: readonly TripFact[]): void;
  listTripFacts(tripId: string): TripFact[];
  getSettlement(tripId: string): SettlementRecord | null;
  insertSettlement(settlement: SettlementRecord): boolean;
  insertReward(line: RewardLine): boolean;
  listRewards(sourceId: string): RewardLine[];
  getWalletCoins(): number;
  setWalletCoins(coins: number): void;
  listInventory(): InventoryItem[];
  addInventory(itemId: string, quantity: number): void;
  insertTripCgAssetPin(pin: TripCgAssetPin): void;
  listTripCgAssetPins(tripId: string): TripCgAssetPin[];
  getCgUnlock(petId: string, cgId: string, variant: string): CgUnlock | null;
  listCgUnlocks(petId: string): CgUnlock[];
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

export interface AppRuntime {
  now(): number;
  createId(kind: 'trip' | 'event' | 'request' | 'pet'): string;
  seed(): number;
}
