import {
  activitySchema, appSnapshotSchema, cgAssetRefSchema, domainCommandSchema, domainEventSchema, healthStatusSchema,
  idSchema, ipcErrorCodeSchema, moodSchema, presenceSchema, visibilitySchema,
} from '@pet-desktop/contracts';
import type { CgAssetRef, DomainEvent } from '@pet-desktop/contracts';
import { advanceTrip, MAX_TRIP_FACTS, MAX_TRIP_NODES } from '@pet-desktop/domain';
import type { RewardDraft, TripCheckpoint, TripFact, TripSnapshot } from '@pet-desktop/domain';
import type {
  AppRepository, AppTransaction, CgUnlock, CgUnlockInput, CommandOutcome, CommandReceipt, InventoryItem, OutboxRecord,
  PetRecord, PreferencesRecord, RewardLine, SettlementRecord, SqliteConnection, TripCgAssetPin, TripRecord,
} from './ports.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UINT32_MAX = 0xffff_ffff;
const BUSY_TIMEOUT_MS = 5_000;
const SCHEMA_VERSION = 2;
const JSON_SCHEMA_VERSION = 1;
const MIGRATION_001_JSON_SCHEMA_VERSION = 1;
const MIGRATION_001_MAX_TRIP_FACTS = 14;

// Keep migration 001 immutable after release. New versions must add numbered migrations.
// Only data needed by the present ports is created: no speculative tables or private memory.
const idCheck = (column: string) => `length(${column}) BETWEEN 1 AND 128
  AND ${column} GLOB '[A-Za-z0-9]*' AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const unsigned = (column: string) => `${column} BETWEEN 0 AND ${MAX_SAFE}`;
const positive = (column: string) => `${column} BETWEEN 1 AND ${MAX_SAFE}`;
const jsonObject = (column: string) => `json_valid(${column}) AND json_type(${column}) = 'object'`;

export const MIGRATION_001 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK (version > 0),
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (${unsigned('applied_at')})
) STRICT;
CREATE TABLE pets (
  pet_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('pet_id')}),
  character_id TEXT NOT NULL CHECK (${idCheck('character_id')}),
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL CHECK (${unsigned('revision')})
) STRICT;
CREATE TABLE pet_states (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  presence TEXT NOT NULL CHECK (presence IN ('HOME','AWAY','RETURNING')),
  activity TEXT CHECK (activity IN ('IDLE','WALK','DRAG','INTERACT','CHAT','EAT','REST','SLEEP','CELEBRATE')),
  mood TEXT NOT NULL CHECK (mood IN ('CALM','HAPPY','EXCITED','BORED','UPSET','TIRED')),
  health_status TEXT NOT NULL CHECK (health_status IN ('NORMAL','INJURED','RECOVERING')),
  visibility TEXT NOT NULL CHECK (visibility IN ('VISIBLE','HIDDEN')),
  mood_score10 INTEGER NOT NULL CHECK (mood_score10 BETWEEN 0 AND 1000),
  health_points10 INTEGER NOT NULL CHECK (health_points10 BETWEEN 0 AND 1000),
  energy10 INTEGER NOT NULL CHECK (energy10 BETWEEN 0 AND 1000),
  bond10 INTEGER NOT NULL CHECK (bond10 BETWEEN 0 AND 1000),
  CHECK ((presence = 'HOME' AND activity IS NOT NULL) OR (presence <> 'HOME' AND activity IS NULL))
) STRICT;
CREATE INDEX pet_states_presence ON pet_states(presence);
CREATE TABLE pet_progression (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id),
  power INTEGER NOT NULL CHECK (power BETWEEN 1 AND 1000),
  xp INTEGER NOT NULL CHECK (${unsigned('xp')})
) STRICT;
CREATE TABLE preferences (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (${unsigned('revision')}),
  logical_time INTEGER NOT NULL CHECK (${unsigned('logical_time')}),
  primary_pet_id TEXT REFERENCES pets(pet_id),
  do_not_disturb INTEGER NOT NULL CHECK (do_not_disturb IN (0,1)),
  paused_render INTEGER NOT NULL CHECK (paused_render IN (0,1))
) STRICT;
CREATE TABLE trips (
  trip_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('trip_id')} AND length(trip_id) <= 125),
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  route_id TEXT NOT NULL CHECK (${idCheck('route_id')}),
  status TEXT NOT NULL CHECK (status IN ('TRAVELING','SETTLED')),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 1 AND ${UINT32_MAX}),
  snapshot_json TEXT NOT NULL CHECK (${jsonObject('snapshot_json')}),
  checkpoint_json TEXT NOT NULL CHECK (${jsonObject('checkpoint_json')}),
  json_schema_version INTEGER NOT NULL CHECK (json_schema_version = ${MIGRATION_001_JSON_SCHEMA_VERSION}),
  start_at INTEGER NOT NULL CHECK (${unsigned('start_at')}),
  expected_return_at INTEGER NOT NULL CHECK (${unsigned('expected_return_at')} AND expected_return_at > start_at),
  actual_returned_at INTEGER CHECK (${unsigned('actual_returned_at')} AND actual_returned_at BETWEEN start_at AND expected_return_at),
  next_due_at INTEGER CHECK (${unsigned('next_due_at')} AND next_due_at BETWEEN start_at AND expected_return_at),
  rules_version TEXT NOT NULL CHECK (length(rules_version) > 0),
  UNIQUE (trip_id, pet_id),
  CHECK ((status = 'TRAVELING' AND actual_returned_at IS NULL AND next_due_at IS NOT NULL)
    OR (status = 'SETTLED' AND actual_returned_at IS NOT NULL AND next_due_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_trip ON trips(pet_id) WHERE status = 'TRAVELING';
CREATE INDEX active_trip_due ON trips(next_due_at, pet_id, trip_id) WHERE status = 'TRAVELING';
CREATE TRIGGER freeze_trip_snapshot BEFORE UPDATE ON trips
WHEN OLD.trip_id IS NOT NEW.trip_id OR OLD.pet_id IS NOT NEW.pet_id OR OLD.route_id IS NOT NEW.route_id
  OR OLD.seed IS NOT NEW.seed OR OLD.snapshot_json IS NOT NEW.snapshot_json
  OR OLD.json_schema_version IS NOT NEW.json_schema_version OR OLD.start_at IS NOT NEW.start_at
  OR OLD.expected_return_at IS NOT NEW.expected_return_at OR OLD.rules_version IS NOT NEW.rules_version
BEGIN SELECT RAISE(ABORT, 'trip snapshot is immutable'); END;
CREATE TRIGGER freeze_settled_trip BEFORE UPDATE ON trips WHEN OLD.status = 'SETTLED'
  AND (OLD.status IS NOT NEW.status OR OLD.checkpoint_json IS NOT NEW.checkpoint_json
    OR OLD.actual_returned_at IS NOT NEW.actual_returned_at OR OLD.next_due_at IS NOT NEW.next_due_at)
BEGIN SELECT RAISE(ABORT, 'settled trip is immutable'); END;
CREATE TABLE trip_events (
  trip_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND ${MIGRATION_001_MAX_TRIP_FACTS}),
  event_id TEXT NOT NULL UNIQUE CHECK (${idCheck('event_id')}),
  scheduled_at INTEGER NOT NULL CHECK (${unsigned('scheduled_at')}),
  type TEXT NOT NULL CHECK (type IN ('GATHER_RESOLVED','BATTLE_RESOLVED','EVENT_RESOLVED','RETURNING','TRIP_RETURNED')),
  payload_json TEXT NOT NULL CHECK (${jsonObject('payload_json')}),
  json_schema_version INTEGER NOT NULL CHECK (json_schema_version = ${MIGRATION_001_JSON_SCHEMA_VERSION}),
  PRIMARY KEY (trip_id, seq),
  FOREIGN KEY (trip_id, pet_id) REFERENCES trips(trip_id, pet_id),
  CHECK (event_id = trip_id || ':' || seq)
) STRICT;
CREATE INDEX trip_event_schedule ON trip_events(trip_id, scheduled_at, seq);
CREATE TABLE settlements (
  trip_id TEXT PRIMARY KEY NOT NULL REFERENCES trips(trip_id),
  settled_at INTEGER NOT NULL CHECK (${unsigned('settled_at')}),
  rewards_json TEXT NOT NULL CHECK (${jsonObject('rewards_json')}),
  json_schema_version INTEGER NOT NULL CHECK (json_schema_version = ${MIGRATION_001_JSON_SCHEMA_VERSION})
) STRICT;
CREATE TABLE trip_reports (
  trip_id TEXT PRIMARY KEY NOT NULL REFERENCES settlements(trip_id),
  read_at INTEGER CHECK (${unsigned('read_at')})
) STRICT;
CREATE INDEX trip_report_read ON trip_reports(read_at);
CREATE TABLE reward_ledger (
  reward_key TEXT PRIMARY KEY NOT NULL CHECK (length(reward_key) > 0),
  source_type TEXT NOT NULL CHECK (source_type = 'TRIP'),
  source_id TEXT NOT NULL REFERENCES settlements(trip_id),
  pet_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('XP','COIN','ITEM','CG')),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  amount INTEGER NOT NULL CHECK (${positive('amount')}),
  UNIQUE (source_type, source_id, pet_id, kind, target_id),
  FOREIGN KEY (source_id, pet_id) REFERENCES trips(trip_id, pet_id)
) STRICT;
CREATE INDEX reward_source ON reward_ledger(source_type, source_id);
CREATE INDEX reward_pet ON reward_ledger(pet_id, reward_key);
CREATE TABLE wallet (
  currency TEXT PRIMARY KEY NOT NULL CHECK (currency = 'coin'),
  balance INTEGER NOT NULL CHECK (${unsigned('balance')})
) STRICT;
INSERT INTO wallet(currency, balance) VALUES ('coin', 0);
CREATE TABLE inventory (
  item_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('item_id')}),
  quantity INTEGER NOT NULL CHECK (${unsigned('quantity')})
) STRICT;
CREATE TABLE cg_unlocks (
  pet_id TEXT NOT NULL,
  cg_id TEXT NOT NULL CHECK (${idCheck('cg_id')}),
  variant TEXT NOT NULL CHECK (${idCheck('variant')}),
  source_trip_id TEXT NOT NULL REFERENCES settlements(trip_id),
  unlocked_at INTEGER NOT NULL CHECK (${unsigned('unlocked_at')}),
  PRIMARY KEY (pet_id, cg_id, variant),
  FOREIGN KEY (source_trip_id, pet_id) REFERENCES trips(trip_id, pet_id)
) STRICT;
CREATE INDEX cg_unlock_pet_time ON cg_unlocks(pet_id, unlocked_at);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('command_id')}),
  fingerprint TEXT NOT NULL CHECK (${jsonObject('fingerprint')}),
  outcome_json TEXT NOT NULL CHECK (${jsonObject('outcome_json')}),
  json_schema_version INTEGER NOT NULL CHECK (json_schema_version = ${MIGRATION_001_JSON_SCHEMA_VERSION}),
  created_at INTEGER NOT NULL CHECK (${unsigned('created_at')})
) STRICT;
CREATE INDEX commands_created ON commands(created_at);
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL CHECK (${positive('seq')}),
  event_id TEXT NOT NULL UNIQUE CHECK (${idCheck('event_id')}),
  type TEXT NOT NULL CHECK (${idCheck('type')}),
  aggregate_id TEXT NOT NULL CHECK (${idCheck('aggregate_id')}),
  revision INTEGER NOT NULL CHECK (${unsigned('revision')}),
  occurred_at INTEGER NOT NULL CHECK (${unsigned('occurred_at')}),
  causation_id TEXT NOT NULL CHECK (${idCheck('causation_id')}),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  payload_json TEXT NOT NULL CHECK (${jsonObject('payload_json')})
) STRICT;
`;

// SQL counterparts of the current stable version and digest constraints.
// Keep these migration-local so future contract edits do not rewrite history.
const migration002VersionCheck = (column: string): string => {
  const firstDot = `instr(${column}, '.')`;
  const suffix = `substr(${column}, ${firstDot} + 1)`;
  const secondDot = `instr(${suffix}, '.')`;
  const parts = [`substr(${column}, 1, ${firstDot} - 1)`, `substr(${suffix}, 1, ${secondDot} - 1)`, `substr(${suffix}, ${secondDot} + 1)`];
  return `length(${column}) BETWEEN 5 AND 17 AND ${column} NOT GLOB '*[^0-9.]*'
    AND length(${column}) - length(replace(${column}, '.', '')) = 2
    AND ${parts.map(part => `length(${part}) BETWEEN 1 AND 5 AND CAST(${part} AS INTEGER) BETWEEN 0 AND 65535`).join(' AND ')}
    AND ${column} = printf('%d.%d.%d', ${parts.map(part => `CAST(${part} AS INTEGER)`).join(', ')})`;
};
const migration002HashCheck = (column: string) => `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;

// Existing trips never acquire invented departure metadata. Only newly
// inserted v2 trips may receive pins; old v1 in-flight trips can complete with
// an explicit legacy reference. Copy old unlock identities without guessing.
const MIGRATION_002 = `
ALTER TABLE trips ADD COLUMN cg_pin_schema INTEGER NOT NULL DEFAULT 1 CHECK (cg_pin_schema IN (1,2));
CREATE TRIGGER freeze_trip_cg_pin_schema BEFORE UPDATE ON trips
WHEN OLD.cg_pin_schema IS NOT NEW.cg_pin_schema
BEGIN SELECT RAISE(ABORT, 'trip CG pin schema is immutable'); END;
CREATE TRIGGER require_v2_trip_cg_pin_schema BEFORE INSERT ON trips
WHEN NEW.cg_pin_schema <> 2
BEGIN SELECT RAISE(ABORT, 'new trip must use CG pin schema 2'); END;
CREATE TABLE trip_cg_asset_pins (
  trip_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  cg_id TEXT NOT NULL CHECK (${idCheck('cg_id')}),
  variant TEXT NOT NULL CHECK (${idCheck('variant')}),
  character_id TEXT NOT NULL CHECK (${idCheck('character_id')}),
  event_def_id TEXT NOT NULL CHECK (${idCheck('event_def_id')}),
  asset_state TEXT NOT NULL CHECK (asset_state IN ('PINNED','UNAVAILABLE_AT_DEPARTURE')),
  asset_version TEXT CHECK (${migration002VersionCheck('asset_version')}),
  asset_hash TEXT CHECK (${migration002HashCheck('asset_hash')}),
  PRIMARY KEY (trip_id, cg_id, variant),
  FOREIGN KEY (trip_id, pet_id) REFERENCES trips(trip_id, pet_id),
  CHECK ((asset_state = 'PINNED' AND asset_version IS NOT NULL AND asset_hash IS NOT NULL)
    OR (asset_state = 'UNAVAILABLE_AT_DEPARTURE' AND asset_version IS NULL AND asset_hash IS NULL))
) STRICT;
CREATE TRIGGER validate_trip_cg_pin BEFORE INSERT ON trip_cg_asset_pins
WHEN EXISTS (SELECT 1 FROM trip_cg_asset_pins x WHERE x.trip_id=NEW.trip_id AND x.cg_id=NEW.cg_id AND x.variant=NEW.variant)
  OR NOT EXISTS (
    SELECT 1 FROM trips t JOIN pets p ON p.pet_id=t.pet_id
    WHERE t.trip_id=NEW.trip_id AND t.pet_id=NEW.pet_id AND p.character_id=NEW.character_id AND t.cg_pin_schema=2
      AND t.status='TRAVELING' AND json_extract(t.checkpoint_json,'$.phase')='OUTBOUND'
      AND json_extract(t.checkpoint_json,'$.sequence')=0 AND json_extract(t.checkpoint_json,'$.logicalTime')=t.start_at
      AND NOT EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id=t.trip_id)
      AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.trip_id=t.trip_id)
      AND EXISTS (SELECT 1 FROM json_each(t.snapshot_json,'$.nodes') n WHERE json_extract(n.value,'$.kind')='EVENT'
        AND json_extract(n.value,'$.cgId')=NEW.cg_id AND json_extract(n.value,'$.eventDefId')=NEW.event_def_id)
  )
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate departure CG pin'); END;
CREATE TRIGGER freeze_trip_cg_pin BEFORE UPDATE ON trip_cg_asset_pins
BEGIN SELECT RAISE(ABORT, 'departure CG pin is immutable'); END;
CREATE TRIGGER preserve_trip_cg_pin BEFORE DELETE ON trip_cg_asset_pins
BEGIN SELECT RAISE(ABORT, 'departure CG pin is immutable'); END;
ALTER TABLE cg_unlocks RENAME TO cg_unlocks_v1;
CREATE TABLE cg_unlocks (
  pet_id TEXT NOT NULL,
  cg_id TEXT NOT NULL CHECK (${idCheck('cg_id')}),
  variant TEXT NOT NULL CHECK (${idCheck('variant')}),
  source_trip_id TEXT NOT NULL REFERENCES settlements(trip_id),
  unlocked_at INTEGER NOT NULL CHECK (${unsigned('unlocked_at')}),
  asset_state TEXT NOT NULL CHECK (asset_state IN ('PINNED','LEGACY_UNVERSIONED','UNAVAILABLE_AT_DEPARTURE')),
  historical_character_id TEXT CHECK (${idCheck('historical_character_id')}),
  historical_event_def_id TEXT CHECK (${idCheck('historical_event_def_id')}),
  asset_version TEXT CHECK (${migration002VersionCheck('asset_version')}),
  asset_hash TEXT CHECK (${migration002HashCheck('asset_hash')}),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  viewed_at INTEGER CHECK (${unsigned('viewed_at')} AND viewed_at >= unlocked_at),
  PRIMARY KEY (pet_id, cg_id, variant),
  FOREIGN KEY (source_trip_id, pet_id) REFERENCES trips(trip_id, pet_id),
  CHECK ((asset_state='LEGACY_UNVERSIONED' AND historical_character_id IS NULL AND historical_event_def_id IS NULL
      AND asset_version IS NULL AND asset_hash IS NULL AND viewed_at IS NULL)
    OR (asset_state='UNAVAILABLE_AT_DEPARTURE' AND historical_character_id IS NOT NULL AND historical_event_def_id IS NOT NULL
      AND asset_version IS NULL AND asset_hash IS NULL AND viewed_at IS NULL)
    OR (asset_state='PINNED' AND historical_character_id IS NOT NULL AND historical_event_def_id IS NOT NULL
      AND asset_version IS NOT NULL AND asset_hash IS NOT NULL))
) STRICT;
INSERT INTO cg_unlocks(pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state)
SELECT pet_id,cg_id,variant,source_trip_id,unlocked_at,'LEGACY_UNVERSIONED' FROM cg_unlocks_v1;
DROP TABLE cg_unlocks_v1;
CREATE INDEX cg_unlock_pet_time ON cg_unlocks(pet_id, unlocked_at);
CREATE TRIGGER validate_new_cg_unlock BEFORE INSERT ON cg_unlocks
WHEN NEW.favorite <> 0 OR NEW.viewed_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM cg_unlocks u WHERE u.pet_id=NEW.pet_id AND u.cg_id=NEW.cg_id AND u.variant=NEW.variant)
  OR NOT EXISTS (SELECT 1 FROM trips t JOIN settlements s USING(trip_id)
    WHERE t.trip_id=NEW.source_trip_id AND t.pet_id=NEW.pet_id AND t.status='TRAVELING' AND s.settled_at=NEW.unlocked_at
      AND EXISTS (SELECT 1 FROM json_each(s.rewards_json,'$.cgIds') c WHERE c.value=NEW.cg_id)
      AND EXISTS (SELECT 1 FROM reward_ledger r WHERE r.source_type='TRIP' AND r.source_id=t.trip_id
        AND r.pet_id=NEW.pet_id AND r.kind='CG' AND r.target_id=NEW.cg_id || ':' || NEW.variant AND r.amount=1))
  OR (NEW.asset_state='LEGACY_UNVERSIONED' AND NOT EXISTS (SELECT 1 FROM trips t
    WHERE t.trip_id=NEW.source_trip_id AND t.cg_pin_schema=1))
  OR (NEW.asset_state<>'LEGACY_UNVERSIONED' AND NOT EXISTS (SELECT 1 FROM trip_cg_asset_pins p
    WHERE p.trip_id=NEW.source_trip_id AND p.pet_id=NEW.pet_id AND p.cg_id=NEW.cg_id AND p.variant=NEW.variant
      AND p.character_id=NEW.historical_character_id AND p.event_def_id=NEW.historical_event_def_id
      AND p.asset_state=NEW.asset_state AND p.asset_version IS NEW.asset_version AND p.asset_hash IS NEW.asset_hash))
BEGIN SELECT RAISE(ABORT, 'invalid CG unlock source or departure pin'); END;
CREATE TRIGGER freeze_cg_unlock BEFORE UPDATE ON cg_unlocks
WHEN OLD.pet_id IS NOT NEW.pet_id OR OLD.cg_id IS NOT NEW.cg_id OR OLD.variant IS NOT NEW.variant
  OR OLD.source_trip_id IS NOT NEW.source_trip_id OR OLD.unlocked_at IS NOT NEW.unlocked_at
  OR OLD.asset_state IS NOT NEW.asset_state OR OLD.historical_character_id IS NOT NEW.historical_character_id
  OR OLD.historical_event_def_id IS NOT NEW.historical_event_def_id OR OLD.asset_version IS NOT NEW.asset_version
  OR OLD.asset_hash IS NOT NEW.asset_hash OR (OLD.viewed_at IS NOT NULL AND OLD.viewed_at IS NOT NEW.viewed_at)
BEGIN SELECT RAISE(ABORT, 'CG acquisition or first view is immutable'); END;
CREATE TRIGGER preserve_cg_unlock BEFORE DELETE ON cg_unlocks
BEGIN SELECT RAISE(ABORT, 'CG acquisition is immutable'); END;
`;

const MIGRATIONS = Object.freeze([
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
]);

/** FNV-1a is a migration-change detector, not a security signature. */
function migrationChecksum(sql: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sql.length; index++) {
    hash = Math.imul(hash ^ sql.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

type ObjectMap = Record<string, unknown>;

function object(value: unknown, label: string): ObjectMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as ObjectMap;
}

function closed(value: unknown, label: string, keys: readonly string[]): ObjectMap {
  const data = object(value, label);
  const actual = Object.keys(data);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) {
    throw new Error(`Invalid ${label}: unexpected or absent fields`);
  }
  return data;
}

function integer(value: unknown, label: string, min = 0, max = MAX_SAFE): number {
  // Some synchronous drivers can return all integral columns as bigint.
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: expected safe integer in [${min}, ${max}]`);
  }
  return n;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function string(value: unknown, label: string, max = MAX_SAFE): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`Invalid ${label}: expected nonempty bounded string`);
  }
  return value;
}

function id(value: unknown): string {
  return idSchema.parse(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}: expected boolean`);
  return value;
}

function sqlBoolean(value: unknown, label: string): boolean {
  return integer(value, label, 0, 1) === 1;
}

function enumeration<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}: expected bounded array`);
  return value;
}

function parseJson(value: unknown, label: string): unknown {
  return JSON.parse(string(value, label)) as unknown;
}

/** Stable field ordering for comparing semantic JSON records, not overwriting the exact command fingerprint. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const fields = object(item, 'JSON record');
      return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
    }
    return item;
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function jsonVersion(row: ObjectMap): void {
  if (integer(row.json_schema_version, 'JSON schema version') !== JSON_SCHEMA_VERSION) {
    throw new Error('Unsupported persisted JSON schema version');
  }
}

function validateRewardDraft(value: unknown): RewardDraft {
  const data = closed(value, 'reward draft', ['xp', 'coins', 'items', 'cgIds']);
  const items = array(data.items, 'reward items', MAX_TRIP_NODES).map((raw) => {
    const item = closed(raw, 'reward item', ['itemId', 'quantity']);
    return { itemId: id(item.itemId), quantity: integer(item.quantity, 'reward quantity', 1) };
  });
  const cgIds = array(data.cgIds, 'reward CG IDs', MAX_TRIP_NODES).map(id);
  for (const ids of [items.map((item) => item.itemId), cgIds]) {
    if (ids.some((current, index) => index > 0 && current <= ids[index - 1]!)) {
      throw new Error('Persisted reward IDs must be sorted and unique');
    }
  }
  return { xp: integer(data.xp, 'reward XP'), coins: integer(data.coins, 'reward coins'), items, cgIds };
}

function validateSnapshot(value: unknown): TripSnapshot {
  const snapshot = closed(value, 'trip snapshot', [
    'tripId', 'petId', 'routeId', 'contentVersion', 'nodes', 'returnDurationMs', 'startAt',
    'expectedReturnAt', 'seed', 'power', 'rulesVersion', 'contentHash',
  ]);
  id(snapshot.tripId); id(snapshot.petId); id(snapshot.routeId);
  integer(snapshot.contentVersion, 'content version', 1);
  integer(snapshot.returnDurationMs, 'return duration', 1);
  integer(snapshot.startAt, 'start time'); integer(snapshot.expectedReturnAt, 'expected return time');
  integer(snapshot.seed, 'seed', 1, UINT32_MAX); integer(snapshot.power, 'power', 1, 1000);
  string(snapshot.rulesVersion, 'rules version'); string(snapshot.contentHash, 'content hash');
  const common = ['kind', 'nodeId', 'durationMs'];
  for (const raw of array(snapshot.nodes, 'route nodes', MAX_TRIP_NODES)) {
    const data = object(raw, 'route node');
    const kind = enumeration(data.kind, 'node kind', ['GATHER', 'BATTLE', 'EVENT']);
    id(data.nodeId); integer(data.durationMs, 'node duration', 1);
    switch (kind) {
      case 'GATHER':
        closed(data, 'gather node', [...common, 'itemId', 'minQuantity', 'maxQuantity', 'xp']);
        id(data.itemId); integer(data.minQuantity, 'minimum quantity', 1);
        integer(data.maxQuantity, 'maximum quantity', 1); integer(data.xp, 'node XP');
        break;
      case 'BATTLE':
        closed(data, 'battle node', [...common, 'enemyId', 'enemyPower', 'winXp', 'winCoins', 'lossXp', 'drop']);
        id(data.enemyId); integer(data.enemyPower, 'enemy power', 1, 1000);
        integer(data.winXp, 'win XP'); integer(data.winCoins, 'win coins'); integer(data.lossXp, 'loss XP');
        if (data.drop !== null) {
          const drop = closed(data.drop, 'drop', ['itemId', 'quantity', 'chanceBps']);
          id(drop.itemId); integer(drop.quantity, 'drop quantity', 1); integer(drop.chanceBps, 'drop probability', 0, 10_000);
        }
        break;
      case 'EVENT':
        closed(data, 'event node', [...common, 'eventDefId', 'cgId', 'chanceBps']);
        id(data.eventDefId); id(data.cgId); integer(data.chanceBps, 'event probability', 0, 10_000);
        break;
    }
  }
  // Every field and nested discriminator is now checked. The versioned domain
  // validator additionally checks route bounds, rules version and content hash.
  return snapshot as unknown as TripSnapshot;
}

function validateCheckpoint(value: unknown): TripCheckpoint {
  const checkpoint = closed(value, 'trip checkpoint', [
    'tripId', 'phase', 'nodeIndex', 'rngState', 'drawCount', 'sequence', 'logicalTime',
    'nextDueAt', 'returnReason', 'actualReturnedAt', 'rewardDraft',
  ]);
  id(checkpoint.tripId);
  enumeration(checkpoint.phase, 'trip phase', ['OUTBOUND', 'RETURNING', 'COMPLETE']);
  integer(checkpoint.nodeIndex, 'node index', 0, MAX_TRIP_NODES);
  integer(checkpoint.rngState, 'random state', 1, UINT32_MAX);
  integer(checkpoint.drawCount, 'draw count', 0, MAX_TRIP_NODES * 2);
  integer(checkpoint.sequence, 'fact sequence', 0, MAX_TRIP_FACTS);
  integer(checkpoint.logicalTime, 'logical time'); nullableInteger(checkpoint.nextDueAt, 'next due time');
  nullableInteger(checkpoint.actualReturnedAt, 'return time');
  if (checkpoint.returnReason !== null) {
    enumeration(checkpoint.returnReason, 'return reason', ['COMPLETED', 'RECALLED', 'DEFEATED']);
  }
  validateRewardDraft(checkpoint.rewardDraft);
  return checkpoint as unknown as TripCheckpoint;
}

function validateTrip(record: TripRecord): TripRecord {
  const snapshot = validateSnapshot(record.snapshot);
  const checkpoint = validateCheckpoint(record.checkpoint);
  // At its own logical time a valid checkpoint performs no new events; this
  // reuses the domain's bounded snapshot/cursor validation. Full replay against
  // persisted facts, settlements and rewards belongs to app-service recovery.
  const checked = advanceTrip(snapshot, checkpoint, checkpoint.logicalTime);
  const status = enumeration(record.status, 'trip status', ['TRAVELING', 'SETTLED']);
  if (checked.facts.length !== 0 || checked.status !== status) throw new Error('Trip status contradicts checkpoint');
  const reportReadAt = nullableInteger(record.reportReadAt, 'report read time');
  if (status === 'TRAVELING' && reportReadAt !== null) throw new Error('Active trip has no report');
  return { snapshot, checkpoint, status, reportReadAt };
}

function validateFact(value: unknown): TripFact {
  const fact = closed(value, 'trip fact', ['eventId', 'tripId', 'petId', 'sequence', 'scheduledAt', 'type', 'payload']);
  const tripId = id(fact.tripId), sequence = integer(fact.sequence, 'fact sequence', 1, MAX_TRIP_FACTS);
  id(fact.petId); integer(fact.scheduledAt, 'scheduled time');
  if (id(fact.eventId) !== `${tripId}:${sequence}`) throw new Error('Trip fact has a noncanonical event ID');
  const type = enumeration(fact.type, 'trip fact type', [
    'GATHER_RESOLVED', 'BATTLE_RESOLVED', 'EVENT_RESOLVED', 'RETURNING', 'TRIP_RETURNED',
  ]);
  switch (type) {
    case 'GATHER_RESOLVED': {
      const p = closed(fact.payload, 'gather fact', ['nodeId', 'itemId', 'quantity', 'xp']);
      id(p.nodeId); id(p.itemId); integer(p.quantity, 'gather quantity', 1); integer(p.xp, 'gather XP');
      break;
    }
    case 'BATTLE_RESOLVED': {
      const p = closed(fact.payload, 'battle fact', ['nodeId', 'enemyId', 'outcome', 'winChanceBps', 'xp', 'coins', 'drop']);
      id(p.nodeId); id(p.enemyId); enumeration(p.outcome, 'battle outcome', ['WIN', 'LOSS']);
      integer(p.winChanceBps, 'win probability', 0, 10_000); integer(p.xp, 'battle XP'); integer(p.coins, 'battle coins');
      if (p.drop !== null) {
        const drop = closed(p.drop, 'battle drop', ['itemId', 'quantity']);
        id(drop.itemId); integer(drop.quantity, 'drop quantity', 1);
      }
      break;
    }
    case 'EVENT_RESOLVED': {
      const p = closed(fact.payload, 'event fact', ['nodeId', 'eventDefId', 'cgId']);
      id(p.nodeId); id(p.eventDefId); if (p.cgId !== null) id(p.cgId);
      break;
    }
    case 'RETURNING': {
      const p = closed(fact.payload, 'return fact', ['reason', 'dueAt']);
      enumeration(p.reason, 'return reason', ['COMPLETED', 'RECALLED', 'DEFEATED']);
      integer(p.dueAt, 'return due time');
      break;
    }
    case 'TRIP_RETURNED': {
      const p = closed(fact.payload, 'arrival fact', ['reason', 'actualReturnedAt']);
      enumeration(p.reason, 'arrival reason', ['COMPLETED', 'RECALLED', 'DEFEATED']);
      integer(p.actualReturnedAt, 'arrival time');
      break;
    }
  }
  return fact as unknown as TripFact;
}

function validatePet(pet: PetRecord): PetRecord {
  const result = {
    petId: id(pet.petId), characterId: id(pet.characterId), nickname: string(pet.nickname, 'nickname', 80),
    power: integer(pet.power, 'power', 1, 1000), presence: presenceSchema.parse(pet.presence),
    activity: activitySchema.nullable().parse(pet.activity), mood: moodSchema.parse(pet.mood),
    healthStatus: healthStatusSchema.parse(pet.healthStatus), visibility: visibilitySchema.parse(pet.visibility),
    moodScore10: integer(pet.moodScore10, 'mood score', 0, 1000),
    healthPoints10: integer(pet.healthPoints10, 'health points', 0, 1000),
    energy10: integer(pet.energy10, 'energy', 0, 1000), bond10: integer(pet.bond10, 'bond', 0, 1000),
    xp: integer(pet.xp, 'XP'), revision: integer(pet.revision, 'pet revision'),
  };
  if ((result.presence === 'HOME') !== (result.activity !== null)) throw new Error('Pet presence contradicts activity');
  return result;
}

function petFromRow(value: unknown): PetRecord {
  const row = object(value, 'pet row');
  return validatePet({
    petId: id(row.pet_id), characterId: id(row.character_id), nickname: string(row.nickname, 'nickname', 80),
    power: integer(row.power, 'power'), presence: presenceSchema.parse(row.presence), activity: activitySchema.nullable().parse(row.activity),
    mood: moodSchema.parse(row.mood), healthStatus: healthStatusSchema.parse(row.health_status), visibility: visibilitySchema.parse(row.visibility),
    moodScore10: integer(row.mood_score10, 'mood score'), healthPoints10: integer(row.health_points10, 'health points'),
    energy10: integer(row.energy10, 'energy'), bond10: integer(row.bond10, 'bond'),
    xp: integer(row.xp, 'XP'), revision: integer(row.revision, 'pet revision'),
  });
}

const PET_SELECT = `SELECT p.*, s.presence, s.activity, s.mood, s.health_status, s.visibility,
  s.mood_score10, s.health_points10, s.energy10, s.bond10, g.power, g.xp
  FROM pets p LEFT JOIN pet_states s USING(pet_id) LEFT JOIN pet_progression g USING(pet_id)`;
const TRIP_SELECT = `SELECT t.*, r.read_at AS report_read_at, r.trip_id AS report_trip_id
  FROM trips t LEFT JOIN trip_reports r USING(trip_id)`;

function tripFromRow(value: unknown): TripRecord {
  const row = object(value, 'trip row'); jsonVersion(row);
  const trip = validateTrip({
    snapshot: validateSnapshot(parseJson(row.snapshot_json, 'trip snapshot JSON')),
    checkpoint: validateCheckpoint(parseJson(row.checkpoint_json, 'trip checkpoint JSON')),
    status: enumeration(row.status, 'trip status', ['TRAVELING', 'SETTLED']),
    reportReadAt: nullableInteger(row.report_read_at, 'report read time'),
  });
  const { snapshot, checkpoint, status } = trip;
  if (snapshot.tripId !== row.trip_id || snapshot.petId !== row.pet_id || snapshot.routeId !== row.route_id
    || snapshot.seed !== integer(row.seed, 'trip seed') || snapshot.startAt !== integer(row.start_at, 'trip start')
    || snapshot.expectedReturnAt !== integer(row.expected_return_at, 'expected return') || snapshot.rulesVersion !== row.rules_version
    || checkpoint.actualReturnedAt !== nullableInteger(row.actual_returned_at, 'actual return')
    || checkpoint.nextDueAt !== nullableInteger(row.next_due_at, 'next due time')
    || row.report_trip_id !== (status === 'SETTLED' ? snapshot.tripId : null)) {
    throw new Error('Trip indexed columns or report contradict persisted snapshot/checkpoint');
  }
  return trip;
}

function factFromRow(value: unknown): TripFact {
  const row = object(value, 'trip fact row'); jsonVersion(row);
  return validateFact({ eventId: row.event_id, tripId: row.trip_id, petId: row.pet_id,
    sequence: integer(row.seq, 'fact sequence'), scheduledAt: integer(row.scheduled_at, 'fact time'),
    type: row.type, payload: parseJson(row.payload_json, 'fact payload JSON') });
}

function rewardFromRow(value: unknown): RewardLine {
  const row = object(value, 'reward row');
  return validateRewardLine({ rewardKey: string(row.reward_key, 'reward key'), sourceType: enumeration(row.source_type, 'reward source', ['TRIP']),
    sourceId: id(row.source_id), petId: id(row.pet_id), kind: enumeration(row.kind, 'reward kind', ['XP', 'COIN', 'ITEM', 'CG']),
    targetId: string(row.target_id, 'reward target'), amount: integer(row.amount, 'reward amount', 1) });
}

function validateRewardLine(line: RewardLine): RewardLine {
  return { rewardKey: string(line.rewardKey, 'reward key'), sourceType: enumeration(line.sourceType, 'reward source', ['TRIP']),
    sourceId: id(line.sourceId), petId: id(line.petId), kind: enumeration(line.kind, 'reward kind', ['XP', 'COIN', 'ITEM', 'CG']),
    targetId: string(line.targetId, 'reward target'), amount: integer(line.amount, 'reward amount', 1) };
}

function validateCgUnlockInput(value: CgUnlockInput): CgUnlockInput {
  const input = closed(value, 'CG unlock input', ['petId', 'cgId', 'variant', 'sourceTripId', 'unlockedAt']);
  return { petId: id(input.petId), cgId: id(input.cgId), variant: id(input.variant),
    sourceTripId: id(input.sourceTripId), unlockedAt: integer(input.unlockedAt, 'unlock time') };
}

function cgRefFromColumns(row: ObjectMap, characterId: string | null, eventDefId: string | null): CgAssetRef {
  const state = enumeration(row.asset_state, 'CG asset state', ['PINNED', 'LEGACY_UNVERSIONED', 'UNAVAILABLE_AT_DEPARTURE']);
  if (state === 'PINNED') return cgAssetRefSchema.parse({ state, characterId, eventDefId,
    assetVersion: row.asset_version, assetHash: row.asset_hash });
  if (row.asset_version !== null || row.asset_hash !== null) throw new Error('Unversioned CG cannot carry an asset identity');
  if (state === 'LEGACY_UNVERSIONED' ? characterId !== null || eventDefId !== null : characterId === null || eventDefId === null) {
    throw new Error('CG historical identifiers contradict its asset state');
  }
  return cgAssetRefSchema.parse({ state });
}

function cgFromRow(value: unknown): CgUnlock {
  const row = object(value, 'CG unlock row');
  const input = validateCgUnlockInput({ petId: id(row.pet_id), cgId: id(row.cg_id), variant: id(row.variant),
    sourceTripId: id(row.source_trip_id), unlockedAt: integer(row.unlocked_at, 'unlock time') });
  const historicalCharacterId = row.historical_character_id === null ? null : id(row.historical_character_id);
  const historicalEventDefId = row.historical_event_def_id === null ? null : id(row.historical_event_def_id);
  const assetRef = cgRefFromColumns(row, historicalCharacterId, historicalEventDefId);
  const viewedAt = nullableInteger(row.viewed_at, 'CG first view time');
  if (viewedAt !== null && (assetRef.state !== 'PINNED' || viewedAt < input.unlockedAt)) throw new Error('Invalid CG first view time');
  return { ...input, assetRef, historicalCharacterId, historicalEventDefId,
    favorite: sqlBoolean(row.favorite, 'CG favorite'), viewedAt };
}

function validateTripCgAssetPin(value: unknown): TripCgAssetPin {
  const pin = closed(value, 'trip CG pin', ['tripId', 'petId', 'cgId', 'variant', 'characterId', 'eventDefId', 'assetRef']);
  const characterId = id(pin.characterId), eventDefId = id(pin.eventDefId);
  const assetRef = cgAssetRefSchema.parse(pin.assetRef);
  if (assetRef.state === 'LEGACY_UNVERSIONED') throw new Error('A departure CG pin cannot be legacy');
  if (assetRef.state === 'PINNED' && (assetRef.characterId !== characterId || assetRef.eventDefId !== eventDefId)) {
    throw new Error('CG asset identity contradicts its departure character or event');
  }
  return { tripId: id(pin.tripId), petId: id(pin.petId), cgId: id(pin.cgId), variant: id(pin.variant), characterId, eventDefId, assetRef };
}

function tripCgAssetPinFromRow(value: unknown): TripCgAssetPin {
  const row = object(value, 'trip CG pin row');
  const characterId = id(row.character_id), eventDefId = id(row.event_def_id);
  return validateTripCgAssetPin({ tripId: row.trip_id, petId: row.pet_id, cgId: row.cg_id, variant: row.variant,
    characterId, eventDefId, assetRef: cgRefFromColumns(row, characterId, eventDefId) });
}

function cgVersionHash(ref: CgAssetRef): [string | null, string | null] {
  return ref.state === 'PINNED' ? [ref.assetVersion, ref.assetHash] : [null, null];
}

function tripContainsCg(trip: TripRecord, cgId: string, eventDefId: string): boolean {
  return trip.snapshot.nodes.some(node => node.kind === 'EVENT' && node.cgId === cgId && node.eventDefId === eventDefId);
}

function validateOutcome(value: unknown): CommandOutcome {
  const outcome = object(value, 'command outcome');
  if (outcome.ok === true) {
    closed(outcome, 'successful command outcome', ['ok', 'snapshot']);
    return { ok: true, snapshot: appSnapshotSchema.parse(outcome.snapshot) };
  }
  if (outcome.ok === false) {
    closed(outcome, 'failed command outcome', ['ok', 'error']);
    const error = closed(outcome.error, 'command error', ['code', 'message', 'retryable']);
    return { ok: false, error: { code: ipcErrorCodeSchema.parse(error.code), message: string(error.message, 'error message', 512),
      retryable: boolean(error.retryable, 'error retryability') } };
  }
  throw new Error('Invalid command outcome discriminator');
}

function validateReceipt(receipt: CommandReceipt): CommandReceipt {
  const commandId = id(receipt.commandId);
  const fingerprint = string(receipt.fingerprint, 'command fingerprint');
  const command = domainCommandSchema.parse(parseJson(fingerprint, 'command fingerprint JSON'));
  if (command.commandId !== commandId) throw new Error('Command fingerprint belongs to another command');
  if (canonicalJson(command) !== fingerprint) throw new Error('Command fingerprint is not canonical');
  return { commandId, fingerprint, outcome: validateOutcome(receipt.outcome), createdAt: integer(receipt.createdAt, 'command time') };
}

function outboxFromRow(value: unknown): OutboxRecord {
  const row = object(value, 'outbox row');
  return { seq: integer(row.seq, 'outbox sequence', 1), event: domainEventSchema.parse({
    eventId: row.event_id, type: row.type, aggregateId: row.aggregate_id,
    revision: integer(row.revision, 'event revision'), occurredAt: integer(row.occurred_at, 'event time'),
    causationId: row.causation_id, schemaVersion: integer(row.schema_version, 'event schema version'),
    payload: parseJson(row.payload_json, 'event payload JSON'),
  }) };
}

class SQLiteTransaction implements AppTransaction {
  private readonly connection: SqliteConnection;
  private readonly inScope: () => boolean;

  constructor(connection: SqliteConnection, inScope: () => boolean) {
    this.connection = connection;
    this.inScope = inScope;
  }

  private get db(): SqliteConnection {
    if (!this.inScope()) throw new Error('Transaction is no longer active');
    return this.connection;
  }

  getPreferences(): PreferencesRecord | null {
    const value = this.db.prepare('SELECT * FROM preferences WHERE singleton = 1').get();
    if (value === undefined || value === null) return null;
    const row = object(value, 'preferences row');
    return { revision: integer(row.revision, 'preferences revision'), logicalTime: integer(row.logical_time, 'logical time'),
      primaryPetId: row.primary_pet_id === null ? null : id(row.primary_pet_id),
      doNotDisturb: sqlBoolean(row.do_not_disturb, 'do not disturb'), pausedRender: sqlBoolean(row.paused_render, 'paused render') };
  }

  savePreferences(record: PreferencesRecord): void {
    this.db.prepare(`INSERT INTO preferences VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision, logical_time=excluded.logical_time,
      primary_pet_id=excluded.primary_pet_id, do_not_disturb=excluded.do_not_disturb, paused_render=excluded.paused_render`)
      .run(integer(record.revision, 'preferences revision'), integer(record.logicalTime, 'logical time'),
        record.primaryPetId === null ? null : id(record.primaryPetId), Number(boolean(record.doNotDisturb, 'do not disturb')),
        Number(boolean(record.pausedRender, 'paused render')));
  }

  listPets(): PetRecord[] {
    return this.db.prepare(`${PET_SELECT} ORDER BY p.pet_id`).all().map(petFromRow);
  }

  getPet(petId: string): PetRecord | null {
    const value = this.db.prepare(`${PET_SELECT} WHERE p.pet_id = ?`).get(id(petId));
    return value === undefined || value === null ? null : petFromRow(value);
  }

  savePet(pet: PetRecord): void {
    const db = this.db;
    const p = validatePet(pet);
    db.prepare(`INSERT INTO pets VALUES (?, ?, ?, ?) ON CONFLICT(pet_id) DO UPDATE SET
      character_id=excluded.character_id, nickname=excluded.nickname, revision=excluded.revision`)
      .run(p.petId, p.characterId, p.nickname, p.revision);
    db.prepare(`INSERT INTO pet_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pet_id) DO UPDATE SET
      presence=excluded.presence, activity=excluded.activity, mood=excluded.mood, health_status=excluded.health_status,
      visibility=excluded.visibility, mood_score10=excluded.mood_score10, health_points10=excluded.health_points10,
      energy10=excluded.energy10, bond10=excluded.bond10`)
      .run(p.petId, p.presence, p.activity, p.mood, p.healthStatus, p.visibility, p.moodScore10, p.healthPoints10, p.energy10, p.bond10);
    db.prepare(`INSERT INTO pet_progression VALUES (?, ?, ?) ON CONFLICT(pet_id) DO UPDATE SET power=excluded.power, xp=excluded.xp`)
      .run(p.petId, p.power, p.xp);
  }

  listTrips(): TripRecord[] {
    return this.db.prepare(`${TRIP_SELECT} ORDER BY t.start_at, t.pet_id, t.trip_id`).all().map(tripFromRow);
  }

  getTrip(tripId: string): TripRecord | null {
    const value = this.db.prepare(`${TRIP_SELECT} WHERE t.trip_id = ?`).get(id(tripId));
    return value === undefined || value === null ? null : tripFromRow(value);
  }

  insertTrip(record: TripRecord): void {
    const db = this.db;
    const { snapshot: s, checkpoint: c, status } = validateTrip(record);
    if (status !== 'TRAVELING' || c.phase !== 'OUTBOUND' || c.sequence !== 0) throw new Error('New trip must begin outbound');
    db.prepare(`INSERT INTO trips (trip_id, pet_id, route_id, status, seed, snapshot_json, checkpoint_json,
      json_schema_version, start_at, expected_return_at, actual_returned_at, next_due_at, rules_version, cg_pin_schema)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`)
      .run(s.tripId, s.petId, s.routeId, status, s.seed, canonicalJson(s), canonicalJson(c), JSON_SCHEMA_VERSION,
        s.startAt, s.expectedReturnAt, c.actualReturnedAt, c.nextDueAt, s.rulesVersion);
  }

  updateTrip(record: TripRecord): void {
    const db = this.db;
    const trip = validateTrip(record), { snapshot: s, checkpoint: c, status } = trip;
    const original = this.getTrip(s.tripId);
    if (original === null) throw new Error('Trip does not exist');
    if (!sameJson(original.snapshot, s)) throw new Error('Trip snapshot is immutable');
    if (original.status === 'SETTLED') {
      if (status !== 'SETTLED' || !sameJson(original.checkpoint, c)) throw new Error('Settled trip is immutable');
      if (original.reportReadAt !== null && (trip.reportReadAt === null || trip.reportReadAt < original.reportReadAt)) {
        throw new Error('Trip report read time cannot regress');
      }
    } else {
      if (c.logicalTime < original.checkpoint.logicalTime || c.sequence < original.checkpoint.sequence) {
        throw new Error('Trip checkpoint cannot regress');
      }
      const facts = this.listTripFacts(s.tripId);
      if (facts.length !== c.sequence) throw new Error('Checkpoint sequence does not match persisted facts');
      if (status === 'SETTLED') {
        const settlement = this.getSettlement(s.tripId);
        if (settlement === null || !sameJson(settlement.rewards, c.rewardDraft)) {
          throw new Error('Completed trip requires a matching settlement');
        }
        db.prepare('INSERT INTO trip_reports (trip_id, read_at) VALUES (?, ?)').run(s.tripId, trip.reportReadAt);
      }
      db.prepare(`UPDATE trips SET status=?, checkpoint_json=?, actual_returned_at=?, next_due_at=? WHERE trip_id=?`)
        .run(status, canonicalJson(c), c.actualReturnedAt, c.nextDueAt, s.tripId);
    }
    if (status === 'SETTLED') db.prepare('UPDATE trip_reports SET read_at=? WHERE trip_id=?').run(trip.reportReadAt, s.tripId);
  }

  appendTripFacts(tripId: string, facts: readonly TripFact[]): void {
    const db = this.db;
    const trip = this.getTrip(tripId);
    if (trip === null) throw new Error('Trip does not exist');
    const previous = this.listTripFacts(tripId);
    for (const raw of facts) {
      const fact = validateFact(raw);
      if (fact.tripId !== tripId || fact.petId !== trip.snapshot.petId) throw new Error('Trip fact belongs to another trip or pet');
      const existing = previous[fact.sequence - 1];
      if (existing !== undefined) {
        if (!sameJson(existing, fact)) throw new Error('Conflicting trip fact');
        continue;
      }
      if (trip.status === 'SETTLED') throw new Error('Cannot append facts to a settled trip');
      if (fact.sequence !== previous.length + 1 || fact.scheduledAt < (previous.at(-1)?.scheduledAt ?? trip.snapshot.startAt)
        || fact.scheduledAt > trip.snapshot.expectedReturnAt) throw new Error('Trip fact sequence or time is invalid');
      db.prepare(`INSERT INTO trip_events (trip_id, pet_id, seq, event_id, scheduled_at, type, payload_json, json_schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tripId, fact.petId, fact.sequence, fact.eventId, fact.scheduledAt, fact.type, canonicalJson(fact.payload), JSON_SCHEMA_VERSION);
      previous.push(fact);
    }
  }

  listTripFacts(tripId: string): TripFact[] {
    const facts = this.db.prepare('SELECT * FROM trip_events WHERE trip_id=? ORDER BY seq').all(id(tripId)).map(factFromRow);
    for (const [index, fact] of facts.entries()) {
      if (fact.sequence !== index + 1 || (index > 0 && fact.scheduledAt < facts[index - 1]!.scheduledAt)) {
        throw new Error('Persisted trip facts are not contiguous or chronological');
      }
    }
    return facts;
  }

  getSettlement(tripId: string): SettlementRecord | null {
    const value = this.db.prepare('SELECT * FROM settlements WHERE trip_id=?').get(id(tripId));
    if (value === undefined || value === null) return null;
    const row = object(value, 'settlement row'); jsonVersion(row);
    return { tripId: id(row.trip_id), settledAt: integer(row.settled_at, 'settlement time'),
      rewards: validateRewardDraft(parseJson(row.rewards_json, 'settlement rewards JSON')) };
  }

  insertSettlement(record: SettlementRecord): boolean {
    const db = this.db;
    const settlement = { tripId: id(record.tripId), settledAt: integer(record.settledAt, 'settlement time'), rewards: validateRewardDraft(record.rewards) };
    const existing = this.getSettlement(settlement.tripId);
    if (existing !== null) {
      if (!sameJson(existing, settlement)) throw new Error('Conflicting settlement');
      return false;
    }
    const trip = this.getTrip(settlement.tripId);
    if (trip === null || trip.status !== 'TRAVELING') throw new Error('Settlement requires an active trip');
    db.prepare('INSERT INTO settlements VALUES (?, ?, ?, ?)').run(settlement.tripId, settlement.settledAt,
      canonicalJson(settlement.rewards), JSON_SCHEMA_VERSION);
    return true;
  }

  insertReward(record: RewardLine): boolean {
    const db = this.db, line = validateRewardLine(record);
    const candidates = db.prepare(`SELECT * FROM reward_ledger WHERE reward_key=? OR
      (source_type=? AND source_id=? AND pet_id=? AND kind=? AND target_id=?)`)
      .all(line.rewardKey, line.sourceType, line.sourceId, line.petId, line.kind, line.targetId).map(rewardFromRow);
    if (candidates.length > 0) {
      if (candidates.length !== 1 || !sameJson(candidates[0], line)) throw new Error('Conflicting reward ledger line');
      return false;
    }
    const trip = this.getTrip(line.sourceId);
    if (trip === null || trip.status !== 'TRAVELING' || trip.snapshot.petId !== line.petId) throw new Error('Reward requires its active trip');
    db.prepare('INSERT INTO reward_ledger VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(line.rewardKey, line.sourceType, line.sourceId, line.petId, line.kind, line.targetId, line.amount);
    return true;
  }

  listRewards(sourceId: string): RewardLine[] {
    return this.db.prepare('SELECT * FROM reward_ledger WHERE source_type=? AND source_id=? ORDER BY reward_key')
      .all('TRIP', id(sourceId)).map(rewardFromRow);
  }

  getWalletCoins(): number {
    const row = object(this.db.prepare('SELECT balance FROM wallet WHERE currency=?').get('coin'), 'wallet row');
    return integer(row.balance, 'coin balance');
  }

  setWalletCoins(coins: number): void {
    const result = this.db.prepare('UPDATE wallet SET balance=? WHERE currency=?').run(integer(coins, 'coin balance'), 'coin');
    if (integer(result.changes, 'wallet change count') !== 1) throw new Error('Wallet row is missing');
  }

  listInventory(): InventoryItem[] {
    return this.db.prepare('SELECT item_id, quantity FROM inventory ORDER BY item_id').all().map((value) => {
      const row = object(value, 'inventory row');
      return { itemId: id(row.item_id), quantity: integer(row.quantity, 'inventory quantity') };
    });
  }

  addInventory(itemId: string, quantity: number): void {
    const db = this.db, item = id(itemId), delta = integer(quantity, 'inventory delta', -MAX_SAFE);
    if (delta < 0) {
      const result = db.prepare('UPDATE inventory SET quantity=quantity+? WHERE item_id=? AND quantity>=?').run(delta, item, -delta);
      if (integer(result.changes, 'inventory change count') !== 1) throw new Error('Insufficient inventory');
    } else if (delta > 0) {
      const result = db.prepare(`INSERT INTO inventory VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET quantity=inventory.quantity+excluded.quantity
        WHERE inventory.quantity <= ?`).run(item, delta, MAX_SAFE - delta);
      if (integer(result.changes, 'inventory change count') !== 1) throw new Error('Inventory quantity overflow');
    }
  }

  private tripCgPinSchema(tripId: string): number {
    const row = object(this.db.prepare('SELECT cg_pin_schema FROM trips WHERE trip_id=?').get(id(tripId)), 'trip CG pin schema row');
    return integer(row.cg_pin_schema, 'trip CG pin schema', 1, 2);
  }

  private checkedTripCgAssetPin(value: unknown): TripCgAssetPin {
    const pin = tripCgAssetPinFromRow(value), trip = this.getTrip(pin.tripId);
    if (trip === null || this.tripCgPinSchema(pin.tripId) !== 2 || trip.snapshot.petId !== pin.petId
      || !tripContainsCg(trip, pin.cgId, pin.eventDefId)) throw new Error('Persisted CG pin contradicts its trip snapshot');
    return pin;
  }

  private getTripCgAssetPin(tripId: string, cgId: string, variant: string): TripCgAssetPin | null {
    const value = this.db.prepare('SELECT * FROM trip_cg_asset_pins WHERE trip_id=? AND cg_id=? AND variant=?')
      .get(id(tripId), id(cgId), id(variant));
    return value === undefined || value === null ? null : this.checkedTripCgAssetPin(value);
  }

  insertTripCgAssetPin(record: TripCgAssetPin): void {
    const db = this.db, pin = validateTripCgAssetPin(record);
    const existing = this.getTripCgAssetPin(pin.tripId, pin.cgId, pin.variant);
    if (existing !== null) {
      if (!sameJson(existing, pin)) throw new Error('Conflicting departure CG pin');
      return;
    }
    const trip = this.getTrip(pin.tripId), pet = this.getPet(pin.petId);
    if (trip === null || this.tripCgPinSchema(pin.tripId) !== 2 || trip.snapshot.petId !== pin.petId
      || trip.status !== 'TRAVELING' || trip.checkpoint.phase !== 'OUTBOUND' || trip.checkpoint.sequence !== 0
      || trip.checkpoint.logicalTime !== trip.snapshot.startAt
      || this.listTripFacts(pin.tripId).length !== 0 || this.getSettlement(pin.tripId) !== null
      || pet === null || pet.characterId !== pin.characterId || !tripContainsCg(trip, pin.cgId, pin.eventDefId)) {
      throw new Error('CG pin requires a matching new trip at departure');
    }
    const [assetVersion, assetHash] = cgVersionHash(pin.assetRef);
    db.prepare(`INSERT INTO trip_cg_asset_pins (trip_id,pet_id,cg_id,variant,character_id,event_def_id,asset_state,asset_version,asset_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pin.tripId, pin.petId, pin.cgId, pin.variant, pin.characterId,
      pin.eventDefId, pin.assetRef.state, assetVersion, assetHash);
  }

  listTripCgAssetPins(tripId: string): TripCgAssetPin[] {
    return this.db.prepare('SELECT * FROM trip_cg_asset_pins WHERE trip_id=? ORDER BY cg_id, variant').all(id(tripId))
      .map(value => this.checkedTripCgAssetPin(value));
  }

  private checkedCgUnlock(value: unknown): CgUnlock {
    const unlock = cgFromRow(value);
    const pin = this.getTripCgAssetPin(unlock.sourceTripId, unlock.cgId, unlock.variant);
    if (pin === null) {
      if (unlock.assetRef.state !== 'LEGACY_UNVERSIONED' || this.tripCgPinSchema(unlock.sourceTripId) !== 1) {
        throw new Error('Persisted CG unlock is missing its departure pin');
      }
    } else if (pin.petId !== unlock.petId || pin.characterId !== unlock.historicalCharacterId
      || pin.eventDefId !== unlock.historicalEventDefId || !sameJson(pin.assetRef, unlock.assetRef)) {
      throw new Error('Persisted CG unlock contradicts its departure pin');
    }
    return unlock;
  }

  getCgUnlock(petId: string, cgId: string, variant: string): CgUnlock | null {
    const value = this.db.prepare('SELECT * FROM cg_unlocks WHERE pet_id=? AND cg_id=? AND variant=?')
      .get(id(petId), id(cgId), id(variant));
    return value === undefined || value === null ? null : this.checkedCgUnlock(value);
  }

  listCgUnlocks(petId: string): CgUnlock[] {
    return this.db.prepare('SELECT * FROM cg_unlocks WHERE pet_id=? ORDER BY cg_id, variant').all(id(petId))
      .map(value => this.checkedCgUnlock(value));
  }

  unlockCg(record: CgUnlockInput): boolean {
    const db = this.db, unlock = validateCgUnlockInput(record);
    const existing = this.getCgUnlock(unlock.petId, unlock.cgId, unlock.variant);
    if (existing !== null && existing.sourceTripId === unlock.sourceTripId) {
      if (existing.unlockedAt !== unlock.unlockedAt) throw new Error('Conflicting CG unlock from its first source');
      return false;
    }
    const trip = this.getTrip(unlock.sourceTripId);
    if (trip === null || trip.status !== 'TRAVELING' || trip.snapshot.petId !== unlock.petId) throw new Error('CG unlock requires its active trip');
    const settlement = this.getSettlement(unlock.sourceTripId);
    if (settlement === null || settlement.settledAt !== unlock.unlockedAt || !settlement.rewards.cgIds.includes(unlock.cgId)) {
      throw new Error('CG unlock contradicts its settlement');
    }
    if (!this.listRewards(unlock.sourceTripId).some(line => line.sourceType === 'TRIP' && line.sourceId === unlock.sourceTripId
      && line.petId === unlock.petId && line.kind === 'CG' && line.targetId === `${unlock.cgId}:${unlock.variant}` && line.amount === 1)) {
      throw new Error('CG unlock requires its exact reward ledger line');
    }
    const pin = this.getTripCgAssetPin(unlock.sourceTripId, unlock.cgId, unlock.variant);
    if (pin === null && this.tripCgPinSchema(unlock.sourceTripId) !== 1) throw new Error('New trip CG unlock requires its frozen departure pin');
    if (pin !== null && pin.petId !== unlock.petId) throw new Error('Departure pin belongs to another pet');
    // A valid later acquisition cannot rewrite the first unlock, even if its
    // newer content version or availability differs from the first pin.
    if (existing !== null) return false;
    const assetRef: CgAssetRef = pin?.assetRef ?? { state: 'LEGACY_UNVERSIONED' };
    const [assetVersion, assetHash] = cgVersionHash(assetRef);
    db.prepare(`INSERT INTO cg_unlocks (pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state,
      historical_character_id,historical_event_def_id,asset_version,asset_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(unlock.petId, unlock.cgId, unlock.variant, unlock.sourceTripId, unlock.unlockedAt, assetRef.state,
        pin?.characterId ?? null, pin?.eventDefId ?? null, assetVersion, assetHash);
    return true;
  }

  setCgFavorite(petId: string, cgId: string, variant: string, favorite: boolean): boolean {
    const unlock = this.getCgUnlock(petId, cgId, variant), next = boolean(favorite, 'CG favorite');
    if (unlock === null) throw new Error('CG has not been unlocked');
    if (unlock.favorite === next) return false;
    const result = this.db.prepare('UPDATE cg_unlocks SET favorite=? WHERE pet_id=? AND cg_id=? AND variant=?')
      .run(Number(next), unlock.petId, unlock.cgId, unlock.variant);
    if (integer(result.changes, 'CG favorite change count') !== 1) throw new Error('CG favorite update failed');
    return true;
  }

  markCgViewed(petId: string, cgId: string, variant: string, characterId: string, eventDefId: string,
    assetVersion: string, assetHash: string, viewedAt: number): boolean {
    const unlock = this.getCgUnlock(petId, cgId, variant);
    const expectedRef = cgAssetRefSchema.parse({ state: 'PINNED', characterId, eventDefId, assetVersion, assetHash });
    const timestamp = integer(viewedAt, 'CG first view time');
    if (unlock === null) throw new Error('CG has not been unlocked');
    if (unlock.assetRef.state !== 'PINNED' || !sameJson(unlock.assetRef, expectedRef)) throw new Error('CG view requires its exact pinned asset identity');
    if (timestamp < unlock.unlockedAt) throw new Error('CG first view cannot precede unlock');
    if (unlock.viewedAt !== null) return false;
    const result = this.db.prepare('UPDATE cg_unlocks SET viewed_at=? WHERE pet_id=? AND cg_id=? AND variant=? AND viewed_at IS NULL')
      .run(timestamp, unlock.petId, unlock.cgId, unlock.variant);
    if (integer(result.changes, 'CG first view change count') !== 1) throw new Error('CG first view update failed');
    return true;
  }

  getCommandReceipt(commandId: string): CommandReceipt | null {
    const value = this.db.prepare('SELECT * FROM commands WHERE command_id=?').get(id(commandId));
    if (value === undefined || value === null) return null;
    const row = object(value, 'command receipt row'); jsonVersion(row);
    return validateReceipt({ commandId: id(row.command_id), fingerprint: string(row.fingerprint, 'command fingerprint'),
      outcome: validateOutcome(parseJson(row.outcome_json, 'command outcome JSON')), createdAt: integer(row.created_at, 'command time') });
  }

  hasCommandReceipts(): boolean {
    const row = this.db.prepare('SELECT 1 FROM commands LIMIT 1').get();
    return row !== undefined && row !== null;
  }

  saveCommandReceipt(record: CommandReceipt): void {
    const db = this.db, receipt = validateReceipt(record), existing = this.getCommandReceipt(receipt.commandId);
    if (existing !== null) {
      if (!sameJson(existing, receipt)) throw new Error('Conflicting command receipt');
      return;
    }
    db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(receipt.commandId, receipt.fingerprint,
      canonicalJson(receipt.outcome), JSON_SCHEMA_VERSION, receipt.createdAt);
  }

  appendOutbox(record: DomainEvent): void {
    const db = this.db, event = domainEventSchema.parse(record);
    const existing = db.prepare('SELECT * FROM outbox WHERE event_id=?').get(event.eventId);
    if (existing !== undefined && existing !== null) {
      if (!sameJson(outboxFromRow(existing).event, event)) throw new Error('Conflicting outbox event');
      return;
    }
    db.prepare(`INSERT INTO outbox (event_id, type, aggregate_id, revision, occurred_at, causation_id, schema_version, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(event.eventId, event.type, event.aggregateId, event.revision,
        event.occurredAt, event.causationId, event.schemaVersion, canonicalJson(event.payload));
  }

  listOutbox(afterSeq: number, limit: number): OutboxRecord[] {
    return this.db.prepare('SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT ?')
      .all(integer(afterSeq, 'outbox cursor'), integer(limit, 'outbox limit')).map(outboxFromRow);
  }
}

function pragma(db: SqliteConnection, name: 'user_version' | 'journal_mode' | 'foreign_keys' | 'synchronous' | 'timeout'): unknown {
  const statement = name === 'timeout' ? 'PRAGMA busy_timeout' : `PRAGMA ${name}`;
  return object(db.prepare(statement).get(), `${name} pragma`)[name];
}

function requireEngine(db: SqliteConnection): void {
  const version = string(object(db.prepare('SELECT sqlite_version() AS version').get(), 'SQLite version row').version, 'SQLite version');
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) throw new Error(`Unrecognized SQLite version: ${version}`);
  const major = Number(parts[1]), minor = Number(parts[2]), patch = Number(parts[3]);
  // Project baseline is deliberately stricter than accepting unverified backports.
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    throw new Error(`SQLite ${version} is below the project minimum 3.51.3`);
  }
}

function configure(db: SqliteConnection, persistent: boolean): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (persistent) db.exec('PRAGMA journal_mode = WAL');
  const journal = pragma(db, 'journal_mode');
  if (journal !== (persistent ? 'wal' : 'memory')) {
    throw new Error(persistent ? 'Persistent SQLite database requires WAL' : 'Nonpersistent SQLite mode is only for in-memory tests');
  }
  if (!persistent) {
    const main = db.prepare('PRAGMA database_list').all().map((row) => object(row, 'database list row'))
      .find((row) => row.name === 'main');
    if (main?.file !== '') throw new Error('Nonpersistent mode requires an actual in-memory database');
  }
  if (integer(pragma(db, 'foreign_keys'), 'foreign_keys') !== 1
    || integer(pragma(db, 'synchronous'), 'synchronous') !== 2
    || integer(pragma(db, 'timeout'), 'busy_timeout') !== BUSY_TIMEOUT_MS) {
    throw new Error('Failed to configure SQLite safety pragmas');
  }
  // Probe the actual extension, not merely its compile flag. TEMP leaves no memory tables in the save.
  db.exec('CREATE VIRTUAL TABLE temp.__pet_desktop_fts5_probe USING fts5(value)');
  db.exec('DROP TABLE temp.__pet_desktop_fts5_probe');
}

function verifyMigrationHistory(db: SqliteConnection, expectedVersion: number): void {
  const version = integer(pragma(db, 'user_version'), 'database schema version');
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported future database schema ${version}`);
  if (version !== expectedVersion) throw new Error('Database schema version changed before migration');
  if (version === 0) {
    const existing = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (existing !== undefined && existing !== null) throw new Error('Unrecognized nonempty database with schema version 0');
  } else {
    const history = db.prepare('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version').all();
    if (history.length !== version) throw new Error('Database migration history is invalid');
    for (const [index, value] of history.entries()) {
      const migration = MIGRATIONS[index], row = object(value, 'migration row');
      if (migration === undefined || migration.version !== index + 1
        || integer(row.version, 'migration version') !== migration.version) throw new Error('Database migration history is not contiguous');
      if (row.checksum !== migrationChecksum(migration.sql)) throw new Error('Database migration checksum mismatch');
      integer(row.applied_at, 'migration time');
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Database contains foreign-key violations');
}

function rowCount(db: SqliteConnection, query: string): number {
  return integer(object(db.prepare(query).get(), 'migration row count').count, 'migration row count');
}

function migrate(db: SqliteConnection, persistent: boolean, beforeMigration?: (fromVersion: number, toVersion: number) => void): void {
  let version = integer(pragma(db, 'user_version'), 'database schema version');
  // A corrupt source (including bad history and FKs) must not be backed up as
  // a verified upgrade source, and the hook must execute outside a write tx.
  verifyMigrationHistory(db, version);
  if (version > 0 && version < SCHEMA_VERSION) {
    if (persistent && beforeMigration === undefined) throw new Error('Persistent database upgrade requires a pre-migration backup callback');
    if (beforeMigration !== undefined) {
      const result: unknown = beforeMigration(version, SCHEMA_VERSION);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new Error('Pre-migration backup callback must be synchronous');
      }
    }
  }
  // Apply each numbered migration as its own atomic, ordered transition.
  // Starting a failed v2 upgrade leaves the valid v1 archive unchanged.
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) throw new Error('Database migrations are not contiguous');
    db.exec('BEGIN IMMEDIATE');
    try {
      verifyMigrationHistory(db, version);
      const oldCounts = migration.version === 2 ? {
        trips: rowCount(db, 'SELECT count(*) AS count FROM trips'),
        unlocks: rowCount(db, 'SELECT count(*) AS count FROM cg_unlocks'),
      } : null;
      db.exec(migration.sql);
      if (oldCounts !== null && (oldCounts.trips !== rowCount(db, 'SELECT count(*) AS count FROM trips')
        || oldCounts.unlocks !== rowCount(db, 'SELECT count(*) AS count FROM cg_unlocks')
        || oldCounts.trips !== rowCount(db, 'SELECT count(*) AS count FROM trips WHERE cg_pin_schema=1')
        || oldCounts.unlocks !== rowCount(db, `SELECT count(*) AS count FROM cg_unlocks WHERE asset_state='LEGACY_UNVERSIONED'
          AND historical_character_id IS NULL AND historical_event_def_id IS NULL AND asset_version IS NULL AND asset_hash IS NULL
          AND favorite=0 AND viewed_at IS NULL`))) throw new Error('CG migration changed legacy row count or invented historical metadata');
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migrationChecksum(migration.sql), Date.now());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      verifyMigrationHistory(db, migration.version);
      db.exec('COMMIT');
      version = migration.version;
    } catch (error) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Database migration rollback failed'); }
      throw error;
    }
  }
  if (version !== SCHEMA_VERSION) throw new Error('Database migrations did not reach the current schema');
}

/** A synchronous UnitOfWork. The injected driver must be exclusively owned by app-service. */
export class SQLiteRepository implements AppRepository {
  private active = false;
  private closed = false;
  private broken = false;
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection, options: { persistent: boolean; beforeMigration?: (fromVersion: number, toVersion: number) => void }) {
    this.db = db;
    requireEngine(db);
    // Reject newer archives before touching journal mode or migrating any tables.
    const version = integer(pragma(db, 'user_version'), 'database schema version');
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported future database schema ${version}`);
    const persistent = boolean(options.persistent, 'persistent mode');
    configure(db, persistent);
    migrate(db, persistent, options.beforeMigration);
  }

  transaction<T>(action: (tx: AppTransaction) => T): T {
    if (this.closed || this.broken) throw Object.assign(new Error('Repository is unavailable'), { name: 'RepositoryUnavailableError' });
    if (this.active) throw new Error('Nested repository transaction is not allowed');
    this.active = true;
    let begun = false;
    let inScope = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = action(new SQLiteTransaction(this.db, () => inScope));
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result
        && typeof result.then === 'function') {
        // Prevent a native Promise's eventual rejection becoming unhandled after invalidating the transaction.
        if (result instanceof Promise) void result.catch(() => undefined);
        throw new Error('Repository transactions must be synchronous');
      }
      inScope = false;
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      inScope = false;
      if (begun) {
        try { this.db.exec('ROLLBACK'); }
        catch (rollbackError) {
          this.broken = true;
          throw Object.assign(new AggregateError([error, rollbackError], 'Database transaction rollback failed'), { name: 'RepositoryUnavailableError' });
        }
      }
      throw error;
    } finally {
      inScope = false;
      this.active = false;
    }
  }

  close(): void {
    if (this.active) throw new Error('Cannot close repository during transaction');
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
