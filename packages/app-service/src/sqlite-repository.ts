import {
  activitySchema, appSnapshotSchema, cgAssetRefSchema, domainCommandSchema, domainEventSchema, healthStatusSchema,
  idSchema, ipcErrorCodeSchema, moodSchema, presenceSchema, visibilitySchema,
} from '@pet-desktop/contracts';
import type { CgAssetRef, DomainEvent } from '@pet-desktop/contracts';
import type { EquipmentSlot } from '@pet-desktop/contracts/inventory';
import { travelReportsQuerySchema } from '@pet-desktop/contracts/travel';
import type { TripDepartureLoadout, TravelReportsQuery } from '@pet-desktop/contracts/travel';
import { eventListQuerySchema } from '@pet-desktop/contracts/events';
import type { EventListQuery, EventReward } from '@pet-desktop/contracts/events';
import { EVENT_LIMITS, EVENT_TRIGGERS, resolveEventOccurrence, validateFrozenOccurrence } from '@pet-desktop/domain/event-engine';
import type { EventEffectDraft, EventHistoryEntry, FrozenEventOccurrence } from '@pet-desktop/domain/event-engine';
import { canonicalTripDepartureLoadout, validateTripDepartureLoadoutRecord } from '#trip-departure-storage';
import { AI_STATE_MIGRATION_SQL, AiStateStorage } from '#ai-state-storage';
import { WORKSPACE_MIGRATION_SQL, WorkspaceStorage } from '#workspace-storage';
import { VOICE_PROFILE_MIGRATION_SQL, VoiceProfileStorage } from '#voice-profile-storage';
import { advanceTrip, MAX_TRIP_FACTS, MAX_TRIP_NODES } from '@pet-desktop/domain';
import type { RewardDraft, TripCheckpoint, TripFact, TripSnapshot } from '@pet-desktop/domain';
import type {
  AppRepository, AppTransaction, CgUnlock, CgUnlockInput, CommandOutcome, CommandReceipt, CommerceMaterialAmount, CommerceOperationRecord,
  EventCgUnlock, EventFinalizationRecord, EventOccurrenceRecord, EventTriggerReceipt, InventoryItem, ItemInstanceRecord, OutboxRecord, PetEquipmentRecord,
  HomeScheduleRecord, PetAcquisitionRecord, PetRecord, PreferencesRecord, RewardLine, SettlementRecord, SqliteConnection, TripCgAssetPin, TripDepartureLoadoutRecord, TripRecord,
} from './ports.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UINT32_MAX = 0xffff_ffff;
const BUSY_TIMEOUT_MS = 5_000;
const SCHEMA_VERSION = 10;
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
export const MIGRATION_002 = `
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

// An additive sidecar avoids guessing when pets from older saves were
// acquired. GAME metadata references the command receipt committed by the
// same transaction; deferral permits the service to save that receipt last.
const migration003AcquisitionReceiptMatches = (receipt: string, acquisition: string, pet: string) => `
  ${acquisition}.origin='GAME' AND ${acquisition}.acquired_at=${receipt}.created_at
  AND json_extract(${receipt}.fingerprint,'$.commandId')=${receipt}.command_id
  AND json_extract(${receipt}.fingerprint,'$.type')='PET_ACQUIRE'
  AND json_extract(${receipt}.fingerprint,'$.payload.characterId')=${pet}.character_id
  AND json_type(${receipt}.fingerprint,'$.payload.catalogVersion')='integer'
  AND json_extract(${receipt}.fingerprint,'$.payload.catalogVersion')=${acquisition}.catalog_version
  AND json_type(${receipt}.outcome_json,'$.ok')='true'
  AND json_type(${receipt}.outcome_json,'$.snapshot.pets')='array'
  AND EXISTS (SELECT 1 FROM json_each(${receipt}.outcome_json,'$.snapshot.pets') instance
    WHERE json_extract(instance.value,'$.petId')=${acquisition}.pet_id
      AND json_extract(instance.value,'$.characterId')=${pet}.character_id)`;
export const MIGRATION_003 = `
CREATE TABLE pet_acquisitions (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id) CHECK (${idCheck('pet_id')}),
  acquired_at INTEGER NOT NULL CHECK (${unsigned('acquired_at')}),
  origin TEXT NOT NULL CHECK (origin IN ('STARTER','GAME')),
  catalog_version INTEGER NOT NULL CHECK (${positive('catalog_version')}),
  coin_cost INTEGER NOT NULL CHECK (${unsigned('coin_cost')}),
  command_id TEXT UNIQUE CHECK (command_id IS NULL OR (${idCheck('command_id')})),
  FOREIGN KEY (command_id) REFERENCES commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((origin='STARTER' AND coin_cost=0 AND command_id IS NULL)
    OR (origin='GAME' AND command_id IS NOT NULL))
) STRICT;
CREATE TRIGGER reject_duplicate_pet_acquisition BEFORE INSERT ON pet_acquisitions
WHEN EXISTS (SELECT 1 FROM pet_acquisitions a WHERE a.pet_id=NEW.pet_id OR a.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'pet acquisition is immutable and unique'); END;
CREATE TRIGGER reject_historical_pet_acquisition_receipt BEFORE INSERT ON pet_acquisitions
WHEN NEW.origin='GAME' AND EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'pet acquisition command receipt already exists'); END;
CREATE TRIGGER validate_pending_pet_acquisition_receipt BEFORE INSERT ON commands
WHEN (EXISTS (SELECT 1 FROM pet_acquisitions a WHERE a.command_id=NEW.command_id)
    OR (json_extract(NEW.fingerprint,'$.type')='PET_ACQUIRE' AND json_type(NEW.outcome_json,'$.ok')='true'))
  AND (EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
    OR NOT EXISTS (SELECT 1 FROM pet_acquisitions a JOIN pets p USING(pet_id) WHERE a.command_id=NEW.command_id
      AND ${migration003AcquisitionReceiptMatches('NEW','a','p')}))
BEGIN SELECT RAISE(ABORT, 'pet acquisition requires its exact immutable successful receipt'); END;
CREATE TRIGGER freeze_pet_acquisition_receipt BEFORE UPDATE ON commands
WHEN EXISTS (SELECT 1 FROM pet_acquisitions a WHERE a.command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT, 'pet acquisition receipt is immutable'); END;
CREATE TRIGGER reject_orphan_successful_acquisition_receipt_update BEFORE UPDATE ON commands
WHEN json_extract(NEW.fingerprint,'$.type')='PET_ACQUIRE' AND json_type(NEW.outcome_json,'$.ok')='true'
BEGIN SELECT RAISE(ABORT, 'successful pet acquisition receipt cannot be retroactively added'); END;
CREATE TRIGGER preserve_pet_acquisition_receipt BEFORE DELETE ON commands
WHEN EXISTS (SELECT 1 FROM pet_acquisitions a WHERE a.command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT, 'pet acquisition receipt is immutable'); END;
CREATE TRIGGER freeze_pet_acquisition BEFORE UPDATE ON pet_acquisitions
BEGIN SELECT RAISE(ABORT, 'pet acquisition is immutable'); END;
CREATE TRIGGER preserve_pet_acquisition BEFORE DELETE ON pet_acquisitions
BEGIN SELECT RAISE(ABORT, 'pet acquisition is immutable'); END;
CREATE TRIGGER freeze_acquired_pet_character BEFORE UPDATE ON pets
WHEN OLD.character_id IS NOT NEW.character_id AND EXISTS (SELECT 1 FROM pet_acquisitions a WHERE a.pet_id=OLD.pet_id)
BEGIN SELECT RAISE(ABORT, 'acquired pet character is immutable'); END;
CREATE TRIGGER protect_acquired_pet_character_insert BEFORE INSERT ON pets
WHEN EXISTS (SELECT 1 FROM pet_acquisitions a JOIN pets p USING(pet_id)
  WHERE a.pet_id=NEW.pet_id AND p.character_id IS NOT NEW.character_id)
BEGIN SELECT RAISE(ABORT, 'acquired pet character is immutable'); END;
`;

// Persist fractional deterministic home simulation and rewarded-interaction
// history without guessing when old pets last advanced. These limits belong
// to the immutable numbered migration, independent of future balance tuning.
const MIGRATION_004_HOUR_MS = 3_600_000;
const MIGRATION_004_DAY_MS = 86_400_000;
const MIGRATION_004_DAILY_LIMIT = 10;
const migration004ClockRegresses = (previous: string, next: string) => `
  ${next}.last_sim_at < ${previous}.last_sim_at
  OR ${next}.interaction_day < ${previous}.interaction_day
  OR (${next}.interaction_day = ${previous}.interaction_day AND ${next}.interaction_count < ${previous}.interaction_count)
  OR (${previous}.last_interaction_at IS NOT NULL AND (${next}.last_interaction_at IS NULL
    OR ${next}.last_interaction_at < ${previous}.last_interaction_at))`;
export const MIGRATION_004 = `
CREATE TABLE pet_home_schedules (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(pet_id) CHECK (${idCheck('pet_id')}),
  last_sim_at INTEGER NOT NULL CHECK (${unsigned('last_sim_at')}),
  activity_due_at INTEGER CHECK (activity_due_at IS NULL OR (${unsigned('activity_due_at')} AND activity_due_at >= last_sim_at)),
  energy_remainder INTEGER NOT NULL CHECK (energy_remainder BETWEEN 0 AND ${MIGRATION_004_HOUR_MS - 1}),
  health_remainder INTEGER NOT NULL CHECK (health_remainder BETWEEN 0 AND ${MIGRATION_004_HOUR_MS - 1}),
  mood_remainder INTEGER NOT NULL CHECK (mood_remainder BETWEEN 0 AND ${MIGRATION_004_HOUR_MS - 1}),
  interaction_day INTEGER NOT NULL CHECK (${unsigned('interaction_day')} AND interaction_day <= last_sim_at / ${MIGRATION_004_DAY_MS}),
  interaction_count INTEGER NOT NULL CHECK (interaction_count BETWEEN 0 AND ${MIGRATION_004_DAILY_LIMIT}),
  last_interaction_at INTEGER CHECK (last_interaction_at IS NULL OR (${unsigned('last_interaction_at')} AND last_interaction_at <= last_sim_at)),
  CHECK (interaction_count=0 OR (last_interaction_at IS NOT NULL AND last_interaction_at / ${MIGRATION_004_DAY_MS}=interaction_day))
) STRICT;
CREATE TRIGGER prevent_home_schedule_regression_insert BEFORE INSERT ON pet_home_schedules
WHEN EXISTS (SELECT 1 FROM pet_home_schedules previous WHERE previous.pet_id=NEW.pet_id
  AND (${migration004ClockRegresses('previous','NEW')}))
BEGIN SELECT RAISE(ABORT, 'home schedule clock cannot regress'); END;
CREATE TRIGGER prevent_home_schedule_regression_update BEFORE UPDATE ON pet_home_schedules
WHEN OLD.pet_id IS NOT NEW.pet_id OR ${migration004ClockRegresses('OLD','NEW')}
BEGIN SELECT RAISE(ABORT, 'home schedule clock cannot regress or change pet'); END;
CREATE TRIGGER preserve_home_schedule BEFORE DELETE ON pet_home_schedules
BEGIN SELECT RAISE(ABORT, 'home schedule cannot be deleted'); END;
CREATE TRIGGER constrain_home_schedule_logical_time_insert BEFORE INSERT ON pet_home_schedules
WHEN EXISTS (SELECT 1 FROM preferences p WHERE p.singleton=1 AND NEW.last_sim_at>p.logical_time)
BEGIN SELECT RAISE(ABORT, 'home schedule exceeds application logical time'); END;
CREATE TRIGGER constrain_home_schedule_logical_time_update BEFORE UPDATE ON pet_home_schedules
WHEN EXISTS (SELECT 1 FROM preferences p WHERE p.singleton=1 AND NEW.last_sim_at>p.logical_time)
BEGIN SELECT RAISE(ABORT, 'home schedule exceeds application logical time'); END;
CREATE TRIGGER constrain_preferences_home_clocks_insert BEFORE INSERT ON preferences
WHEN EXISTS (SELECT 1 FROM pet_home_schedules s WHERE s.last_sim_at>NEW.logical_time)
BEGIN SELECT RAISE(ABORT, 'application logical time precedes home schedules'); END;
CREATE TRIGGER constrain_preferences_home_clocks_update BEFORE UPDATE ON preferences
WHEN EXISTS (SELECT 1 FROM pet_home_schedules s WHERE s.last_sim_at>NEW.logical_time)
BEGIN SELECT RAISE(ABORT, 'application logical time precedes home schedules'); END;
CREATE TRIGGER preserve_preferences_with_home_clocks BEFORE DELETE ON preferences
WHEN EXISTS (SELECT 1 FROM pet_home_schedules)
BEGIN SELECT RAISE(ABORT, 'application logical clock cannot be deleted'); END;
`;

// Separate owned instance inventory and successful commerce records. Retired
// identities are retained privately, never reused or exposed as live items.
// Operation evidence uses closed scalar columns and bounded relation rows.
const MIGRATION_005_INSTANCE_LIMIT = 500;
const MIGRATION_005_ENHANCEMENT_LIMIT = 5;
const MIGRATION_005_MATERIAL_LIMIT = 16;
const MIGRATION_005_PURCHASE_LIMIT = 100;
const migration005CommerceTypes = "'SHOP_PURCHASE','EQUIPMENT_EQUIP','EQUIPMENT_UNEQUIP','EQUIPMENT_UPGRADE','EQUIPMENT_SALVAGE','ITEM_USE'";
const migration005ReceiptMatches = (receipt: string, operation: string) => `
  json_extract(${receipt}.fingerprint,'$.commandId')=${receipt}.command_id
  AND json_extract(${receipt}.fingerprint,'$.type')=${operation}.operation_type
  AND json_type(${receipt}.fingerprint,'$.expectedRevision')='integer'
  AND json_extract(${receipt}.fingerprint,'$.expectedRevision')>=0
  AND json_type(${receipt}.fingerprint,'$.payload.catalogVersion')='integer'
  AND json_extract(${receipt}.fingerprint,'$.payload.catalogVersion')=${operation}.catalog_version
  AND ${receipt}.created_at=${operation}.occurred_at AND json_type(${receipt}.outcome_json,'$.ok')='true'
  AND json_type(${receipt}.outcome_json,'$.snapshot.revision')='integer'
  AND json_extract(${receipt}.outcome_json,'$.snapshot.revision')=json_extract(${receipt}.fingerprint,'$.expectedRevision')+1
  AND json_type(${receipt}.outcome_json,'$.snapshot.walletCoins')='integer'
  AND EXISTS (SELECT 1 FROM wallet w WHERE w.currency='coin' AND w.balance=json_extract(${receipt}.outcome_json,'$.snapshot.walletCoins'))
  AND CASE ${operation}.operation_type
    WHEN 'SHOP_PURCHASE' THEN json_extract(${receipt}.fingerprint,'$.payload.offerId')=${operation}.offer_id
      AND json_extract(${receipt}.fingerprint,'$.payload.quantity')=${operation}.quantity
    WHEN 'EQUIPMENT_EQUIP' THEN json_extract(${receipt}.fingerprint,'$.payload.petId')=${operation}.pet_id
      AND json_extract(${receipt}.fingerprint,'$.payload.slot')=${operation}.slot
      AND json_extract(${receipt}.fingerprint,'$.payload.instanceId')=${operation}.instance_id
    WHEN 'EQUIPMENT_UNEQUIP' THEN json_extract(${receipt}.fingerprint,'$.payload.petId')=${operation}.pet_id
      AND json_extract(${receipt}.fingerprint,'$.payload.slot')=${operation}.slot
    WHEN 'EQUIPMENT_UPGRADE' THEN json_extract(${receipt}.fingerprint,'$.payload.instanceId')=${operation}.instance_id
      AND json_extract(${receipt}.fingerprint,'$.payload.expectedEnhancement')=${operation}.from_enhancement
    WHEN 'EQUIPMENT_SALVAGE' THEN json_extract(${receipt}.fingerprint,'$.payload.instanceId')=${operation}.instance_id
      AND json_extract(${receipt}.fingerprint,'$.payload.expectedEnhancement')=${operation}.from_enhancement
    WHEN 'ITEM_USE' THEN json_extract(${receipt}.fingerprint,'$.payload.petId')=${operation}.pet_id
      AND json_extract(${receipt}.fingerprint,'$.payload.itemId')=${operation}.item_id
    ELSE 0 END`;
const migration005EffectsMatch = (operation: string) => `CASE ${operation}.operation_type
  WHEN 'SHOP_PURCHASE' THEN (SELECT count(*) FROM commerce_operation_instances i WHERE i.command_id=${operation}.command_id)
    = CASE WHEN ${operation}.output_kind='EQUIPMENT' THEN ${operation}.quantity ELSE 0 END
    AND NOT EXISTS (SELECT 1 FROM commerce_operation_instances i JOIN item_instances e USING(instance_id)
      WHERE i.command_id=${operation}.command_id AND (e.retired<>0 OR e.definition_id<>${operation}.item_id
        OR e.definition_version<>${operation}.catalog_version OR e.enhancement<>0 OR e.acquired_at<>${operation}.occurred_at))
  WHEN 'EQUIPMENT_EQUIP' THEN EXISTS (SELECT 1 FROM pet_equipment e WHERE e.pet_id=${operation}.pet_id
    AND e.slot=${operation}.slot AND e.instance_id=${operation}.instance_id)
    AND (${operation}.previous_instance_id IS NULL OR NOT EXISTS (SELECT 1 FROM pet_equipment e WHERE e.instance_id=${operation}.previous_instance_id))
  WHEN 'EQUIPMENT_UNEQUIP' THEN NOT EXISTS (SELECT 1 FROM pet_equipment e WHERE e.instance_id=${operation}.instance_id
    OR (e.pet_id=${operation}.pet_id AND e.slot=${operation}.slot))
    AND EXISTS (SELECT 1 FROM item_instances i WHERE i.instance_id=${operation}.instance_id AND i.retired=0)
  WHEN 'EQUIPMENT_UPGRADE' THEN EXISTS (SELECT 1 FROM item_instances i WHERE i.instance_id=${operation}.instance_id
    AND i.retired=0 AND i.definition_version=${operation}.catalog_version AND i.enhancement=${operation}.to_enhancement)
    AND (SELECT count(*) FROM commerce_operation_materials m WHERE m.command_id=${operation}.command_id) BETWEEN 1 AND ${MIGRATION_005_MATERIAL_LIMIT}
  WHEN 'EQUIPMENT_SALVAGE' THEN EXISTS (SELECT 1 FROM item_instances i WHERE i.instance_id=${operation}.instance_id
    AND i.retired=1 AND i.definition_version=${operation}.catalog_version AND i.enhancement=${operation}.from_enhancement)
    AND (SELECT count(*) FROM commerce_operation_materials m WHERE m.command_id=${operation}.command_id) BETWEEN 1 AND ${MIGRATION_005_MATERIAL_LIMIT}
  WHEN 'ITEM_USE' THEN 1 ELSE 0 END`;
export const MIGRATION_005 = `
CREATE TABLE item_instances (
  instance_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('instance_id')}),
  definition_id TEXT NOT NULL CHECK (${idCheck('definition_id')}),
  definition_version INTEGER NOT NULL CHECK (${positive('definition_version')}),
  enhancement INTEGER NOT NULL CHECK (enhancement BETWEEN 0 AND ${MIGRATION_005_ENHANCEMENT_LIMIT}),
  acquired_at INTEGER NOT NULL CHECK (${unsigned('acquired_at')}),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1))
) STRICT;
CREATE INDEX active_item_instances ON item_instances(instance_id) WHERE retired=0;
CREATE TABLE pet_equipment (
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  slot TEXT NOT NULL CHECK (slot IN ('WEAPON','ARMOR','ACCESSORY')),
  instance_id TEXT NOT NULL UNIQUE REFERENCES item_instances(instance_id),
  PRIMARY KEY (pet_id,slot)
) STRICT;
CREATE TRIGGER validate_new_item_instance BEFORE INSERT ON item_instances
WHEN NEW.enhancement<>0 OR NEW.retired<>0 OR EXISTS (SELECT 1 FROM item_instances i WHERE i.instance_id=NEW.instance_id)
  OR (SELECT count(*) FROM item_instances WHERE retired=0)>=${MIGRATION_005_INSTANCE_LIMIT}
BEGIN SELECT RAISE(ABORT, 'new item instance requires unique +0 active identity within capacity'); END;
CREATE TRIGGER freeze_item_instance_identity BEFORE UPDATE ON item_instances
WHEN OLD.instance_id IS NOT NEW.instance_id OR OLD.definition_id IS NOT NEW.definition_id
  OR OLD.definition_version IS NOT NEW.definition_version OR OLD.acquired_at IS NOT NEW.acquired_at OR OLD.retired=1
  OR (NEW.retired=0 AND NEW.enhancement<>OLD.enhancement+1)
  OR (NEW.retired=1 AND (NEW.enhancement<>OLD.enhancement OR EXISTS (SELECT 1 FROM pet_equipment e WHERE e.instance_id=OLD.instance_id)))
BEGIN SELECT RAISE(ABORT, 'item identity is immutable; only one upgrade or unequipped retirement allowed'); END;
CREATE TRIGGER preserve_retired_item_identity BEFORE DELETE ON item_instances
BEGIN SELECT RAISE(ABORT, 'item identity cannot be deleted'); END;
CREATE TRIGGER validate_equipment_binding BEFORE INSERT ON pet_equipment
WHEN NOT EXISTS (SELECT 1 FROM item_instances i WHERE i.instance_id=NEW.instance_id AND i.retired=0)
  OR EXISTS (SELECT 1 FROM pet_equipment e WHERE (e.pet_id=NEW.pet_id AND e.slot=NEW.slot) OR e.instance_id=NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'equipment binding requires free slot and active unequipped instance'); END;
CREATE TRIGGER freeze_equipment_binding BEFORE UPDATE ON pet_equipment
BEGIN SELECT RAISE(ABORT, 'equipment binding must be explicitly unequipped'); END;
CREATE TABLE commerce_operations (
  command_id TEXT PRIMARY KEY NOT NULL CHECK (${idCheck('command_id')}),
  operation_type TEXT NOT NULL CHECK (operation_type IN (${migration005CommerceTypes})),
  occurred_at INTEGER NOT NULL CHECK (${unsigned('occurred_at')}),
  catalog_version INTEGER NOT NULL CHECK (${positive('catalog_version')}),
  offer_id TEXT CHECK (${idCheck('offer_id')}),
  item_id TEXT CHECK (${idCheck('item_id')}),
  quantity INTEGER CHECK (quantity BETWEEN 1 AND ${MIGRATION_005_PURCHASE_LIMIT}),
  coin_cost INTEGER CHECK (${unsigned('coin_cost')}),
  output_kind TEXT CHECK (output_kind IN ('STACK','EQUIPMENT')),
  pet_id TEXT REFERENCES pets(pet_id),
  slot TEXT CHECK (slot IN ('WEAPON','ARMOR','ACCESSORY')),
  instance_id TEXT REFERENCES item_instances(instance_id),
  previous_instance_id TEXT REFERENCES item_instances(instance_id),
  from_enhancement INTEGER CHECK (from_enhancement BETWEEN 0 AND ${MIGRATION_005_ENHANCEMENT_LIMIT}),
  to_enhancement INTEGER CHECK (to_enhancement BETWEEN 0 AND ${MIGRATION_005_ENHANCEMENT_LIMIT}),
  FOREIGN KEY (command_id) REFERENCES commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (CASE operation_type
    WHEN 'SHOP_PURCHASE' THEN offer_id IS NOT NULL AND item_id IS NOT NULL AND quantity IS NOT NULL AND coin_cost IS NOT NULL AND output_kind IS NOT NULL
      AND pet_id IS NULL AND slot IS NULL AND instance_id IS NULL AND previous_instance_id IS NULL AND from_enhancement IS NULL AND to_enhancement IS NULL
    WHEN 'EQUIPMENT_EQUIP' THEN offer_id IS NULL AND item_id IS NULL AND quantity IS NULL AND coin_cost IS NULL AND output_kind IS NULL
      AND pet_id IS NOT NULL AND slot IS NOT NULL AND instance_id IS NOT NULL AND (previous_instance_id IS NULL OR previous_instance_id<>instance_id)
      AND from_enhancement IS NULL AND to_enhancement IS NULL
    WHEN 'EQUIPMENT_UNEQUIP' THEN offer_id IS NULL AND item_id IS NULL AND quantity IS NULL AND coin_cost IS NULL AND output_kind IS NULL
      AND pet_id IS NOT NULL AND slot IS NOT NULL AND instance_id IS NOT NULL AND previous_instance_id IS NULL AND from_enhancement IS NULL AND to_enhancement IS NULL
    WHEN 'EQUIPMENT_UPGRADE' THEN offer_id IS NULL AND item_id IS NULL AND quantity IS NULL AND coin_cost IS NOT NULL AND output_kind IS NULL
      AND pet_id IS NULL AND slot IS NULL AND instance_id IS NOT NULL AND previous_instance_id IS NULL AND from_enhancement IS NOT NULL
      AND to_enhancement IS NOT NULL AND to_enhancement=from_enhancement+1
    WHEN 'EQUIPMENT_SALVAGE' THEN offer_id IS NULL AND item_id IS NULL AND quantity IS NULL AND coin_cost IS NULL AND output_kind IS NULL
      AND pet_id IS NULL AND slot IS NULL AND instance_id IS NOT NULL AND previous_instance_id IS NULL AND from_enhancement IS NOT NULL AND to_enhancement IS NULL
    WHEN 'ITEM_USE' THEN offer_id IS NULL AND item_id IS NOT NULL AND quantity IS NULL AND coin_cost IS NULL AND output_kind IS NULL
      AND pet_id IS NOT NULL AND slot IS NULL AND instance_id IS NULL AND previous_instance_id IS NULL AND from_enhancement IS NULL AND to_enhancement IS NULL
    ELSE 0 END)
) STRICT;
CREATE TABLE commerce_operation_materials (
  command_id TEXT NOT NULL REFERENCES commerce_operations(command_id),
  item_id TEXT NOT NULL CHECK (${idCheck('item_id')}),
  quantity INTEGER NOT NULL CHECK (${positive('quantity')}),
  PRIMARY KEY (command_id,item_id)
) STRICT;
CREATE TABLE commerce_operation_instances (
  command_id TEXT NOT NULL REFERENCES commerce_operations(command_id),
  instance_id TEXT NOT NULL UNIQUE REFERENCES item_instances(instance_id),
  PRIMARY KEY (command_id,instance_id)
) STRICT;
CREATE TRIGGER validate_new_commerce_operation BEFORE INSERT ON commerce_operations
WHEN EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=NEW.command_id)
  OR EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT, 'commerce operation requires new unique command without receipt'); END;
CREATE TRIGGER freeze_commerce_operation BEFORE UPDATE ON commerce_operations
BEGIN SELECT RAISE(ABORT, 'commerce operation is immutable'); END;
CREATE TRIGGER preserve_commerce_operation BEFORE DELETE ON commerce_operations
BEGIN SELECT RAISE(ABORT, 'commerce operation is immutable'); END;
CREATE TRIGGER validate_commerce_material BEFORE INSERT ON commerce_operation_materials
WHEN NOT EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=NEW.command_id AND o.operation_type IN ('EQUIPMENT_UPGRADE','EQUIPMENT_SALVAGE'))
  OR EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
  OR EXISTS (SELECT 1 FROM commerce_operation_materials m WHERE m.command_id=NEW.command_id AND m.item_id=NEW.item_id)
  OR (SELECT count(*) FROM commerce_operation_materials m WHERE m.command_id=NEW.command_id)>=${MIGRATION_005_MATERIAL_LIMIT}
BEGIN SELECT RAISE(ABORT, 'invalid or immutable commerce material evidence'); END;
CREATE TRIGGER freeze_commerce_material BEFORE UPDATE ON commerce_operation_materials
BEGIN SELECT RAISE(ABORT, 'commerce material is immutable'); END;
CREATE TRIGGER preserve_commerce_material BEFORE DELETE ON commerce_operation_materials
BEGIN SELECT RAISE(ABORT, 'commerce material is immutable'); END;
CREATE TRIGGER validate_commerce_purchase_instance BEFORE INSERT ON commerce_operation_instances
WHEN NOT EXISTS (SELECT 1 FROM commerce_operations o JOIN item_instances i ON i.instance_id=NEW.instance_id
  WHERE o.command_id=NEW.command_id AND o.operation_type='SHOP_PURCHASE' AND o.output_kind='EQUIPMENT'
    AND i.retired=0 AND i.definition_id=o.item_id AND i.definition_version=o.catalog_version
    AND i.enhancement=0 AND i.acquired_at=o.occurred_at
    AND (SELECT count(*) FROM commerce_operation_instances p WHERE p.command_id=o.command_id)<o.quantity)
  OR EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
  OR EXISTS (SELECT 1 FROM commerce_operation_instances p WHERE p.instance_id=NEW.instance_id)
BEGIN SELECT RAISE(ABORT, 'invalid or immutable commerce instance evidence'); END;
CREATE TRIGGER freeze_commerce_purchase_instance BEFORE UPDATE ON commerce_operation_instances
BEGIN SELECT RAISE(ABORT, 'commerce instance evidence is immutable'); END;
CREATE TRIGGER preserve_commerce_purchase_instance BEFORE DELETE ON commerce_operation_instances
BEGIN SELECT RAISE(ABORT, 'commerce instance evidence is immutable'); END;
CREATE TRIGGER validate_successful_commerce_receipt BEFORE INSERT ON commands
WHEN (EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=NEW.command_id)
  OR (json_extract(NEW.fingerprint,'$.type') IN (${migration005CommerceTypes}) AND json_type(NEW.outcome_json,'$.ok')='true'))
  AND (EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
    OR NOT EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=NEW.command_id
      AND ${migration005ReceiptMatches('NEW','o')} AND (${migration005EffectsMatch('o')})))
BEGIN SELECT RAISE(ABORT, 'commerce command requires exact immutable successful operation and receipt'); END;
CREATE TRIGGER freeze_commerce_receipt BEFORE UPDATE ON commands
WHEN EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=OLD.command_id)
  OR (json_extract(NEW.fingerprint,'$.type') IN (${migration005CommerceTypes}) AND json_type(NEW.outcome_json,'$.ok')='true')
BEGIN SELECT RAISE(ABORT, 'commerce receipt is immutable'); END;
CREATE TRIGGER preserve_commerce_receipt BEFORE DELETE ON commands
WHEN EXISTS (SELECT 1 FROM commerce_operations o WHERE o.command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT, 'commerce receipt is immutable'); END;
`;

// A marked new trip has a deferred pointer back to its immutable loadout.
// The loadout in turn references both the trip and its deferred command
// receipt; COMMIT cannot leave any member of this authority chain missing.
const MIGRATION_006_STAT_LIMIT = 1_000_000;
const MIGRATION_006_SUPPLY_LIMIT = 8;
const migration006StatsKeys = ['hp','atk','def','spd','luk'] as const;
const migration006StatsColumns = (prefix: string, hpMin: number) => migration006StatsKeys.map(key =>
  `${prefix}_${key} INTEGER CHECK (${prefix}_${key} BETWEEN ${key === 'hp' ? hpMin : 0} AND ${MIGRATION_006_STAT_LIMIT})`).join(',\n  ');
const migration006StatsAllOrNone = (prefix: string) => `(${migration006StatsKeys.map(key => `${prefix}_${key} IS NULL`).join(' AND ')})
  OR (${migration006StatsKeys.map(key => `${prefix}_${key} IS NOT NULL`).join(' AND ')})`;
const migration006InitialDeparture = (trip: string) => `${trip}.departure_loadout_trip_id=${trip}.trip_id AND ${trip}.status='TRAVELING'
  AND json_extract(${trip}.checkpoint_json,'$.phase')='OUTBOUND'
  AND json_extract(${trip}.checkpoint_json,'$.sequence')=0 AND json_extract(${trip}.checkpoint_json,'$.logicalTime')=${trip}.start_at
  AND NOT EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id=${trip}.trip_id)
  AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.trip_id=${trip}.trip_id)`;
const migration006GearMatches = (gear: string, trip: string) => `EXISTS (SELECT 1 FROM pet_equipment b JOIN item_instances i USING(instance_id)
  WHERE b.pet_id=${trip}.pet_id AND b.slot=${gear}.slot AND i.instance_id=${gear}.instance_id AND i.retired=0
    AND i.definition_id=${gear}.definition_id AND i.definition_version=${gear}.definition_version AND i.enhancement=${gear}.enhancement)`;
const migration006ReceiptMatches = (receipt: string, loadout: string, trip: string) => `
  ${migration006InitialDeparture(trip)} AND ${receipt}.created_at=${trip}.start_at
  AND json_extract(${receipt}.fingerprint,'$.commandId')=${receipt}.command_id
  AND json_extract(${receipt}.fingerprint,'$.payload.petId')=${trip}.pet_id
  AND json_extract(${receipt}.fingerprint,'$.payload.routeId')=${trip}.route_id
  AND json_type(${receipt}.outcome_json,'$.ok')='true'
  AND json_type(${receipt}.outcome_json,'$.snapshot.revision')='integer'
  AND EXISTS (SELECT 1 FROM preferences prefs WHERE prefs.singleton=1 AND prefs.logical_time=${receipt}.created_at
    AND prefs.revision=json_extract(${receipt}.outcome_json,'$.snapshot.revision'))
  AND (json_type(${receipt}.fingerprint,'$.expectedRevision') IS NULL OR
    (json_type(${receipt}.fingerprint,'$.expectedRevision')='integer'
      AND json_extract(${receipt}.outcome_json,'$.snapshot.revision')=json_extract(${receipt}.fingerprint,'$.expectedRevision')+1))
  AND json_type(${receipt}.outcome_json,'$.snapshot.walletCoins')='integer'
  AND EXISTS (SELECT 1 FROM wallet w WHERE w.currency='coin' AND w.balance=json_extract(${receipt}.outcome_json,'$.snapshot.walletCoins'))
  AND EXISTS (SELECT 1 FROM pets p JOIN pet_states s USING(pet_id) WHERE p.pet_id=${trip}.pet_id AND s.presence='AWAY' AND s.activity IS NULL
    AND s.energy10=${loadout}.energy_before10-${loadout}.energy_cost10
    AND EXISTS (SELECT 1 FROM json_each(${receipt}.outcome_json,'$.snapshot.pets') entry
      WHERE json_extract(entry.value,'$.petId')=p.pet_id AND json_extract(entry.value,'$.characterId')=p.character_id
        AND json_extract(entry.value,'$.presence')='AWAY' AND json_extract(entry.value,'$.level')=${loadout}.level
        AND json_extract(entry.value,'$.energy')=s.energy10/10.0
        AND json_extract(entry.value,'$.trip.tripId')=${trip}.trip_id AND json_extract(entry.value,'$.trip.routeId')=${trip}.route_id
        AND json_extract(entry.value,'$.trip.status')='TRAVELING'
        AND json_extract(entry.value,'$.trip.expectedReturnAt')=${trip}.expected_return_at))
  AND (SELECT count(*) FROM trip_departure_equipment g WHERE g.trip_id=${trip}.trip_id)
    =(SELECT count(*) FROM pet_equipment e WHERE e.pet_id=${trip}.pet_id)
  AND NOT EXISTS (SELECT 1 FROM trip_departure_equipment g WHERE g.trip_id=${trip}.trip_id AND NOT (${migration006GearMatches('g',trip)}))
  AND CASE json_extract(${receipt}.fingerprint,'$.type')
    WHEN 'TRIP_START_PREPARED' THEN json_type(${receipt}.fingerprint,'$.expectedRevision')='integer'
      AND json_type(${receipt}.fingerprint,'$.payload.routeCatalogVersion')='integer'
      AND json_extract(${receipt}.fingerprint,'$.payload.routeCatalogVersion')=${loadout}.route_catalog_version
      AND json_type(${receipt}.fingerprint,'$.payload.selectedSupplies')='array'
      AND json_array_length(${receipt}.fingerprint,'$.payload.selectedSupplies')=(SELECT count(*) FROM trip_departure_supplies c WHERE c.trip_id=${trip}.trip_id)
      AND NOT EXISTS (SELECT 1 FROM trip_departure_supplies c WHERE c.trip_id=${trip}.trip_id
        AND NOT EXISTS (SELECT 1 FROM json_each(${receipt}.fingerprint,'$.payload.selectedSupplies') selected
          WHERE json_extract(selected.value,'$.itemId')=c.item_id AND json_extract(selected.value,'$.quantity')=c.quantity))
    WHEN 'TRIP_START' THEN ${trip}.route_id='morning-dew-meadow'
      AND NOT EXISTS (SELECT 1 FROM trip_departure_supplies c WHERE c.trip_id=${trip}.trip_id)
    ELSE 0 END`;
export const MIGRATION_006 = `
CREATE TABLE trip_departure_loadouts (
  trip_id TEXT PRIMARY KEY NOT NULL REFERENCES trips(trip_id),
  command_id TEXT NOT NULL UNIQUE CHECK (${idCheck('command_id')}),
  route_catalog_version INTEGER NOT NULL CHECK (${positive('route_catalog_version')}),
  item_catalog_version INTEGER NOT NULL CHECK (${positive('item_catalog_version')}),
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 20),
  energy_cost10 INTEGER NOT NULL CHECK (energy_cost10 BETWEEN 1 AND 1000),
  energy_before10 INTEGER NOT NULL CHECK (energy_before10 BETWEEN energy_cost10 AND 1000),
  battle_power INTEGER NOT NULL CHECK (battle_power BETWEEN 1 AND 1000),
  ${migration006StatsColumns('stats',1)},
  FOREIGN KEY (command_id) REFERENCES commands(command_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (${migration006StatsAllOrNone('stats')})
) STRICT;
ALTER TABLE trips ADD COLUMN departure_loadout_trip_id TEXT REFERENCES trip_departure_loadouts(trip_id)
  DEFERRABLE INITIALLY DEFERRED CHECK (departure_loadout_trip_id IS NULL OR departure_loadout_trip_id=trip_id);
CREATE INDEX settled_trip_history ON trips(actual_returned_at DESC,trip_id ASC) WHERE status='SETTLED';
CREATE INDEX settled_pet_trip_history ON trips(pet_id,actual_returned_at DESC,trip_id ASC) WHERE status='SETTLED';
CREATE TABLE trip_departure_supplies (
  trip_id TEXT NOT NULL REFERENCES trip_departure_loadouts(trip_id),
  item_id TEXT NOT NULL CHECK (${idCheck('item_id')}),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  PRIMARY KEY (trip_id,item_id)
) STRICT;
CREATE TABLE trip_departure_equipment (
  trip_id TEXT NOT NULL REFERENCES trip_departure_loadouts(trip_id),
  slot TEXT NOT NULL CHECK (slot IN ('WEAPON','ARMOR','ACCESSORY')),
  instance_id TEXT NOT NULL REFERENCES item_instances(instance_id),
  definition_id TEXT NOT NULL CHECK (${idCheck('definition_id')}),
  definition_version INTEGER NOT NULL CHECK (${positive('definition_version')}),
  enhancement INTEGER NOT NULL CHECK (enhancement BETWEEN 0 AND 5),
  ${migration006StatsColumns('bonus',0)},
  PRIMARY KEY (trip_id,slot), UNIQUE (trip_id,instance_id),
  CHECK (${migration006StatsAllOrNone('bonus')})
) STRICT;
CREATE TRIGGER freeze_trip_departure_requirement BEFORE UPDATE ON trips
WHEN OLD.departure_loadout_trip_id IS NOT NEW.departure_loadout_trip_id
BEGIN SELECT RAISE(ABORT, 'trip departure loadout requirement is immutable'); END;
CREATE TRIGGER prevent_marked_trip_replace BEFORE INSERT ON trips
WHEN EXISTS (SELECT 1 FROM trips t WHERE t.trip_id=NEW.trip_id AND (t.departure_loadout_trip_id IS NOT NULL OR NEW.departure_loadout_trip_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'marked departure trip cannot be replaced'); END;
CREATE TRIGGER validate_new_departure_loadout BEFORE INSERT ON trip_departure_loadouts
WHEN EXISTS (SELECT 1 FROM trip_departure_loadouts l WHERE l.trip_id=NEW.trip_id OR l.command_id=NEW.command_id)
  OR EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
  OR NOT EXISTS (SELECT 1 FROM trips t JOIN pet_states s USING(pet_id) WHERE t.trip_id=NEW.trip_id
    AND ${migration006InitialDeparture('t')}
    AND json_extract(t.snapshot_json,'$.power')=NEW.battle_power AND s.presence='HOME' AND s.energy10=NEW.energy_before10)
BEGIN SELECT RAISE(ABORT, 'loadout requires a new marked trip at departure'); END;
CREATE TRIGGER freeze_departure_loadout BEFORE UPDATE ON trip_departure_loadouts
BEGIN SELECT RAISE(ABORT, 'trip departure loadout is immutable'); END;
CREATE TRIGGER preserve_departure_loadout BEFORE DELETE ON trip_departure_loadouts
BEGIN SELECT RAISE(ABORT, 'trip departure loadout is immutable'); END;
CREATE TRIGGER validate_departure_supply BEFORE INSERT ON trip_departure_supplies
WHEN NOT EXISTS (SELECT 1 FROM trip_departure_loadouts l JOIN trips t USING(trip_id) JOIN pet_states s USING(pet_id)
    WHERE l.trip_id=NEW.trip_id AND ${migration006InitialDeparture('t')} AND s.presence='HOME'
      AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.command_id=l.command_id))
  OR EXISTS (SELECT 1 FROM trip_departure_supplies c WHERE c.trip_id=NEW.trip_id AND c.item_id=NEW.item_id)
  OR (SELECT count(*) FROM trip_departure_supplies c WHERE c.trip_id=NEW.trip_id)>=${MIGRATION_006_SUPPLY_LIMIT}
BEGIN SELECT RAISE(ABORT, 'invalid or immutable departure supply'); END;
CREATE TRIGGER freeze_departure_supply BEFORE UPDATE ON trip_departure_supplies
BEGIN SELECT RAISE(ABORT, 'departure supply is immutable'); END;
CREATE TRIGGER preserve_departure_supply BEFORE DELETE ON trip_departure_supplies
BEGIN SELECT RAISE(ABORT, 'departure supply is immutable'); END;
CREATE TRIGGER validate_departure_equipment BEFORE INSERT ON trip_departure_equipment
WHEN NOT EXISTS (SELECT 1 FROM trip_departure_loadouts l JOIN trips t USING(trip_id) JOIN pet_states s USING(pet_id)
    WHERE l.trip_id=NEW.trip_id AND ${migration006InitialDeparture('t')} AND s.presence='HOME'
      AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.command_id=l.command_id) AND ${migration006GearMatches('NEW','t')})
  OR EXISTS (SELECT 1 FROM trip_departure_equipment g WHERE g.trip_id=NEW.trip_id AND (g.slot=NEW.slot OR g.instance_id=NEW.instance_id))
BEGIN SELECT RAISE(ABORT, 'invalid or immutable departure equipment'); END;
CREATE TRIGGER freeze_departure_equipment BEFORE UPDATE ON trip_departure_equipment
BEGIN SELECT RAISE(ABORT, 'departure equipment is immutable'); END;
CREATE TRIGGER preserve_departure_equipment BEFORE DELETE ON trip_departure_equipment
BEGIN SELECT RAISE(ABORT, 'departure equipment is immutable'); END;
CREATE TRIGGER validate_successful_departure_receipt BEFORE INSERT ON commands
WHEN (EXISTS (SELECT 1 FROM trip_departure_loadouts l WHERE l.command_id=NEW.command_id)
  OR (json_extract(NEW.fingerprint,'$.type') IN ('TRIP_START','TRIP_START_PREPARED') AND json_type(NEW.outcome_json,'$.ok')='true'))
  AND (EXISTS (SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
    OR NOT EXISTS (SELECT 1 FROM trip_departure_loadouts l JOIN trips t USING(trip_id) WHERE l.command_id=NEW.command_id
      AND ${migration006ReceiptMatches('NEW','l','t')}))
BEGIN SELECT RAISE(ABORT, 'trip departure requires exact immutable successful loadout and receipt'); END;
CREATE TRIGGER freeze_departure_receipt BEFORE UPDATE ON commands
WHEN EXISTS (SELECT 1 FROM trip_departure_loadouts l WHERE l.command_id=OLD.command_id)
  OR (json_extract(NEW.fingerprint,'$.type') IN ('TRIP_START','TRIP_START_PREPARED') AND json_type(NEW.outcome_json,'$.ok')='true')
BEGIN SELECT RAISE(ABORT, 'trip departure receipt is immutable'); END;
CREATE TRIGGER preserve_departure_receipt BEFORE DELETE ON commands
WHEN EXISTS (SELECT 1 FROM trip_departure_loadouts l WHERE l.command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT, 'trip departure receipt is immutable'); END;
`;

// Separate immutable occurrence and finalization rows make finalization a
// compare-and-set insert. Deferred references forbid partial selection,
// automatic resolution, effect evidence, acquisition or choice receipts.
export const MIGRATION_007 = `
CREATE TABLE event_trigger_receipts (
  trigger_key TEXT PRIMARY KEY NOT NULL CHECK(length(trigger_key) BETWEEN 1 AND 512 AND length(trim(trigger_key))>0),
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('HOME_DAILY','AFTER_INTERACTION','TRIP_RETURNED','BOND_MILESTONE')),
  seed INTEGER NOT NULL CHECK(seed BETWEEN 1 AND ${UINT32_MAX}),
  at INTEGER NOT NULL CHECK(${unsigned('at')}),
  rng_state INTEGER NOT NULL CHECK(rng_state BETWEEN 1 AND ${UINT32_MAX}),
  draw_count INTEGER NOT NULL CHECK(draw_count BETWEEN 0 AND 2),
  source_trip_id TEXT REFERENCES trips(trip_id), route_id TEXT CHECK(${idCheck('route_id')}),
  decision TEXT NOT NULL CHECK(decision IN ('NO_EVENT','OCCURRENCE')),
  reason TEXT CHECK(reason IN ('NO_ELIGIBLE','CHANCE_MISS','TRIGGER_ALREADY_SEEN','TRIGGER_INELIGIBLE')),
  occurrence_id TEXT UNIQUE REFERENCES event_occurrences(occurrence_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((trigger_kind='TRIP_RETURNED' AND source_trip_id IS NOT NULL AND route_id IS NOT NULL)
    OR (trigger_kind<>'TRIP_RETURNED' AND source_trip_id IS NULL AND route_id IS NULL)),
  CHECK((decision='OCCURRENCE' AND reason IS NULL AND occurrence_id IS NOT NULL AND draw_count=2)
    OR (decision='NO_EVENT' AND occurrence_id IS NULL AND reason IS NOT NULL
      AND ((reason='CHANCE_MISS' AND draw_count=1) OR (reason<>'CHANCE_MISS' AND draw_count=0)))),
  CHECK(draw_count<>0 OR seed=rng_state)
) STRICT;
CREATE UNIQUE INDEX one_trip_event_trigger ON event_trigger_receipts(source_trip_id) WHERE source_trip_id IS NOT NULL;
CREATE UNIQUE INDEX one_daily_event_trigger ON event_trigger_receipts(pet_id,at/86400000) WHERE trigger_kind='HOME_DAILY';
CREATE TABLE event_occurrences (
  occurrence_id TEXT PRIMARY KEY NOT NULL CHECK(${idCheck('occurrence_id')}),
  trigger_key TEXT NOT NULL UNIQUE REFERENCES event_trigger_receipts(trigger_key),
  pet_id TEXT NOT NULL REFERENCES pets(pet_id),
  event_id TEXT NOT NULL CHECK(${idCheck('event_id')}), event_version INTEGER NOT NULL CHECK(event_version BETWEEN 1 AND 1000000),
  occurred_at INTEGER NOT NULL CHECK(${unsigned('occurred_at')}), deadline_at INTEGER CHECK(${unsigned('deadline_at')} AND deadline_at>occurred_at),
  frozen_json TEXT NOT NULL CHECK(${jsonObject('frozen_json')}),
  auto_finalization_id TEXT REFERENCES event_finalizations(occurrence_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(json_extract(frozen_json,'$.schemaVersion') IS 1 AND json_extract(frozen_json,'$.rulesVersion') IS 'event-v1'
    AND json_extract(frozen_json,'$.occurrenceId') IS occurrence_id AND json_extract(frozen_json,'$.triggerKey') IS trigger_key
    AND json_extract(frozen_json,'$.petId') IS pet_id AND json_extract(frozen_json,'$.eventId') IS event_id
    AND json_extract(frozen_json,'$.eventVersion') IS event_version AND json_extract(frozen_json,'$.occurredAt') IS occurred_at
    AND json_extract(frozen_json,'$.deadlineAt') IS deadline_at AND json_type(frozen_json,'$.choices') IS 'array'
    AND json_type(frozen_json,'$.effects') IS 'array'),
  CHECK((deadline_at IS NULL AND auto_finalization_id IS occurrence_id AND json_array_length(frozen_json,'$.choices')=0)
    OR (deadline_at IS NOT NULL AND auto_finalization_id IS NULL AND json_array_length(frozen_json,'$.choices') BETWEEN 2 AND 8))
) STRICT;
CREATE INDEX event_occurrence_history ON event_occurrences(occurred_at DESC,occurrence_id ASC);
CREATE INDEX event_pet_history ON event_occurrences(pet_id,occurred_at DESC,occurrence_id ASC);
CREATE INDEX event_occurrence_due ON event_occurrences(deadline_at,occurrence_id) WHERE deadline_at IS NOT NULL;
CREATE TABLE event_finalizations (
  occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES event_occurrences(occurrence_id),
  status TEXT NOT NULL CHECK(status IN ('RESOLVED','EXPIRED')),
  resolved_at INTEGER NOT NULL CHECK(${unsigned('resolved_at')}), choice_id TEXT CHECK(${idCheck('choice_id')}),
  result_text TEXT NOT NULL CHECK(length(result_text) BETWEEN 1 AND 2048),
  command_id TEXT UNIQUE REFERENCES commands(command_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE event_effects (
  occurrence_id TEXT NOT NULL REFERENCES event_finalizations(occurrence_id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK(kind IN ('MOOD_DELTA','BOND_DELTA','COIN','ITEM','CG_UNLOCK')),
  target_id TEXT NOT NULL, variant TEXT CHECK(${idCheck('variant')}), amount INTEGER NOT NULL,
  unlock_event_id TEXT UNIQUE REFERENCES event_cg_unlocks(source_event_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY(occurrence_id,kind,target_id),
  CHECK(CASE kind WHEN 'MOOD_DELTA' THEN target_id='' AND variant IS NULL AND amount BETWEEN -200 AND 200 AND unlock_event_id IS NULL
    WHEN 'BOND_DELTA' THEN target_id='' AND variant IS NULL AND amount BETWEEN -200 AND 200 AND unlock_event_id IS NULL
    WHEN 'COIN' THEN target_id='' AND variant IS NULL AND amount BETWEEN 1 AND 1000 AND unlock_event_id IS NULL
    WHEN 'ITEM' THEN ${idCheck('target_id')} AND variant IS NULL AND amount BETWEEN 1 AND 100 AND unlock_event_id IS NULL
    WHEN 'CG_UNLOCK' THEN ${idCheck('target_id')} AND variant IS NOT NULL AND ((amount=1 AND unlock_event_id IS occurrence_id) OR (amount=0 AND unlock_event_id IS NULL))
    ELSE 0 END)
) STRICT;
CREATE TABLE event_cg_unlocks (
  pet_id TEXT NOT NULL REFERENCES pets(pet_id), cg_id TEXT NOT NULL CHECK(${idCheck('cg_id')}), variant TEXT NOT NULL CHECK(${idCheck('variant')}),
  source_event_id TEXT NOT NULL UNIQUE REFERENCES event_finalizations(occurrence_id), unlocked_at INTEGER NOT NULL CHECK(${unsigned('unlocked_at')}),
  historical_character_id TEXT NOT NULL CHECK(${idCheck('historical_character_id')}), historical_event_def_id TEXT NOT NULL CHECK(${idCheck('historical_event_def_id')}),
  asset_version TEXT NOT NULL CHECK(${migration002VersionCheck('asset_version')}), asset_hash TEXT NOT NULL CHECK(${migration002HashCheck('asset_hash')}),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)), viewed_at INTEGER CHECK(${unsigned('viewed_at')} AND viewed_at>=unlocked_at),
  PRIMARY KEY(pet_id,cg_id,variant)
) STRICT;
-- Resolve the available branches from the frozen definition, never today's
-- catalog. Aggregate exact non-need effects; actual clamped need deltas may
-- only move in the draft direction, up to its magnitude.
CREATE VIEW event_frozen_effect_totals AS
WITH branches AS (
  SELECT occurrence_id,NULL AS choice_id,'[]' AS branch_effects FROM event_occurrences WHERE deadline_at IS NULL
  UNION ALL SELECT o.occurrence_id,json_extract(c.value,'$.choiceId'),json_extract(c.value,'$.effects')
    FROM event_occurrences o JOIN json_each(o.frozen_json,'$.choices') c
), effects AS (
  SELECT b.occurrence_id,b.choice_id,e.value AS effect FROM branches b JOIN event_occurrences o USING(occurrence_id) JOIN json_each(o.frozen_json,'$.effects') e
  UNION ALL SELECT b.occurrence_id,b.choice_id,e.value FROM branches b JOIN json_each(b.branch_effects) e
), lines AS (
  SELECT e.occurrence_id,e.choice_id,json_extract(e.effect,'$.kind') AS kind,
    CASE json_extract(e.effect,'$.kind') WHEN 'ITEM' THEN json_extract(e.effect,'$.itemId')
      WHEN 'CG_UNLOCK' THEN json_extract(o.frozen_json,'$.asset.cgId') ELSE '' END AS target_id,
    CASE json_extract(e.effect,'$.kind') WHEN 'ITEM' THEN json_extract(e.effect,'$.quantity') WHEN 'COIN' THEN json_extract(e.effect,'$.amount')
      WHEN 'CG_UNLOCK' THEN 1 ELSE json_extract(e.effect,'$.delta10') END AS amount
    FROM effects e JOIN event_occurrences o USING(occurrence_id)
)
SELECT occurrence_id,choice_id,kind,target_id,sum(amount) AS amount FROM lines GROUP BY occurrence_id,choice_id,kind,target_id;
CREATE TRIGGER validate_event_trigger_receipt BEFORE INSERT ON event_trigger_receipts
WHEN EXISTS(SELECT 1 FROM event_trigger_receipts r WHERE r.trigger_key=NEW.trigger_key OR r.occurrence_id=NEW.occurrence_id
    OR r.source_trip_id=NEW.source_trip_id OR (NEW.trigger_kind='HOME_DAILY' AND r.trigger_kind='HOME_DAILY' AND r.pet_id=NEW.pet_id AND r.at/86400000=NEW.at/86400000))
  OR NOT EXISTS(SELECT 1 FROM preferences p WHERE p.singleton=1 AND p.logical_time>=NEW.at)
  OR (NEW.source_trip_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM trips t WHERE t.trip_id=NEW.source_trip_id AND t.pet_id=NEW.pet_id
    AND t.route_id=NEW.route_id AND t.status='SETTLED' AND t.actual_returned_at=NEW.at))
BEGIN SELECT RAISE(ABORT,'invalid or duplicate immutable event trigger receipt'); END;
CREATE TRIGGER freeze_event_trigger_receipt BEFORE UPDATE ON event_trigger_receipts BEGIN SELECT RAISE(ABORT,'event trigger receipt is immutable'); END;
CREATE TRIGGER preserve_event_trigger_receipt BEFORE DELETE ON event_trigger_receipts BEGIN SELECT RAISE(ABORT,'event trigger receipt is immutable'); END;
CREATE TRIGGER validate_event_occurrence BEFORE INSERT ON event_occurrences
WHEN EXISTS(SELECT 1 FROM event_occurrences o WHERE o.occurrence_id=NEW.occurrence_id OR o.trigger_key=NEW.trigger_key)
  OR NOT EXISTS(SELECT 1 FROM event_trigger_receipts r JOIN pets p USING(pet_id) JOIN pet_states s USING(pet_id)
    WHERE r.trigger_key=NEW.trigger_key AND r.decision='OCCURRENCE' AND r.occurrence_id=NEW.occurrence_id AND r.pet_id=NEW.pet_id
    AND r.at=NEW.occurred_at AND r.seed=json_extract(NEW.frozen_json,'$.seed') AND r.trigger_kind=json_extract(NEW.frozen_json,'$.trigger')
    AND r.route_id IS json_extract(NEW.frozen_json,'$.routeId') AND r.source_trip_id IS json_extract(NEW.frozen_json,'$.sourceTripId')
    AND p.character_id=json_extract(NEW.frozen_json,'$.characterId') AND s.presence='HOME')
  OR (SELECT count(*) FROM event_occurrences o LEFT JOIN event_finalizations f USING(occurrence_id) WHERE o.pet_id=NEW.pet_id AND f.occurrence_id IS NULL)>=3
BEGIN SELECT RAISE(ABORT,'event occurrence requires its exact selection receipt and pending capacity'); END;
CREATE TRIGGER freeze_event_occurrence BEFORE UPDATE ON event_occurrences BEGIN SELECT RAISE(ABORT,'frozen event occurrence is immutable'); END;
CREATE TRIGGER preserve_event_occurrence BEFORE DELETE ON event_occurrences BEGIN SELECT RAISE(ABORT,'frozen event occurrence is immutable'); END;
CREATE TRIGGER validate_new_event_effect BEFORE INSERT ON event_effects
WHEN EXISTS(SELECT 1 FROM event_finalizations f WHERE f.occurrence_id=NEW.occurrence_id)
  OR NOT EXISTS(SELECT 1 FROM event_occurrences o WHERE o.occurrence_id=NEW.occurrence_id)
  OR EXISTS(SELECT 1 FROM event_effects e WHERE e.occurrence_id=NEW.occurrence_id AND e.kind=NEW.kind AND e.target_id=NEW.target_id)
  OR (SELECT count(*) FROM event_effects e WHERE e.occurrence_id=NEW.occurrence_id)>=14
BEGIN SELECT RAISE(ABORT,'invalid or immutable event effect evidence'); END;
CREATE TRIGGER freeze_event_effect BEFORE UPDATE ON event_effects BEGIN SELECT RAISE(ABORT,'event effect evidence is immutable'); END;
CREATE TRIGGER preserve_event_effect BEFORE DELETE ON event_effects BEGIN SELECT RAISE(ABORT,'event effect evidence is immutable'); END;
CREATE TRIGGER validate_event_finalization BEFORE INSERT ON event_finalizations
WHEN EXISTS(SELECT 1 FROM event_finalizations f WHERE f.occurrence_id=NEW.occurrence_id OR f.command_id=NEW.command_id)
  OR EXISTS(SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id)
  OR NOT EXISTS(SELECT 1 FROM event_occurrences o JOIN preferences p ON p.singleton=1 WHERE o.occurrence_id=NEW.occurrence_id
    AND NEW.resolved_at BETWEEN o.occurred_at AND p.logical_time
    AND ((o.deadline_at IS NULL AND NEW.status='RESOLVED' AND NEW.choice_id IS NULL AND NEW.command_id IS NULL
        AND NEW.resolved_at=o.occurred_at AND NEW.result_text=json_extract(o.frozen_json,'$.narrative.text'))
      OR (o.deadline_at IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(o.frozen_json,'$.choices') c
        WHERE json_extract(c.value,'$.choiceId')=NEW.choice_id AND json_extract(c.value,'$.resultText')=NEW.result_text)
        AND ((NEW.status='EXPIRED' AND NEW.command_id IS NULL AND NEW.resolved_at=o.deadline_at AND NEW.choice_id=json_extract(o.frozen_json,'$.defaultChoiceId'))
          OR (NEW.status='RESOLVED' AND NEW.command_id IS NOT NULL AND NEW.resolved_at<o.deadline_at))))
    AND NOT EXISTS(SELECT 1 FROM event_frozen_effect_totals d WHERE d.occurrence_id=o.occurrence_id AND d.choice_id IS NEW.choice_id AND d.amount<>0
      AND NOT EXISTS(SELECT 1 FROM event_effects e WHERE e.occurrence_id=o.occurrence_id AND e.kind=d.kind AND e.target_id=d.target_id
        AND CASE d.kind WHEN 'MOOD_DELTA' THEN e.amount BETWEEN min(0,d.amount) AND max(0,d.amount)
          WHEN 'BOND_DELTA' THEN e.amount BETWEEN min(0,d.amount) AND max(0,d.amount)
          WHEN 'CG_UNLOCK' THEN d.amount=1 AND json_extract(o.frozen_json,'$.asset.state')='PINNED'
            AND e.variant=json_extract(o.frozen_json,'$.asset.variant') AND e.amount=CASE WHEN
              EXISTS(SELECT 1 FROM cg_unlocks g WHERE g.pet_id=o.pet_id AND g.cg_id=e.target_id AND g.variant=e.variant)
              OR EXISTS(SELECT 1 FROM event_cg_unlocks g WHERE g.pet_id=o.pet_id AND g.cg_id=e.target_id AND g.variant=e.variant) THEN 0 ELSE 1 END
          ELSE e.amount=d.amount END))
    AND NOT EXISTS(SELECT 1 FROM event_effects e WHERE e.occurrence_id=o.occurrence_id AND NOT EXISTS(
      SELECT 1 FROM event_frozen_effect_totals d WHERE d.occurrence_id=o.occurrence_id AND d.choice_id IS NEW.choice_id AND d.kind=e.kind
        AND d.target_id=e.target_id AND d.amount<>0)))
BEGIN SELECT RAISE(ABORT,'event finalization requires its exact pending branch and effect evidence'); END;
CREATE TRIGGER freeze_event_finalization BEFORE UPDATE ON event_finalizations BEGIN SELECT RAISE(ABORT,'event finalization is immutable'); END;
CREATE TRIGGER preserve_event_finalization BEFORE DELETE ON event_finalizations BEGIN SELECT RAISE(ABORT,'event finalization is immutable'); END;
CREATE TRIGGER validate_event_cg_acquisition BEFORE INSERT ON event_cg_unlocks
WHEN NEW.favorite<>0 OR NEW.viewed_at IS NOT NULL OR EXISTS(SELECT 1 FROM event_cg_unlocks g WHERE g.source_event_id=NEW.source_event_id
  OR (g.pet_id=NEW.pet_id AND g.cg_id=NEW.cg_id AND g.variant=NEW.variant))
  OR EXISTS(SELECT 1 FROM cg_unlocks g WHERE g.pet_id=NEW.pet_id AND g.cg_id=NEW.cg_id AND g.variant=NEW.variant)
  OR NOT EXISTS(SELECT 1 FROM event_occurrences o JOIN event_finalizations f USING(occurrence_id) JOIN event_effects e USING(occurrence_id)
    WHERE o.occurrence_id=NEW.source_event_id AND o.pet_id=NEW.pet_id AND f.resolved_at=NEW.unlocked_at AND e.kind='CG_UNLOCK'
    AND e.target_id=NEW.cg_id AND e.variant=NEW.variant AND e.amount=1 AND e.unlock_event_id=NEW.source_event_id
    AND json_extract(o.frozen_json,'$.asset.state')='PINNED' AND json_extract(o.frozen_json,'$.asset.cgId')=NEW.cg_id
    AND json_extract(o.frozen_json,'$.asset.variant')=NEW.variant AND json_extract(o.frozen_json,'$.asset.characterId')=NEW.historical_character_id
    AND json_extract(o.frozen_json,'$.asset.eventDefId')=NEW.historical_event_def_id AND json_extract(o.frozen_json,'$.asset.assetVersion')=NEW.asset_version
    AND json_extract(o.frozen_json,'$.asset.assetHash')=NEW.asset_hash)
BEGIN SELECT RAISE(ABORT,'event CG requires exact finalized first-acquisition evidence'); END;
CREATE TRIGGER event_cg_excludes_trip BEFORE INSERT ON cg_unlocks
WHEN EXISTS(SELECT 1 FROM event_cg_unlocks g WHERE g.pet_id=NEW.pet_id AND g.cg_id=NEW.cg_id AND g.variant=NEW.variant)
BEGIN SELECT RAISE(ABORT,'CG first acquisition already belongs to an event'); END;
CREATE TRIGGER freeze_event_cg_acquisition BEFORE UPDATE ON event_cg_unlocks
WHEN OLD.pet_id IS NOT NEW.pet_id OR OLD.cg_id IS NOT NEW.cg_id OR OLD.variant IS NOT NEW.variant OR OLD.source_event_id IS NOT NEW.source_event_id
  OR OLD.unlocked_at IS NOT NEW.unlocked_at OR OLD.historical_character_id IS NOT NEW.historical_character_id OR OLD.historical_event_def_id IS NOT NEW.historical_event_def_id
  OR OLD.asset_version IS NOT NEW.asset_version OR OLD.asset_hash IS NOT NEW.asset_hash OR (OLD.viewed_at IS NOT NULL AND OLD.viewed_at IS NOT NEW.viewed_at)
BEGIN SELECT RAISE(ABORT,'event CG acquisition and first view are immutable'); END;
CREATE TRIGGER preserve_event_cg_acquisition BEFORE DELETE ON event_cg_unlocks BEGIN SELECT RAISE(ABORT,'event CG acquisition is immutable'); END;
CREATE TRIGGER validate_event_choice_receipt BEFORE INSERT ON commands
WHEN (EXISTS(SELECT 1 FROM event_finalizations f WHERE f.command_id=NEW.command_id)
  OR (json_extract(NEW.fingerprint,'$.type')='EVENT_CHOOSE' AND json_type(NEW.outcome_json,'$.ok')='true'))
  AND (EXISTS(SELECT 1 FROM commands c WHERE c.command_id=NEW.command_id) OR NOT EXISTS(
    SELECT 1 FROM event_finalizations f JOIN event_occurrences o USING(occurrence_id) WHERE f.command_id=NEW.command_id AND f.status='RESOLVED'
      AND NEW.created_at=f.resolved_at AND json_extract(NEW.fingerprint,'$.type')='EVENT_CHOOSE' AND json_type(NEW.outcome_json,'$.ok')='true'
      AND json_extract(NEW.fingerprint,'$.commandId')=NEW.command_id AND json_extract(NEW.fingerprint,'$.payload.petId')=o.pet_id
      AND json_extract(NEW.fingerprint,'$.payload.occurrenceId')=f.occurrence_id AND json_extract(NEW.fingerprint,'$.payload.choiceId')=f.choice_id
      AND json_type(NEW.fingerprint,'$.expectedRevision')='integer' AND json_extract(NEW.outcome_json,'$.snapshot.revision')=json_extract(NEW.fingerprint,'$.expectedRevision')+1
      AND EXISTS(SELECT 1 FROM preferences p WHERE p.singleton=1 AND p.revision=json_extract(NEW.outcome_json,'$.snapshot.revision') AND p.logical_time=NEW.created_at)
      AND EXISTS(SELECT 1 FROM wallet w WHERE w.balance=json_extract(NEW.outcome_json,'$.snapshot.walletCoins'))))
BEGIN SELECT RAISE(ABORT,'event choice requires exact immutable finalization and successful receipt'); END;
CREATE TRIGGER freeze_event_choice_receipt BEFORE UPDATE ON commands
WHEN EXISTS(SELECT 1 FROM event_finalizations f WHERE f.command_id=OLD.command_id)
  OR (json_extract(NEW.fingerprint,'$.type')='EVENT_CHOOSE' AND json_type(NEW.outcome_json,'$.ok')='true')
BEGIN SELECT RAISE(ABORT,'event choice receipt is immutable'); END;
CREATE TRIGGER preserve_event_choice_receipt BEFORE DELETE ON commands WHEN EXISTS(SELECT 1 FROM event_finalizations f WHERE f.command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT,'event choice receipt is immutable'); END;
`;

const MIGRATIONS = Object.freeze([
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
  { version: 4, sql: MIGRATION_004 },
  { version: 5, sql: MIGRATION_005 },
  { version: 6, sql: MIGRATION_006 },
  { version: 7, sql: MIGRATION_007 },
  { version: 8, sql: AI_STATE_MIGRATION_SQL },
  { version: 9, sql: WORKSPACE_MIGRATION_SQL },
  { version: 10, sql: VOICE_PROFILE_MIGRATION_SQL },
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

const eventNoReasons = ['NO_ELIGIBLE','CHANCE_MISS','TRIGGER_ALREADY_SEEN','TRIGGER_INELIGIBLE'] as const;
function eventTriggerKey(value: unknown): string {
  const key=string(value,'event trigger key',EVENT_LIMITS.triggerKey);
  if (!key.trim() || /[\u0000-\u001f\u007f]/u.test(key)) throw new Error('Invalid event trigger key');
  return key;
}
function validateTriggerReceipt(value: unknown): EventTriggerReceipt {
  const raw=object(value,'event trigger receipt');
  const kind=enumeration(raw.kind,'event trigger decision',['NO_EVENT','OCCURRENCE']);
  const data=closed(raw,'event trigger receipt',['triggerKey','petId','trigger','seed','at','rngState','drawCount','sourceTripId','routeId','kind',kind==='NO_EVENT'?'reason':'occurrenceId']);
  const trigger=enumeration(data.trigger,'event trigger kind',EVENT_TRIGGERS),seed=integer(data.seed,'event seed',1,UINT32_MAX);
  const drawCount=integer(data.drawCount,'event draw count',0,2) as 0|1|2;
  const rngState=integer(data.rngState,'event RNG state',1,UINT32_MAX);
  let expected=seed;
  for(let n=0;n<drawCount;n++){let x=expected|0;x^=x<<13;x^=x>>>17;x^=x<<5;expected=x>>>0;}
  if(rngState!==expected)throw new Error('Event RNG audit contradicts seed and draw count');
  const common={triggerKey:eventTriggerKey(data.triggerKey),petId:id(data.petId),trigger,seed,at:integer(data.at,'event trigger time'),rngState,drawCount,
    sourceTripId:data.sourceTripId===null?null:id(data.sourceTripId),routeId:data.routeId===null?null:id(data.routeId)};
  if((trigger==='TRIP_RETURNED')!==(common.sourceTripId!==null)||(trigger==='TRIP_RETURNED')!==(common.routeId!==null))throw new Error('Event trigger provenance is invalid');
  if(kind==='NO_EVENT'){
    const reason=enumeration(data.reason,'event no-selection reason',eventNoReasons);
    if(drawCount!==(reason==='CHANCE_MISS'?1:0))throw new Error('Event no-selection audit contradicts reason');
    return {...common,kind,reason};
  }
  if(drawCount!==2)throw new Error('Selected event requires two RNG draws');
  return {...common,kind,occurrenceId:id(data.occurrenceId)};
}
function eventReceiptFromRow(value: unknown): EventTriggerReceipt {
  const row=object(value,'event trigger row');
  if((row.decision==='NO_EVENT'&&row.occurrence_id!==null)||(row.decision==='OCCURRENCE'&&row.reason!==null))throw new Error('Corrupt event trigger receipt');
  return validateTriggerReceipt({triggerKey:row.trigger_key,petId:row.pet_id,trigger:row.trigger_kind,seed:row.seed,at:row.at,
    rngState:row.rng_state,drawCount:row.draw_count,sourceTripId:row.source_trip_id,routeId:row.route_id,kind:row.decision,
    ...(row.decision==='NO_EVENT'?{reason:row.reason}:{occurrenceId:row.occurrence_id})});
}
function validateStoredFrozenOccurrence(value: unknown): FrozenEventOccurrence {
  const occurrence=validateFrozenOccurrence(value);
  if(occurrence.asset?.state==='PINNED'){
    const {characterId,eventDefId,assetVersion,assetHash}=occurrence.asset;
    cgAssetRefSchema.parse({state:'PINNED',characterId,eventDefId,assetVersion,assetHash});
  }
  return occurrence;
}
const eventEffectKinds=['MOOD_DELTA','BOND_DELTA','COIN','ITEM','CG_UNLOCK'] as const;
function eventRewardFromRow(value: unknown): EventReward {
  const row=object(value,'event effect row'),kind=enumeration(row.kind,'event effect kind',eventEffectKinds);
  switch(kind){
    case 'MOOD_DELTA':case 'BOND_DELTA':return {kind,delta10:integer(row.amount,'applied event need delta',-200,200)};
    case 'COIN':return {kind,amount:integer(row.amount,'event coin reward',1,1000)};
    case 'ITEM':return {kind,itemId:id(row.target_id),quantity:integer(row.amount,'event item reward',1,100)};
    case 'CG_UNLOCK':return {kind,cgId:id(row.target_id),variant:id(row.variant),newlyUnlocked:sqlBoolean(row.amount,'event first CG acquisition')};
  }
}
function validateEventRewards(value: unknown): EventReward[] {
  const rewards=array(value,'event rewards',14).map(raw=>{
    const entry=object(raw,'event reward'),kind=enumeration(entry.kind,'event reward kind',eventEffectKinds);
    switch(kind){
      case 'MOOD_DELTA':case 'BOND_DELTA':closed(entry,'event need reward',['kind','delta10']);return {kind,delta10:integer(entry.delta10,'event need delta',-200,200)};
      case 'COIN':closed(entry,'event coin reward',['kind','amount']);return {kind,amount:integer(entry.amount,'event coin reward',1,1000)};
      case 'ITEM':closed(entry,'event item reward',['kind','itemId','quantity']);return {kind,itemId:id(entry.itemId),quantity:integer(entry.quantity,'event item reward',1,100)};
      case 'CG_UNLOCK':closed(entry,'event CG reward',['kind','cgId','variant','newlyUnlocked']);return {kind,cgId:id(entry.cgId),variant:id(entry.variant),newlyUnlocked:boolean(entry.newlyUnlocked,'CG first acquisition')};
    }
  }) satisfies EventReward[];
  const keys=rewards.map(r=>r.kind==='ITEM'?`ITEM:${r.itemId}`:r.kind);
  if(new Set(keys).size!==keys.length)throw new Error('Duplicate event reward identity');
  return rewards.sort((a,b)=>eventEffectKinds.indexOf(a.kind)-eventEffectKinds.indexOf(b.kind)
    || (a.kind==='ITEM'&&b.kind==='ITEM'?(a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0):0));
}
function validateEventFinalization(value: unknown,occurrence: FrozenEventOccurrence): {record:EventFinalizationRecord;draft:EventEffectDraft} {
  const data=closed(value,'event finalization',['occurrenceId','status','resolvedAt','choiceId','resultText','rewards','commandId']);
  const record:EventFinalizationRecord={occurrenceId:id(data.occurrenceId),status:enumeration(data.status,'event final status',['RESOLVED','EXPIRED']),
    resolvedAt:integer(data.resolvedAt,'event resolution time'),choiceId:data.choiceId===null?null:id(data.choiceId),
    resultText:string(data.resultText,'event result text',2048),rewards:validateEventRewards(data.rewards),commandId:data.commandId===null?null:id(data.commandId)};
  const common={occurrenceId:record.occurrenceId,petId:occurrence.petId,status:'PENDING' as const,at:record.resolvedAt};
  const request=record.status==='EXPIRED'?{...common,kind:'EXPIRE' as const}:record.choiceId===null?{...common,kind:'AUTO' as const}
    :{...common,kind:'CHOICE' as const,choiceId:record.choiceId};
  const resolution=resolveEventOccurrence(occurrence,request);
  if(!resolution.ok||resolution.status!==record.status||resolution.resolvedAt!==record.resolvedAt||resolution.choiceId!==record.choiceId
    ||resolution.resultText!==record.resultText||(request.kind==='CHOICE')!==(record.commandId!==null))throw new Error('Event finalization contradicts its frozen branch');
  const draft=resolution.effects;
  for(const [kind,requested] of [['MOOD_DELTA',draft.moodDelta10],['BOND_DELTA',draft.bondDelta10]] as const){
    const reward=record.rewards.find(r=>r.kind===kind);
    if(requested===0?reward!==undefined:!reward||!('delta10' in reward)||reward.delta10<Math.min(0,requested)||reward.delta10>Math.max(0,requested)){
      throw new Error('Event reward contradicts the frozen need delta');
    }
  }
  const coin=record.rewards.find(r=>r.kind==='COIN');
  if((coin?.amount??0)!==draft.coins)throw new Error('Event reward contradicts frozen coins');
  const items=record.rewards.filter((r):r is Extract<EventReward,{kind:'ITEM'}>=>r.kind==='ITEM').map(({itemId,quantity})=>({itemId,quantity}));
  if(!sameJson(items,draft.items))throw new Error('Event reward contradicts frozen items');
  const cg=record.rewards.find(r=>r.kind==='CG_UNLOCK');
  if(draft.cgUnlock===null?cg!==undefined:!cg||cg.cgId!==draft.cgUnlock.cgId||cg.variant!==draft.cgUnlock.variant)throw new Error('Event reward contradicts frozen CG');
  return {record,draft};
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

function validatePetAcquisition(value: unknown): PetAcquisitionRecord {
  const data = closed(value, 'pet acquisition', ['petId', 'acquiredAt', 'origin', 'catalogVersion', 'coinCost', 'commandId']);
  const record: PetAcquisitionRecord = {
    petId: id(data.petId), acquiredAt: integer(data.acquiredAt, 'pet acquisition time'),
    origin: enumeration(data.origin, 'pet acquisition origin', ['STARTER', 'GAME']),
    catalogVersion: integer(data.catalogVersion, 'character catalog version', 1), coinCost: integer(data.coinCost, 'pet acquisition cost'),
    commandId: data.commandId === null ? null : id(data.commandId),
  };
  if (record.origin === 'STARTER' ? record.coinCost !== 0 || record.commandId !== null : record.commandId === null) {
    throw new Error('Pet acquisition origin contradicts its cost or command');
  }
  return record;
}

function petAcquisitionFromRow(value: unknown): PetAcquisitionRecord {
  const row = object(value, 'pet acquisition row');
  return validatePetAcquisition({ petId: row.pet_id, acquiredAt: integer(row.acquired_at, 'pet acquisition time'),
    origin: row.origin, catalogVersion: integer(row.catalog_version, 'character catalog version', 1),
    coinCost: integer(row.coin_cost, 'pet acquisition cost'), commandId: row.command_id });
}

function validateHomeSchedule(value: unknown): HomeScheduleRecord {
  const data = closed(value, 'home schedule', ['petId', 'lastSimAt', 'activityDueAt', 'energyRemainder', 'healthRemainder',
    'moodRemainder', 'interactionDay', 'interactionCount', 'lastInteractionAt']);
  const lastSimAt = integer(data.lastSimAt, 'home simulation time');
  const day = (at: number) => Math.floor(at / MIGRATION_004_DAY_MS);
  const schedule: HomeScheduleRecord = {
    petId: id(data.petId), lastSimAt,
    activityDueAt: nullableInteger(data.activityDueAt, 'home activity due time'),
    energyRemainder: integer(data.energyRemainder, 'home energy remainder', 0, MIGRATION_004_HOUR_MS - 1),
    healthRemainder: integer(data.healthRemainder, 'home health remainder', 0, MIGRATION_004_HOUR_MS - 1),
    moodRemainder: integer(data.moodRemainder, 'home mood remainder', 0, MIGRATION_004_HOUR_MS - 1),
    interactionDay: integer(data.interactionDay, 'home interaction UTC day', 0, day(lastSimAt)),
    interactionCount: integer(data.interactionCount, 'home interaction count', 0, MIGRATION_004_DAILY_LIMIT),
    lastInteractionAt: nullableInteger(data.lastInteractionAt, 'last home interaction time'),
  };
  if (schedule.activityDueAt !== null && schedule.activityDueAt < lastSimAt) throw new Error('Home activity due time precedes its clock');
  if (schedule.lastInteractionAt !== null && schedule.lastInteractionAt > lastSimAt) throw new Error('Last home interaction exceeds its clock');
  if (schedule.interactionCount > 0 && (schedule.lastInteractionAt === null || day(schedule.lastInteractionAt) !== schedule.interactionDay)) {
    throw new Error('Rewarded home interactions require an interaction timestamp in their UTC day');
  }
  return schedule;
}

function homeScheduleFromRow(value: unknown): HomeScheduleRecord {
  const row = object(value, 'home schedule row');
  return validateHomeSchedule({ petId: row.pet_id, lastSimAt: integer(row.last_sim_at, 'home simulation time'),
    activityDueAt: nullableInteger(row.activity_due_at, 'home activity due time'),
    energyRemainder: integer(row.energy_remainder, 'home energy remainder'), healthRemainder: integer(row.health_remainder, 'home health remainder'),
    moodRemainder: integer(row.mood_remainder, 'home mood remainder'), interactionDay: integer(row.interaction_day, 'home interaction UTC day'),
    interactionCount: integer(row.interaction_count, 'home interaction count'), lastInteractionAt: nullableInteger(row.last_interaction_at, 'last home interaction time') });
}

function homeScheduleRegresses(previous: HomeScheduleRecord, next: HomeScheduleRecord): boolean {
  return next.lastSimAt < previous.lastSimAt || next.interactionDay < previous.interactionDay
    || (next.interactionDay === previous.interactionDay && next.interactionCount < previous.interactionCount)
    || (previous.lastInteractionAt !== null && (next.lastInteractionAt === null || next.lastInteractionAt < previous.lastInteractionAt));
}

function equipmentSlot(value: unknown): EquipmentSlot {
  return enumeration(value, 'equipment slot', ['WEAPON', 'ARMOR', 'ACCESSORY']);
}

function validateItemInstance(value: unknown): ItemInstanceRecord {
  const item = closed(value, 'item instance', ['instanceId', 'definitionId', 'definitionVersion', 'enhancement', 'acquiredAt']);
  return { instanceId: id(item.instanceId), definitionId: id(item.definitionId), definitionVersion: integer(item.definitionVersion, 'item definition version', 1),
    enhancement: integer(item.enhancement, 'equipment enhancement', 0, MIGRATION_005_ENHANCEMENT_LIMIT),
    acquiredAt: integer(item.acquiredAt, 'item acquisition time') };
}

function itemInstanceFromRow(value: unknown): ItemInstanceRecord {
  const row = object(value, 'item instance row');
  if (integer(row.retired, 'item retirement flag', 0, 1) !== 0) throw new Error('Retired item is not an active instance');
  return validateItemInstance({ instanceId: row.instance_id, definitionId: row.definition_id,
    definitionVersion: integer(row.definition_version, 'item definition version', 1), enhancement: integer(row.enhancement, 'equipment enhancement'),
    acquiredAt: integer(row.acquired_at, 'item acquisition time') });
}

function validateEquipmentBinding(value: unknown): PetEquipmentRecord {
  const binding = closed(value, 'equipment binding', ['petId', 'slot', 'instanceId']);
  return { petId: id(binding.petId), slot: equipmentSlot(binding.slot), instanceId: id(binding.instanceId) };
}

function equipmentBindingFromRow(value: unknown): PetEquipmentRecord {
  const row = object(value, 'equipment binding row');
  return validateEquipmentBinding({ petId: row.pet_id, slot: row.slot, instanceId: row.instance_id });
}

const commerceTypes = ['SHOP_PURCHASE','EQUIPMENT_EQUIP','EQUIPMENT_UNEQUIP','EQUIPMENT_UPGRADE','EQUIPMENT_SALVAGE','ITEM_USE'] as const;
const commerceCommonFields = ['commandId','occurredAt','catalogVersion','type'] as const;
function validateCommerceMaterials(value: unknown): CommerceMaterialAmount[] {
  const materials = array(value, 'commerce materials', MIGRATION_005_MATERIAL_LIMIT).map(raw => {
    const entry = closed(raw, 'commerce material', ['itemId','quantity']);
    return { itemId: id(entry.itemId), quantity: integer(entry.quantity, 'commerce material quantity', 1) };
  }).sort((a,b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
  if (materials.length === 0 || new Set(materials.map(entry => entry.itemId)).size !== materials.length) throw new Error('Commerce materials must be nonempty and unique');
  return materials;
}

function validateCommerceOperation(value: unknown): CommerceOperationRecord {
  const raw = object(value, 'commerce operation');
  const common = { commandId: id(raw.commandId), occurredAt: integer(raw.occurredAt, 'commerce operation time'),
    catalogVersion: integer(raw.catalogVersion, 'commerce catalog version', 1) };
  const type = enumeration(raw.type, 'commerce operation type', commerceTypes);
  switch (type) {
    case 'SHOP_PURCHASE': {
      closed(raw,'shop operation',[...commerceCommonFields,'offerId','itemId','quantity','coinCost','outputKind','instanceIds']);
      const quantity = integer(raw.quantity,'purchase quantity',1,MIGRATION_005_PURCHASE_LIMIT);
      const outputKind = enumeration(raw.outputKind,'purchase output kind',['STACK','EQUIPMENT']);
      const instanceIds = array(raw.instanceIds,'purchase instance IDs',MIGRATION_005_PURCHASE_LIMIT).map(id).sort();
      if (new Set(instanceIds).size !== instanceIds.length || instanceIds.length !== (outputKind === 'EQUIPMENT' ? quantity : 0)) {
        throw new Error('Purchased equipment IDs contradict quantity or output kind');
      }
      return { ...common,type,offerId:id(raw.offerId),itemId:id(raw.itemId),quantity,coinCost:integer(raw.coinCost,'purchase coin cost'),outputKind,instanceIds };
    }
    case 'EQUIPMENT_EQUIP': {
      closed(raw,'equip operation',[...commerceCommonFields,'petId','slot','instanceId','previousInstanceId']);
      const instanceId = id(raw.instanceId), previousInstanceId = raw.previousInstanceId === null ? null : id(raw.previousInstanceId);
      if (previousInstanceId === instanceId) throw new Error('Equip operation cannot replace itself');
      return { ...common,type,petId:id(raw.petId),slot:equipmentSlot(raw.slot),instanceId,previousInstanceId };
    }
    case 'EQUIPMENT_UNEQUIP':
      closed(raw,'unequip operation',[...commerceCommonFields,'petId','slot','instanceId']);
      return { ...common,type,petId:id(raw.petId),slot:equipmentSlot(raw.slot),instanceId:id(raw.instanceId) };
    case 'EQUIPMENT_UPGRADE': {
      closed(raw,'upgrade operation',[...commerceCommonFields,'instanceId','fromEnhancement','toEnhancement','coinCost','materials']);
      const fromEnhancement = integer(raw.fromEnhancement,'upgrade previous enhancement',0,MIGRATION_005_ENHANCEMENT_LIMIT-1);
      const toEnhancement = integer(raw.toEnhancement,'upgrade next enhancement',1,MIGRATION_005_ENHANCEMENT_LIMIT);
      if (toEnhancement !== fromEnhancement+1) throw new Error('Upgrade operation requires exactly one enhancement');
      return { ...common,type,instanceId:id(raw.instanceId),fromEnhancement,toEnhancement,coinCost:integer(raw.coinCost,'upgrade coin cost'),
        materials:validateCommerceMaterials(raw.materials) };
    }
    case 'EQUIPMENT_SALVAGE':
      closed(raw,'salvage operation',[...commerceCommonFields,'instanceId','enhancement','materials']);
      return { ...common,type,instanceId:id(raw.instanceId),enhancement:integer(raw.enhancement,'salvaged enhancement',0,MIGRATION_005_ENHANCEMENT_LIMIT),
        materials:validateCommerceMaterials(raw.materials) };
    case 'ITEM_USE':
      closed(raw,'item use operation',[...commerceCommonFields,'petId','itemId']);
      return { ...common,type,petId:id(raw.petId),itemId:id(raw.itemId) };
  }
}

function commerceOperationFromRow(value: unknown, materials: CommerceMaterialAmount[], instanceIds: string[]): CommerceOperationRecord {
  const row = object(value, 'commerce operation row');
  const type = enumeration(row.operation_type,'commerce operation type',commerceTypes);
  const common = { commandId: row.command_id, occurredAt: integer(row.occurred_at,'commerce operation time'),
    catalogVersion: integer(row.catalog_version,'commerce catalog version',1), type };
  const optionalColumns = ['offer_id','item_id','quantity','coin_cost','output_kind','pet_id','slot','instance_id','previous_instance_id','from_enhancement','to_enhancement'];
  const requireColumns = (used: readonly string[], allowMaterials = false, allowInstances = false): void => {
    if (optionalColumns.some(key => !used.includes(key) && row[key] !== null) || (!allowMaterials && materials.length !== 0) || (!allowInstances && instanceIds.length !== 0)) {
      throw new Error('Commerce row has contradictory extra evidence');
    }
  };
  switch (type) {
    case 'SHOP_PURCHASE':
      requireColumns(['offer_id','item_id','quantity','coin_cost','output_kind'],false,true);
      return validateCommerceOperation({ ...common,offerId:row.offer_id,itemId:row.item_id,quantity:integer(row.quantity,'purchase quantity'),
        coinCost:integer(row.coin_cost,'purchase coin cost'),outputKind:row.output_kind,instanceIds });
    case 'EQUIPMENT_EQUIP':
      requireColumns(['pet_id','slot','instance_id','previous_instance_id']);
      return validateCommerceOperation({ ...common,petId:row.pet_id,slot:row.slot,instanceId:row.instance_id,previousInstanceId:row.previous_instance_id });
    case 'EQUIPMENT_UNEQUIP':
      requireColumns(['pet_id','slot','instance_id']);
      return validateCommerceOperation({ ...common,petId:row.pet_id,slot:row.slot,instanceId:row.instance_id });
    case 'EQUIPMENT_UPGRADE':
      requireColumns(['instance_id','from_enhancement','to_enhancement','coin_cost'],true);
      return validateCommerceOperation({ ...common,instanceId:row.instance_id,fromEnhancement:integer(row.from_enhancement,'previous enhancement'),
        toEnhancement:integer(row.to_enhancement,'next enhancement'),coinCost:integer(row.coin_cost,'upgrade coin cost'),materials });
    case 'EQUIPMENT_SALVAGE':
      requireColumns(['instance_id','from_enhancement'],true);
      return validateCommerceOperation({ ...common,instanceId:row.instance_id,enhancement:integer(row.from_enhancement,'salvaged enhancement'),materials });
    case 'ITEM_USE':
      requireColumns(['pet_id','item_id']);
      return validateCommerceOperation({ ...common,petId:row.pet_id,itemId:row.item_id });
  }
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

function departureStatsFromRow(row: ObjectMap, prefix: 'stats' | 'bonus') {
  const keys = ['hp','atk','def','spd','luk'] as const;
  const values = keys.map(key => row[`${prefix}_${key}`]);
  if (values.every(value => value === null)) return null;
  if (values.some(value => value === null)) throw new Error('Persisted departure stats are partially absent');
  return { hp: integer(values[0], `${prefix} HP`, prefix === 'stats' ? 1 : 0, MIGRATION_006_STAT_LIMIT),
    atk: integer(values[1], `${prefix} ATK`, 0, MIGRATION_006_STAT_LIMIT), def: integer(values[2], `${prefix} DEF`, 0, MIGRATION_006_STAT_LIMIT),
    spd: integer(values[3], `${prefix} SPD`, 0, MIGRATION_006_STAT_LIMIT), luk: integer(values[4], `${prefix} LUK`, 0, MIGRATION_006_STAT_LIMIT) };
}

function departureStatsParams(stats: TripDepartureLoadout['stats']): [number|null,number|null,number|null,number|null,number|null] {
  return stats === null ? [null,null,null,null,null] : [stats.hp,stats.atk,stats.def,stats.spd,stats.luk];
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

  aiState(): AiStateStorage { return new AiStateStorage(this.db, this.inScope); }
  workspaceState(): WorkspaceStorage { return new WorkspaceStorage(this.db, this.inScope); }
  voiceProfiles(): VoiceProfileStorage { return new VoiceProfileStorage(this.db, this.inScope); }

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

  getPetAcquisition(petId: string): PetAcquisitionRecord | null {
    const value = this.db.prepare('SELECT * FROM pet_acquisitions WHERE pet_id=?').get(id(petId));
    return value === undefined || value === null ? null : petAcquisitionFromRow(value);
  }

  insertPetAcquisition(record: PetAcquisitionRecord): void {
    const db = this.db, acquisition = validatePetAcquisition(record);
    // The first acquisition is a history record, not a state upsert.
    if (this.getPetAcquisition(acquisition.petId) !== null) throw new Error('Pet acquisition is immutable and unique');
    db.prepare(`INSERT INTO pet_acquisitions (pet_id,acquired_at,origin,catalog_version,coin_cost,command_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(acquisition.petId, acquisition.acquiredAt, acquisition.origin,
        acquisition.catalogVersion, acquisition.coinCost, acquisition.commandId);
  }

  getHomeSchedule(petId: string): HomeScheduleRecord | null {
    const value = this.db.prepare('SELECT * FROM pet_home_schedules WHERE pet_id=?').get(id(petId));
    if (value === undefined || value === null) return null;
    const schedule = homeScheduleFromRow(value);
    const preferences = this.getPreferences();
    if (preferences !== null && schedule.lastSimAt > preferences.logicalTime) throw new Error('Home schedule exceeds application logical time');
    return schedule;
  }

  saveHomeSchedule(record: HomeScheduleRecord): void {
    const db = this.db, schedule = validateHomeSchedule(record);
    const previous = this.getHomeSchedule(schedule.petId), preferences = this.getPreferences();
    if (previous !== null && homeScheduleRegresses(previous, schedule)) throw new Error('Home schedule clock cannot regress');
    if (preferences !== null && schedule.lastSimAt > preferences.logicalTime) throw new Error('Home schedule exceeds application logical time');
    db.prepare(`INSERT INTO pet_home_schedules (pet_id,last_sim_at,activity_due_at,energy_remainder,health_remainder,mood_remainder,
      interaction_day,interaction_count,last_interaction_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pet_id) DO UPDATE SET last_sim_at=excluded.last_sim_at,activity_due_at=excluded.activity_due_at,
        energy_remainder=excluded.energy_remainder,health_remainder=excluded.health_remainder,mood_remainder=excluded.mood_remainder,
        interaction_day=excluded.interaction_day,interaction_count=excluded.interaction_count,last_interaction_at=excluded.last_interaction_at`)
      .run(schedule.petId, schedule.lastSimAt, schedule.activityDueAt, schedule.energyRemainder, schedule.healthRemainder,
        schedule.moodRemainder, schedule.interactionDay, schedule.interactionCount, schedule.lastInteractionAt);
  }

  listTrips(): TripRecord[] {
    return this.db.prepare(`${TRIP_SELECT} ORDER BY t.start_at, t.pet_id, t.trip_id`).all().map(tripFromRow);
  }

  listSettledTrips(rawQuery: TravelReportsQuery): { total: number; trips: TripRecord[] } {
    const query = travelReportsQuerySchema.parse(rawQuery), db = this.db;
    const parameters = query.petId === undefined ? [] : [query.petId];
    const filter = query.petId === undefined ? "t.status='SETTLED'" : "t.status='SETTLED' AND t.pet_id=?";
    const total = integer(object(db.prepare(`SELECT count(*) AS count FROM trips t WHERE ${filter}`).get(...parameters),
      'settled trip count').count, 'settled trip count');
    const trips = db.prepare(`${TRIP_SELECT} WHERE ${filter} ORDER BY t.actual_returned_at DESC,t.trip_id ASC LIMIT ? OFFSET ?`)
      .all(...parameters,query.limit,query.offset).map(tripFromRow);
    return { total,trips };
  }

  getTrip(tripId: string): TripRecord | null {
    const value = this.db.prepare(`${TRIP_SELECT} WHERE t.trip_id = ?`).get(id(tripId));
    return value === undefined || value === null ? null : tripFromRow(value);
  }

  insertTrip(record: TripRecord, departureLoadoutRequired = false): void {
    const db = this.db;
    const { snapshot: s, checkpoint: c, status } = validateTrip(record);
    if (status !== 'TRAVELING' || c.phase !== 'OUTBOUND' || c.sequence !== 0) throw new Error('New trip must begin outbound');
    const marker = boolean(departureLoadoutRequired, 'departure loadout required') ? s.tripId : null;
    db.prepare(`INSERT INTO trips (trip_id, pet_id, route_id, status, seed, snapshot_json, checkpoint_json,
      json_schema_version, start_at, expected_return_at, actual_returned_at, next_due_at, rules_version, cg_pin_schema, departure_loadout_trip_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`)
      .run(s.tripId, s.petId, s.routeId, status, s.seed, canonicalJson(s), canonicalJson(c), JSON_SCHEMA_VERSION,
        s.startAt, s.expectedReturnAt, c.actualReturnedAt, c.nextDueAt, s.rulesVersion,marker);
  }

  insertTripDepartureLoadout(value: TripDepartureLoadoutRecord): void {
    const db = this.db, record = validateTripDepartureLoadoutRecord(value), loadout = record.loadout;
    const trip = this.getTrip(record.tripId);
    if (trip === null || loadout.battlePower !== trip.snapshot.power) throw new Error('Departure loadout contradicts its trip power');
    const pet = this.getPet(trip.snapshot.petId);
    if (pet === null || pet.presence !== 'HOME' || pet.energy10 < loadout.energyCost10) throw new Error('Departure loadout requires current HOME pet energy');
    db.prepare(`INSERT INTO trip_departure_loadouts (trip_id,command_id,route_catalog_version,item_catalog_version,level,
      energy_cost10,energy_before10,battle_power,stats_hp,stats_atk,stats_def,stats_spd,stats_luk) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.tripId,record.commandId,loadout.routeCatalogVersion,loadout.itemCatalogVersion,loadout.level,loadout.energyCost10,
        pet.energy10,loadout.battlePower,...departureStatsParams(loadout.stats));
    for (const supply of loadout.supplies) db.prepare('INSERT INTO trip_departure_supplies VALUES (?,?,?)')
      .run(record.tripId,supply.itemId,supply.quantity);
    for (const gear of loadout.equipment) db.prepare(`INSERT INTO trip_departure_equipment (trip_id,slot,instance_id,definition_id,
      definition_version,enhancement,bonus_hp,bonus_atk,bonus_def,bonus_spd,bonus_luk) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.tripId,gear.slot,gear.instanceId,gear.definitionId,gear.definitionVersion,gear.enhancement,...departureStatsParams(gear.bonus));
  }

  getTripDepartureLoadout(tripId: string): TripDepartureLoadout | null {
    const db = this.db, key = id(tripId), value = db.prepare(`SELECT l.*,t.departure_loadout_trip_id AS required_trip_id,
      json_extract(t.snapshot_json,'$.power') AS trip_power FROM trip_departure_loadouts l JOIN trips t USING(trip_id) WHERE trip_id=?`).get(key);
    if (value === undefined || value === null) return null;
    const row = object(value,'trip departure loadout row');
    const battlePower = integer(row.battle_power,'departure battle power',1,1000);
    const energyCost10 = integer(row.energy_cost10,'departure energy cost',1,1000);
    integer(row.energy_before10,'departure pre-cost energy',energyCost10,1000);
    id(row.command_id);
    if (row.required_trip_id !== key || battlePower !== integer(row.trip_power,'trip snapshot departure power',1,1000)) {
      throw new Error('Persisted departure loadout contradicts its trip identity or power');
    }
    const supplies = db.prepare('SELECT item_id,quantity FROM trip_departure_supplies WHERE trip_id=? ORDER BY item_id').all(key).map(raw => {
      const supply = object(raw,'departure supply row');
      return { itemId:id(supply.item_id),quantity:integer(supply.quantity,'departure supply quantity',1,20) };
    });
    const equipment = db.prepare('SELECT * FROM trip_departure_equipment WHERE trip_id=? ORDER BY slot').all(key).map(raw => {
      const gear = object(raw,'departure equipment row');
      return { slot:equipmentSlot(gear.slot),instanceId:id(gear.instance_id),definitionId:id(gear.definition_id),
        definitionVersion:integer(gear.definition_version,'departure equipment version',1),enhancement:integer(gear.enhancement,'departure enhancement',0,5),
        bonus:departureStatsFromRow(gear,'bonus') };
    });
    return canonicalTripDepartureLoadout({ routeCatalogVersion:integer(row.route_catalog_version,'departure route catalog version',1),
      itemCatalogVersion:integer(row.item_catalog_version,'departure item catalog version',1),level:integer(row.level,'departure level',1,20),
      energyCost10,supplies,stats:departureStatsFromRow(row,'stats'),battlePower,equipment });
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

  getEventTriggerReceipt(triggerKey: string): EventTriggerReceipt | null {
    const row=this.db.prepare('SELECT * FROM event_trigger_receipts WHERE trigger_key=?').get(eventTriggerKey(triggerKey));
    return row===undefined||row===null?null:eventReceiptFromRow(row);
  }

  insertEventTriggerReceipt(value: EventTriggerReceipt): void {
    const record=validateTriggerReceipt(value);
    this.db.prepare(`INSERT INTO event_trigger_receipts(trigger_key,pet_id,trigger_kind,seed,at,rng_state,draw_count,source_trip_id,route_id,decision,reason,occurrence_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.triggerKey,record.petId,record.trigger,record.seed,record.at,record.rngState,record.drawCount,
        record.sourceTripId,record.routeId,record.kind,record.kind==='NO_EVENT'?record.reason:null,record.kind==='OCCURRENCE'?record.occurrenceId:null);
  }

  insertEventOccurrence(value: FrozenEventOccurrence): void {
    const occurrence=validateStoredFrozenOccurrence(value);
    this.db.prepare(`INSERT INTO event_occurrences(occurrence_id,trigger_key,pet_id,event_id,event_version,occurred_at,deadline_at,frozen_json,auto_finalization_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(occurrence.occurrenceId,occurrence.triggerKey,occurrence.petId,occurrence.eventId,occurrence.eventVersion,
        occurrence.occurredAt,occurrence.deadlineAt,canonicalJson(occurrence),occurrence.deadlineAt===null?occurrence.occurrenceId:null);
  }

  private eventOccurrenceFromRow(value: unknown): EventOccurrenceRecord {
    const db=this.db,row=object(value,'event occurrence row'),occurrence=validateStoredFrozenOccurrence(parseJson(row.frozen_json,'frozen event JSON'));
    if(row.occurrence_id!==occurrence.occurrenceId||row.trigger_key!==occurrence.triggerKey||row.pet_id!==occurrence.petId
      ||row.event_id!==occurrence.eventId||row.event_version!==occurrence.eventVersion||row.occurred_at!==occurrence.occurredAt||row.deadline_at!==occurrence.deadlineAt
      ||row.auto_finalization_id!==(occurrence.deadlineAt===null?occurrence.occurrenceId:null))throw new Error('Frozen event contradicts indexed identity');
    const receipt=this.getEventTriggerReceipt(occurrence.triggerKey);
    if(receipt===null||receipt.kind!=='OCCURRENCE'||receipt.occurrenceId!==occurrence.occurrenceId||receipt.petId!==occurrence.petId
      ||receipt.trigger!==occurrence.trigger||receipt.seed!==occurrence.seed||receipt.at!==occurrence.occurredAt
      ||receipt.sourceTripId!==occurrence.sourceTripId||receipt.routeId!==occurrence.routeId)throw new Error('Frozen event contradicts its trigger receipt');
    const final=db.prepare('SELECT * FROM event_finalizations WHERE occurrence_id=?').get(occurrence.occurrenceId);
    const effects=db.prepare('SELECT * FROM event_effects WHERE occurrence_id=? ORDER BY kind,target_id').all(occurrence.occurrenceId);
    if(final===undefined||final===null){
      if(effects.length!==0)throw new Error('Pending event has premature effect evidence');
      return {occurrence,status:'PENDING',resolvedAt:null,choiceId:null,resultText:null,rewards:[],commandId:null};
    }
    const f=object(final,'event finalization row');
    const {record}=validateEventFinalization({occurrenceId:f.occurrence_id,status:f.status,resolvedAt:f.resolved_at,choiceId:f.choice_id,
      resultText:f.result_text,commandId:f.command_id,rewards:effects.map(eventRewardFromRow)},occurrence);
    return {occurrence,status:record.status,resolvedAt:record.resolvedAt,choiceId:record.choiceId,resultText:record.resultText,rewards:record.rewards,commandId:record.commandId};
  }

  getEventOccurrence(occurrenceId: string): EventOccurrenceRecord | null {
    const value=this.db.prepare('SELECT * FROM event_occurrences WHERE occurrence_id=?').get(id(occurrenceId));
    return value===undefined||value===null?null:this.eventOccurrenceFromRow(value);
  }

  listEventHistory(petId: string, at: number): EventHistoryEntry[] {
    const time=integer(at,'event history time');
    const rows=this.db.prepare(`SELECT o.occurrence_id,o.trigger_key,o.pet_id,o.event_id,o.event_version,o.occurred_at,f.status,f.resolved_at,f.choice_id
      FROM event_occurrences o LEFT JOIN event_finalizations f USING(occurrence_id) WHERE o.pet_id=? AND o.occurred_at<=?
      ORDER BY o.occurred_at ASC,o.occurrence_id ASC LIMIT ?`).all(id(petId),time,EVENT_LIMITS.history+1);
    if(rows.length>EVENT_LIMITS.history)throw new Error('Event history exceeds deterministic engine limit');
    return rows.map(value=>{
      const r=object(value,'event history row'),occurredAt=integer(r.occurred_at,'event history time',0,time);
      const resolvedAt=r.resolved_at===null?null:integer(r.resolved_at,'event history resolution',occurredAt);
      const pending=resolvedAt===null||resolvedAt>time;
      return {occurrenceId:id(r.occurrence_id),triggerKey:eventTriggerKey(r.trigger_key),petId:id(r.pet_id),eventId:id(r.event_id),
        eventVersion:integer(r.event_version,'event history version',1,EVENT_LIMITS.version),occurredAt,status:pending?'PENDING':enumeration(r.status,'event history status',['RESOLVED','EXPIRED']),
        resolvedAt:pending?null:resolvedAt,choiceId:pending||r.choice_id===null?null:id(r.choice_id)};
    });
  }

  countPendingEvents(petId?: string): number {
    const parameters=petId===undefined?[]:[id(petId)];
    return integer(object(this.db.prepare(`SELECT count(*) AS count FROM event_occurrences o LEFT JOIN event_finalizations f USING(occurrence_id)
      WHERE f.occurrence_id IS NULL${petId===undefined?'':' AND o.pet_id=?'}`).get(...parameters),'pending event count').count,'pending event count');
  }

  listDueEvents(at: number): EventOccurrenceRecord[] {
    return this.db.prepare(`SELECT o.* FROM event_occurrences o LEFT JOIN event_finalizations f USING(occurrence_id)
      WHERE f.occurrence_id IS NULL AND o.deadline_at<=? ORDER BY o.deadline_at ASC,o.occurrence_id ASC`)
      .all(integer(at,'event due query time')).map(row=>this.eventOccurrenceFromRow(row));
  }

  listEvents(raw: EventListQuery): {total:number;pendingTotal:number;events:EventOccurrenceRecord[]} {
    const query=eventListQuerySchema.parse(raw),parameters=query.petId===undefined?[]:[query.petId];
    const filter=`WHERE 1=1${query.petId===undefined?'':' AND o.pet_id=?'}${query.filter==='PENDING'?' AND f.occurrence_id IS NULL':query.filter==='HISTORY'?' AND f.occurrence_id IS NOT NULL':''}`;
    const from='FROM event_occurrences o LEFT JOIN event_finalizations f USING(occurrence_id)';
    const total=integer(object(this.db.prepare(`SELECT count(*) AS count ${from} ${filter}`).get(...parameters),'event page count').count,'event page count');
    const events=this.db.prepare(`SELECT o.* ${from} ${filter} ORDER BY o.occurred_at DESC,o.occurrence_id ASC LIMIT ? OFFSET ?`)
      .all(...parameters,query.limit,query.offset).map(row=>this.eventOccurrenceFromRow(row));
    return {total,pendingTotal:this.countPendingEvents(query.petId),events};
  }

  finalizeEventOccurrence(value: EventFinalizationRecord): boolean {
    const db=this.db,existing=this.getEventOccurrence(id(value.occurrenceId));
    if(existing===null)throw new Error('Event finalization requires an existing occurrence');
    if(existing.status!=='PENDING')return false;
    const {record,draft}=validateEventFinalization(value,existing.occurrence),petId=existing.occurrence.petId;
    const cg=record.rewards.find(r=>r.kind==='CG_UNLOCK');
    if(cg&&(cg.newlyUnlocked!==(this.getCgUnlock(petId,cg.cgId,cg.variant)===null&&this.getEventCgUnlock(petId,cg.cgId,cg.variant)===null)))
      throw new Error('Event CG reward contradicts first acquisition');
    for(const reward of record.rewards){
      const targetId=reward.kind==='ITEM'?reward.itemId:reward.kind==='CG_UNLOCK'?reward.cgId:'';
      const amount=reward.kind==='ITEM'?reward.quantity:reward.kind==='COIN'?reward.amount:reward.kind==='CG_UNLOCK'?Number(reward.newlyUnlocked):reward.delta10;
      db.prepare('INSERT INTO event_effects VALUES(?,?,?,?,?,?)').run(record.occurrenceId,reward.kind,targetId,reward.kind==='CG_UNLOCK'?reward.variant:null,
        amount,reward.kind==='CG_UNLOCK'&&reward.newlyUnlocked?record.occurrenceId:null);
    }
    db.prepare('INSERT INTO event_finalizations VALUES(?,?,?,?,?,?)').run(record.occurrenceId,record.status,record.resolvedAt,record.choiceId,record.resultText,record.commandId);
    if(cg?.newlyUnlocked){
      const asset=draft.cgUnlock;
      if(asset===null)throw new Error('Event CG reward has no pinned asset');
      db.prepare(`INSERT INTO event_cg_unlocks(pet_id,cg_id,variant,source_event_id,unlocked_at,historical_character_id,historical_event_def_id,asset_version,asset_hash)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(petId,asset.cgId,asset.variant,record.occurrenceId,record.resolvedAt,asset.characterId,asset.eventDefId,asset.assetVersion,asset.assetHash);
    }
    return true;
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

  listItemInstances(): ItemInstanceRecord[] {
    const instances = this.db.prepare('SELECT * FROM item_instances WHERE retired=0 ORDER BY instance_id').all().map(itemInstanceFromRow);
    if (instances.length > MIGRATION_005_INSTANCE_LIMIT) throw new Error('Active equipment capacity is corrupt');
    return instances;
  }

  getItemInstance(instanceId: string): ItemInstanceRecord | null {
    const value = this.db.prepare('SELECT * FROM item_instances WHERE instance_id=? AND retired=0').get(id(instanceId));
    return value === undefined || value === null ? null : itemInstanceFromRow(value);
  }

  insertItemInstance(record: ItemInstanceRecord): void {
    const db = this.db, item = validateItemInstance(record);
    if (item.enhancement !== 0) throw new Error('New item instance must start at +0');
    db.prepare('INSERT INTO item_instances (instance_id,definition_id,definition_version,enhancement,acquired_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.instanceId,item.definitionId,item.definitionVersion,item.enhancement,item.acquiredAt);
  }

  upgradeItemInstance(instanceId: string, expectedEnhancement: number): ItemInstanceRecord {
    const db = this.db, item = this.getItemInstance(instanceId);
    const expected = integer(expectedEnhancement,'expected enhancement',0,MIGRATION_005_ENHANCEMENT_LIMIT-1);
    if (item === null || item.enhancement !== expected) throw new Error('Equipment upgrade requires active instance at expected enhancement');
    const result = db.prepare('UPDATE item_instances SET enhancement=enhancement+1 WHERE instance_id=? AND retired=0 AND enhancement=?')
      .run(item.instanceId,expected);
    if (integer(result.changes,'equipment upgrade change count') !== 1) throw new Error('Equipment upgrade did not commit');
    return { ...item,enhancement:expected+1 };
  }

  deleteItemInstance(instanceId: string): void {
    const db = this.db, item = this.getItemInstance(instanceId);
    if (item === null) throw new Error('Equipment instance does not exist');
    if (this.getInstanceEquipment(instanceId) !== null) throw new Error('Equipped instance must be unequipped before retirement');
    const result = db.prepare('UPDATE item_instances SET retired=1 WHERE instance_id=? AND retired=0').run(item.instanceId);
    if (integer(result.changes,'equipment retirement change count') !== 1) throw new Error('Equipment retirement did not commit');
  }

  private checkedEquipmentBinding(value: unknown): PetEquipmentRecord {
    const binding = equipmentBindingFromRow(value);
    if (this.getItemInstance(binding.instanceId) === null) throw new Error('Equipment binding references retired or missing instance');
    return binding;
  }

  listPetEquipment(petId?: string): PetEquipmentRecord[] {
    const rows = petId === undefined ? this.db.prepare('SELECT * FROM pet_equipment ORDER BY pet_id,slot').all()
      : this.db.prepare('SELECT * FROM pet_equipment WHERE pet_id=? ORDER BY slot').all(id(petId));
    return rows.map(value => this.checkedEquipmentBinding(value));
  }

  getPetEquipment(petId: string, slot: EquipmentSlot): PetEquipmentRecord | null {
    const value = this.db.prepare('SELECT * FROM pet_equipment WHERE pet_id=? AND slot=?').get(id(petId),equipmentSlot(slot));
    return value === undefined || value === null ? null : this.checkedEquipmentBinding(value);
  }

  getInstanceEquipment(instanceId: string): PetEquipmentRecord | null {
    const value = this.db.prepare('SELECT * FROM pet_equipment WHERE instance_id=?').get(id(instanceId));
    return value === undefined || value === null ? null : this.checkedEquipmentBinding(value);
  }

  equipItem(record: PetEquipmentRecord): void {
    const db = this.db, binding = validateEquipmentBinding(record);
    if (this.getItemInstance(binding.instanceId) === null || this.getPetEquipment(binding.petId,binding.slot) !== null
      || this.getInstanceEquipment(binding.instanceId) !== null) throw new Error('Equipment binding requires free slot and active unequipped instance');
    db.prepare('INSERT INTO pet_equipment (pet_id,slot,instance_id) VALUES (?, ?, ?)').run(binding.petId,binding.slot,binding.instanceId);
  }

  unequipItem(petId: string, slot: EquipmentSlot, expectedInstanceId: string): void {
    const db = this.db, result = db.prepare('DELETE FROM pet_equipment WHERE pet_id=? AND slot=? AND instance_id=?')
      .run(id(petId),equipmentSlot(slot),id(expectedInstanceId));
    if (integer(result.changes,'equipment unequip change count') !== 1) throw new Error('Equipment binding does not match expected instance');
  }

  getCommerceOperation(commandId: string): CommerceOperationRecord | null {
    const db = this.db, key = id(commandId), row = db.prepare('SELECT * FROM commerce_operations WHERE command_id=?').get(key);
    if (row === undefined || row === null) return null;
    const materials = db.prepare('SELECT item_id,quantity FROM commerce_operation_materials WHERE command_id=? ORDER BY item_id').all(key).map(raw => {
      const value = object(raw,'commerce material row'); return { itemId:id(value.item_id),quantity:integer(value.quantity,'commerce material quantity',1) };
    });
    const instanceIds = db.prepare('SELECT instance_id FROM commerce_operation_instances WHERE command_id=? ORDER BY instance_id').all(key)
      .map(raw => id(object(raw,'commerce instance row').instance_id));
    return commerceOperationFromRow(row,materials,instanceIds);
  }

  insertCommerceOperation(record: CommerceOperationRecord): void {
    const db = this.db, operation = validateCommerceOperation(record);
    const values: { offerId:string|null;itemId:string|null;quantity:number|null;coinCost:number|null;outputKind:string|null;
      petId:string|null;slot:string|null;instanceId:string|null;previousInstanceId:string|null;fromEnhancement:number|null;toEnhancement:number|null } =
      { offerId:null,itemId:null,quantity:null,coinCost:null,outputKind:null,petId:null,slot:null,instanceId:null,previousInstanceId:null,fromEnhancement:null,toEnhancement:null };
    let materials: readonly CommerceMaterialAmount[] = [], instanceIds: readonly string[] = [];
    switch (operation.type) {
      case 'SHOP_PURCHASE':
        Object.assign(values,{offerId:operation.offerId,itemId:operation.itemId,quantity:operation.quantity,coinCost:operation.coinCost,outputKind:operation.outputKind});
        instanceIds = operation.instanceIds; break;
      case 'EQUIPMENT_EQUIP':
        Object.assign(values,{petId:operation.petId,slot:operation.slot,instanceId:operation.instanceId,previousInstanceId:operation.previousInstanceId}); break;
      case 'EQUIPMENT_UNEQUIP':
        Object.assign(values,{petId:operation.petId,slot:operation.slot,instanceId:operation.instanceId}); break;
      case 'EQUIPMENT_UPGRADE':
        Object.assign(values,{instanceId:operation.instanceId,fromEnhancement:operation.fromEnhancement,toEnhancement:operation.toEnhancement,coinCost:operation.coinCost});
        materials = operation.materials; break;
      case 'EQUIPMENT_SALVAGE':
        Object.assign(values,{instanceId:operation.instanceId,fromEnhancement:operation.enhancement}); materials = operation.materials; break;
      case 'ITEM_USE': Object.assign(values,{petId:operation.petId,itemId:operation.itemId}); break;
    }
    db.prepare(`INSERT INTO commerce_operations (command_id,operation_type,occurred_at,catalog_version,offer_id,item_id,quantity,coin_cost,output_kind,
      pet_id,slot,instance_id,previous_instance_id,from_enhancement,to_enhancement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operation.commandId,operation.type,operation.occurredAt,operation.catalogVersion,values.offerId,values.itemId,values.quantity,values.coinCost,
        values.outputKind,values.petId,values.slot,values.instanceId,values.previousInstanceId,values.fromEnhancement,values.toEnhancement);
    for (const material of materials) db.prepare('INSERT INTO commerce_operation_materials VALUES (?, ?, ?)')
      .run(operation.commandId,material.itemId,material.quantity);
    for (const instanceId of instanceIds) db.prepare('INSERT INTO commerce_operation_instances VALUES (?, ?)').run(operation.commandId,instanceId);
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

  private checkedEventCgUnlock(value: unknown): EventCgUnlock {
    const row=object(value,'event CG unlock row'),petId=id(row.pet_id),cgId=id(row.cg_id),variant=id(row.variant),sourceEventId=id(row.source_event_id);
    const unlockedAt=integer(row.unlocked_at,'event CG unlock time'),viewedAt=nullableInteger(row.viewed_at,'event CG first view time');
    const historicalCharacterId=id(row.historical_character_id),historicalEventDefId=id(row.historical_event_def_id);
    const ref=cgAssetRefSchema.parse({state:'PINNED',characterId:historicalCharacterId,eventDefId:historicalEventDefId,assetVersion:row.asset_version,assetHash:row.asset_hash});
    const source=this.getEventOccurrence(sourceEventId),asset=source?.occurrence.asset;
    if(ref.state!=='PINNED'||!source||source.status==='PENDING'||source.resolvedAt!==unlockedAt||source.occurrence.petId!==petId||asset?.state!=='PINNED'
      ||asset.cgId!==cgId||asset.variant!==variant||asset.characterId!==historicalCharacterId||asset.eventDefId!==historicalEventDefId
      ||asset.assetVersion!==ref.assetVersion||asset.assetHash!==ref.assetHash||(viewedAt!==null&&viewedAt<unlockedAt)
      ||!source.rewards.some(r=>r.kind==='CG_UNLOCK'&&r.cgId===cgId&&r.variant===variant&&r.newlyUnlocked)
      ||this.getCgUnlock(petId,cgId,variant)!==null)throw new Error('Event CG contradicts its first-acquisition frozen occurrence');
    return {petId,cgId,variant,sourceEventId,unlockedAt,historicalCharacterId,historicalEventDefId,assetRef:ref,
      favorite:sqlBoolean(row.favorite,'event CG favorite'),viewedAt};
  }

  getEventCgUnlock(petId: string,cgId: string,variant: string): EventCgUnlock | null {
    const row=this.db.prepare('SELECT * FROM event_cg_unlocks WHERE pet_id=? AND cg_id=? AND variant=?').get(id(petId),id(cgId),id(variant));
    return row===undefined||row===null?null:this.checkedEventCgUnlock(row);
  }

  listEventCgUnlocks(petId: string): EventCgUnlock[] {
    return this.db.prepare('SELECT * FROM event_cg_unlocks WHERE pet_id=? ORDER BY cg_id,variant').all(id(petId)).map(row=>this.checkedEventCgUnlock(row));
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
    if (existing !== null || this.getEventCgUnlock(unlock.petId,unlock.cgId,unlock.variant)!==null) return false;
    const assetRef: CgAssetRef = pin?.assetRef ?? { state: 'LEGACY_UNVERSIONED' };
    const [assetVersion, assetHash] = cgVersionHash(assetRef);
    db.prepare(`INSERT INTO cg_unlocks (pet_id,cg_id,variant,source_trip_id,unlocked_at,asset_state,
      historical_character_id,historical_event_def_id,asset_version,asset_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(unlock.petId, unlock.cgId, unlock.variant, unlock.sourceTripId, unlock.unlockedAt, assetRef.state,
        pin?.characterId ?? null, pin?.eventDefId ?? null, assetVersion, assetHash);
    return true;
  }

  setCgFavorite(petId: string, cgId: string, variant: string, favorite: boolean): boolean {
    const tripUnlock=this.getCgUnlock(petId,cgId,variant),unlock=tripUnlock??this.getEventCgUnlock(petId,cgId,variant),next=boolean(favorite,'CG favorite');
    if (unlock === null) throw new Error('CG has not been unlocked');
    if (unlock.favorite === next) return false;
    const result = this.db.prepare(`UPDATE ${tripUnlock===null?'event_cg_unlocks':'cg_unlocks'} SET favorite=? WHERE pet_id=? AND cg_id=? AND variant=?`)
      .run(Number(next), unlock.petId, unlock.cgId, unlock.variant);
    if (integer(result.changes, 'CG favorite change count') !== 1) throw new Error('CG favorite update failed');
    return true;
  }

  markCgViewed(petId: string, cgId: string, variant: string, characterId: string, eventDefId: string,
    assetVersion: string, assetHash: string, viewedAt: number): boolean {
    const tripUnlock=this.getCgUnlock(petId,cgId,variant),unlock=tripUnlock??this.getEventCgUnlock(petId,cgId,variant);
    const expectedRef = cgAssetRefSchema.parse({ state: 'PINNED', characterId, eventDefId, assetVersion, assetHash });
    const timestamp = integer(viewedAt, 'CG first view time');
    if (unlock === null) throw new Error('CG has not been unlocked');
    if (unlock.assetRef.state !== 'PINNED' || !sameJson(unlock.assetRef, expectedRef)) throw new Error('CG view requires its exact pinned asset identity');
    if (timestamp < unlock.unlockedAt) throw new Error('CG first view cannot precede unlock');
    if (unlock.viewedAt !== null) return false;
    const result = this.db.prepare(`UPDATE ${tripUnlock===null?'event_cg_unlocks':'cg_unlocks'} SET viewed_at=? WHERE pet_id=? AND cg_id=? AND variant=? AND viewed_at IS NULL`)
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
      const oldPetCount = migration.version === 3 ? rowCount(db, 'SELECT count(*) AS count FROM pets') : null;
      const oldHomePetCount = migration.version === 4 ? rowCount(db, 'SELECT count(*) AS count FROM pets') : null;
      const oldCommerceCounts = migration.version === 5 ? {
        stacks: rowCount(db, 'SELECT count(*) AS count FROM inventory'),
        rewards: rowCount(db, 'SELECT count(*) AS count FROM reward_ledger'),
        receipts: rowCount(db, 'SELECT count(*) AS count FROM commands'),
      } : null;
      const oldDepartureTripCount = migration.version === 6 ? rowCount(db,'SELECT count(*) AS count FROM trips') : null;
      const oldEventCounts=migration.version===7?Object.fromEntries(['pets','trips','cg_unlocks','commands','reward_ledger'].map(table=>[table,rowCount(db,`SELECT count(*) AS count FROM ${table}`)])):null;
      const oldExtensionCounts=migration.version>=8?Object.fromEntries([
        'pets','trips','cg_unlocks','commands','reward_ledger','event_trigger_receipts','event_occurrences','event_finalizations','event_effects','event_cg_unlocks',
        ...(migration.version>=9?['ai_provider_configs','ai_pet_provider_assignments','ai_conversations','ai_turns','ai_messages','ai_memories','ai_memory_grants']:[]),
        ...(migration.version>=10?['workspace_settings','quick_actions','routines','routine_targets','launch_history','recommendation_preferences','recommendation_impressions']:[]),
      ].map(table=>[table,rowCount(db,`SELECT count(*) AS count FROM ${table}`)])):null;
      db.exec(migration.sql);
      if (oldCounts !== null && (oldCounts.trips !== rowCount(db, 'SELECT count(*) AS count FROM trips')
        || oldCounts.unlocks !== rowCount(db, 'SELECT count(*) AS count FROM cg_unlocks')
        || oldCounts.trips !== rowCount(db, 'SELECT count(*) AS count FROM trips WHERE cg_pin_schema=1')
        || oldCounts.unlocks !== rowCount(db, `SELECT count(*) AS count FROM cg_unlocks WHERE asset_state='LEGACY_UNVERSIONED'
          AND historical_character_id IS NULL AND historical_event_def_id IS NULL AND asset_version IS NULL AND asset_hash IS NULL
          AND favorite=0 AND viewed_at IS NULL`))) throw new Error('CG migration changed legacy row count or invented historical metadata');
      if (oldPetCount !== null && (oldPetCount !== rowCount(db, 'SELECT count(*) AS count FROM pets')
        || rowCount(db, 'SELECT count(*) AS count FROM pet_acquisitions') !== 0)) {
        throw new Error('Pet acquisition migration changed legacy pets or invented acquisition history');
      }
      if (oldHomePetCount !== null && (oldHomePetCount !== rowCount(db, 'SELECT count(*) AS count FROM pets')
        || rowCount(db, 'SELECT count(*) AS count FROM pet_home_schedules') !== 0)) {
        throw new Error('Home schedule migration changed legacy pets or invented simulation clocks');
      }
      if (oldCommerceCounts !== null && (oldCommerceCounts.stacks !== rowCount(db,'SELECT count(*) AS count FROM inventory')
        || oldCommerceCounts.rewards !== rowCount(db,'SELECT count(*) AS count FROM reward_ledger')
        || oldCommerceCounts.receipts !== rowCount(db,'SELECT count(*) AS count FROM commands')
        || ['item_instances','pet_equipment','commerce_operations','commerce_operation_materials','commerce_operation_instances']
          .some(table => rowCount(db,`SELECT count(*) AS count FROM ${table}`) !== 0))) {
        throw new Error('Commerce migration changed old stacks or reward history or invented instances and operations');
      }
      if (oldDepartureTripCount !== null && (oldDepartureTripCount !== rowCount(db,'SELECT count(*) AS count FROM trips')
        || oldDepartureTripCount !== rowCount(db,'SELECT count(*) AS count FROM trips WHERE departure_loadout_trip_id IS NULL')
        || ['trip_departure_loadouts','trip_departure_supplies','trip_departure_equipment']
          .some(table => rowCount(db,`SELECT count(*) AS count FROM ${table}`) !== 0))) {
        throw new Error('Departure migration changed legacy trips or invented frozen loadouts');
      }
      if(oldEventCounts!==null&&(Object.entries(oldEventCounts).some(([table,count])=>rowCount(db,`SELECT count(*) AS count FROM ${table}`)!==count)
        ||['event_trigger_receipts','event_occurrences','event_finalizations','event_effects','event_cg_unlocks'].some(table=>rowCount(db,`SELECT count(*) AS count FROM ${table}`)!==0))){
        throw new Error('Event migration changed legacy history or invented narrative occurrences');
      }
      if(oldExtensionCounts!==null&&Object.entries(oldExtensionCounts).some(([table,count])=>rowCount(db,`SELECT count(*) AS count FROM ${table}`)!==count)){
        throw new Error('AI/workspace/voice migration changed existing authoritative history');
      }
      if(migration.version===8&&['ai_provider_configs','ai_pet_provider_assignments','ai_conversations','ai_turns','ai_messages','ai_turn_sources',
        'ai_turn_memory_refs','ai_proposal_ids','ai_candidate_ids','ai_memory_ids','ai_action_proposals','ai_memory_candidates','ai_candidate_sources',
        'ai_memories','ai_memory_sources','ai_memory_grants'].some(table=>rowCount(db,`SELECT count(*) AS count FROM ${table}`)!==0)){
        throw new Error('AI migration must not invent provider configuration, consent, conversation or memory history');
      }
      if(migration.version===9&&(rowCount(db,'SELECT count(*) AS count FROM workspace_settings WHERE singleton=1 AND revision=0 AND recommendation_enabled=0 AND retention_days=30')!==1
        ||['quick_actions','routines','routine_targets','launch_history','recommendation_preferences','recommendation_impressions']
          .some(table=>rowCount(db,`SELECT count(*) AS count FROM ${table}`)!==0))){
        throw new Error('Workspace migration must begin opt-out with no approved targets or recommendation history');
      }
      if(migration.version===10&&rowCount(db,'SELECT count(*) AS count FROM voice_profiles')!==0){
        throw new Error('Voice migration must not invent voice preferences or consent');
      }
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
