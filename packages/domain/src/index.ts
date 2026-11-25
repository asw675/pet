import { BATTLE_DRAWS_PER_ROUND_V2, MAX_BATTLE_ROUNDS_V2, findBattleEnemyV2, freezeBattleEnemyV2,
  freezeBattleStatsV2, simulateBattleV2 } from '#battle-v2';
import type { BattleEnemyV2, BattleReportV2 } from '#battle-v2';
import { BATTLE_BOSS_V3, BATTLE_SKILLS_V3, battleSkillForProfession, simulateBattleV3 } from '#battle-v3';
import type { BattleReportV3, BattleSkillV3 } from '#battle-v3';
import type { CharacterProfession } from './character-catalog.js';
import type { BattleStats } from '#progression';
import { drawRandomInt, nextRandomUint32 } from '#trip-random';

export { drawRandomInt, nextRandomUint32 } from '#trip-random';

export type TripStatus = 'TRAVELING' | 'SETTLED';
export type TripPresence = 'AWAY' | 'RETURNING' | 'HOME';
export type TripPhase = 'OUTBOUND' | 'RETURNING' | 'COMPLETE';
export type ReturnReason = 'COMPLETED' | 'RECALLED' | 'DEFEATED';

interface RouteNodeBase {
  readonly nodeId: string;
  /** Time from the previous scheduled event to this node. */
  readonly durationMs: number;
}

export interface GatherNode extends RouteNodeBase {
  readonly kind: 'GATHER';
  readonly itemId: string;
  readonly minQuantity: number;
  readonly maxQuantity: number;
  readonly xp: number;
}

export interface BattleNode extends RouteNodeBase {
  readonly kind: 'BATTLE';
  readonly enemyId: string;
  readonly enemyPower: number;
  readonly winXp: number;
  readonly winCoins: number;
  readonly lossXp: number;
  readonly drop: {
    readonly itemId: string;
    readonly quantity: number;
    readonly chanceBps: number;
  } | null;
}

export interface EventNode extends RouteNodeBase {
  readonly kind: 'EVENT';
  readonly eventDefId: string;
  readonly cgId: string;
  readonly chanceBps: number;
}

export type RouteNode = GatherNode | BattleNode | EventNode;

export interface RouteDefinition {
  readonly routeId: string;
  readonly contentVersion: number;
  readonly nodes: readonly RouteNode[];
  readonly returnDurationMs: number;
}

export interface CreateTripSnapshotInput {
  readonly tripId: string;
  readonly petId: string;
  readonly startAt: number;
  readonly seed: number;
  readonly power: number;
  readonly route: RouteDefinition;
}

interface TripSnapshotBase extends RouteDefinition {
  readonly tripId: string;
  readonly petId: string;
  readonly startAt: number;
  readonly expectedReturnAt: number;
  readonly seed: number;
  readonly power: number;
  readonly contentHash: string;
}

export interface TripSnapshotV1 extends TripSnapshotBase {
  readonly rulesVersion: typeof TRIP_RULES_VERSION;
}

interface FrozenTripBattles {
  readonly petStats: BattleStats;
  readonly encounters: readonly { readonly nodeId: string; readonly enemy: BattleEnemyV2 }[];
}

export interface TripSnapshotV2 extends TripSnapshotBase {
  readonly rulesVersion: typeof TRIP_ROUND_RULES_VERSION;
  readonly battle: FrozenTripBattles;
}

export interface TripSnapshotV3 extends TripSnapshotBase {
  readonly rulesVersion: typeof TRIP_SKILL_RULES_VERSION;
  readonly battle: FrozenTripBattles & { readonly petSkill: BattleSkillV3; readonly bossNodeId: string | null };
}

type RoundTripSnapshot = TripSnapshotV2 | TripSnapshotV3;

/** JSON-only departure inputs with no live equipment, enemy or route references. */
export type TripSnapshot = TripSnapshotV1 | RoundTripSnapshot;

export interface ItemReward {
  readonly itemId: string;
  readonly quantity: number;
}

/** Cumulative reward candidates; only the application service may commit them. */
export interface RewardDraft {
  readonly xp: number;
  readonly coins: number;
  readonly items: readonly ItemReward[];
  readonly cgIds: readonly string[];
}

export interface TripCheckpoint {
  readonly tripId: string;
  readonly phase: TripPhase;
  /** Count of nodes already resolved (including a lost battle). */
  readonly nodeIndex: number;
  readonly rngState: number;
  readonly drawCount: number;
  readonly sequence: number;
  readonly logicalTime: number;
  readonly nextDueAt: number | null;
  readonly returnReason: ReturnReason | null;
  readonly actualReturnedAt: number | null;
  readonly rewardDraft: RewardDraft;
  /** V2 only. Travel battle HP persists between encounters and is separate from home health. */
  readonly battleHp?: number;
}

interface TripFactBase {
  readonly eventId: string;
  readonly tripId: string;
  readonly petId: string;
  readonly sequence: number;
  readonly scheduledAt: number;
}

type TripFactDetails = (
  | {
    readonly type: 'GATHER_RESOLVED';
    readonly payload: {
      readonly nodeId: string;
      readonly itemId: string;
      readonly quantity: number;
      readonly xp: number;
    };
  }
  | {
    readonly type: 'BATTLE_RESOLVED';
    readonly payload: {
      readonly nodeId: string;
      readonly enemyId: string;
      readonly outcome: 'WIN' | 'LOSS';
      readonly xp: number;
      readonly coins: number;
      readonly drop: ItemReward | null;
    } & ({ readonly winChanceBps: number } | { readonly battle: BattleReportV2 | BattleReportV3 });
  }
  | {
    readonly type: 'EVENT_RESOLVED';
    readonly payload: {
      readonly nodeId: string;
      readonly eventDefId: string;
      readonly cgId: string | null;
    };
  }
  | {
    readonly type: 'RETURNING';
    readonly payload: {
      readonly reason: ReturnReason;
      readonly dueAt: number;
    };
  }
  | {
    readonly type: 'TRIP_RETURNED';
    readonly payload: {
      readonly reason: ReturnReason;
      readonly actualReturnedAt: number;
    };
  }
);

export type TripFact = TripFactBase & TripFactDetails;

export interface TripAdvanceResult {
  /** SETTLED/HOME is the domain's candidate terminal state, not a database commit. */
  readonly status: TripStatus;
  readonly presence: TripPresence;
  readonly checkpoint: TripCheckpoint;
  /** Facts newly produced by this call only. Persist atomically with the checkpoint. */
  readonly facts: readonly TripFact[];
  /** Cumulative, not a delta; eligible for settlement only at COMPLETE. */
  readonly rewardDraft: RewardDraft;
}

const UINT32_MAX = 0xffff_ffff;

export const TRIP_RULES_VERSION = 'trip-v1';
export const TRIP_ROUND_RULES_VERSION = 'trip-v2';
export const TRIP_SKILL_RULES_VERSION = 'trip-v3';
export const TRIP_ROUND_DEFEAT_HEALTH_COST10 = 100;
export const MAX_TRIP_NODES = 12;
/** Both versions emit one fact per node plus entering return and arriving home. */
export const MAX_TRIP_FACTS = MAX_TRIP_NODES + 2;
export const MAX_TRIP_DRAWS = MAX_TRIP_NODES * (MAX_BATTLE_ROUNDS_V2 * BATTLE_DRAWS_PER_ROUND_V2 + 1);
const MAX_TRIP_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_POWER = 1_000;
const MAX_REWARD = 1_000_000;
const BASIS_POINTS = 10_000;
const MINUTE_MS = 60_000;

function assertInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
}

function assertId(value: string, label: string, maxLength = 128): void {
  // Matches the contract's stable ASCII identifier policy, without depending on it.
  if (typeof value !== 'string' || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new RangeError(`${label} must be a stable ASCII identifier of at most ${maxLength} characters`);
  }
}

/** Validate the bounded V1 route and calculate its nominal total travel duration. */
export function getTripDurationMs(route: RouteDefinition): number {
  assertId(route.routeId, 'routeId');
  assertInteger(route.contentVersion, 1, Number.MAX_SAFE_INTEGER, 'contentVersion');
  assertInteger(route.returnDurationMs, 1, MAX_TRIP_DURATION_MS, 'returnDurationMs');
  if (!Array.isArray(route.nodes) || route.nodes.length < 2 || route.nodes.length > MAX_TRIP_NODES) {
    throw new RangeError(`A V1 route must contain between 2 and ${MAX_TRIP_NODES} nodes`);
  }
  const nodeIds = new Set<string>();
  let duration = route.returnDurationMs;
  for (const node of route.nodes as readonly RouteNode[]) {
    assertId(node.nodeId, 'nodeId');
    if (nodeIds.has(node.nodeId)) throw new RangeError('Node IDs must be unique');
    nodeIds.add(node.nodeId);
    assertInteger(node.durationMs, 1, MAX_TRIP_DURATION_MS, 'durationMs');
    duration += node.durationMs;
    switch (node.kind) {
      case 'GATHER':
        assertId(node.itemId, 'itemId');
        assertInteger(node.minQuantity, 1, MAX_REWARD, 'minQuantity');
        assertInteger(node.maxQuantity, node.minQuantity, MAX_REWARD, 'maxQuantity');
        assertInteger(node.xp, 0, MAX_REWARD, 'xp');
        break;
      case 'BATTLE':
        assertId(node.enemyId, 'enemyId');
        assertInteger(node.enemyPower, 1, MAX_POWER, 'enemyPower');
        assertInteger(node.winXp, 0, MAX_REWARD, 'winXp');
        assertInteger(node.winCoins, 0, MAX_REWARD, 'winCoins');
        assertInteger(node.lossXp, 0, node.winXp, 'lossXp');
        if (node.drop !== null) {
          assertId(node.drop.itemId, 'drop.itemId');
          assertInteger(node.drop.quantity, 1, MAX_REWARD, 'drop.quantity');
          assertInteger(node.drop.chanceBps, 0, BASIS_POINTS, 'drop.chanceBps');
        }
        break;
      case 'EVENT':
        assertId(node.eventDefId, 'eventDefId');
        assertId(node.cgId, 'cgId');
        assertInteger(node.chanceBps, 0, BASIS_POINTS, 'chanceBps');
        break;
      default:
        throw new RangeError('Unknown V1 route node kind');
    }
  }
  assertInteger(duration, 1, MAX_TRIP_DURATION_MS, 'total route duration');
  return duration;
}

function copyNode(node: RouteNode): RouteNode {
  const base = { nodeId: node.nodeId, durationMs: node.durationMs };
  switch (node.kind) {
    case 'GATHER':
      return Object.freeze({ ...base, kind: node.kind, itemId: node.itemId,
        minQuantity: node.minQuantity, maxQuantity: node.maxQuantity, xp: node.xp });
    case 'BATTLE':
      return Object.freeze({ ...base, kind: node.kind, enemyId: node.enemyId,
        enemyPower: node.enemyPower, winXp: node.winXp, winCoins: node.winCoins,
        lossXp: node.lossXp, drop: node.drop === null ? null : Object.freeze({
          itemId: node.drop.itemId, quantity: node.drop.quantity, chanceBps: node.drop.chanceBps,
        }) });
    case 'EVENT':
      return Object.freeze({ ...base, kind: node.kind, eventDefId: node.eventDefId,
        cgId: node.cgId, chanceBps: node.chanceBps });
  }
}

/** A non-cryptographic content fingerprint of an explicit, versioned field order. */
function routeContentHash(route: RouteDefinition): string {
  return fingerprint([route.routeId, route.contentVersion, route.returnDurationMs,
    route.nodes.map((node) => {
      const base = [node.kind, node.nodeId, node.durationMs];
      switch (node.kind) {
        case 'GATHER':
          return [...base, node.itemId, node.minQuantity, node.maxQuantity, node.xp];
        case 'BATTLE':
          return [...base, node.enemyId, node.enemyPower, node.winXp, node.winCoins, node.lossXp,
            node.drop === null ? null : [node.drop.itemId, node.drop.quantity, node.drop.chanceBps]];
        case 'EVENT':
          return [...base, node.eventDefId, node.cgId, node.chanceBps];
      }
    })]);
}

function fingerprint(value: unknown): string {
  const data = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index++) {
    hash = Math.imul(hash ^ data.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

/** Copy and freeze every V1 input at departure; the caller supplies time, ID and seed. */
export function createTripSnapshot(input: CreateTripSnapshotInput): TripSnapshotV1 {
  assertId(input.tripId, 'tripId', 125); // reserve ":14" for stable fact event IDs
  assertId(input.petId, 'petId');
  assertInteger(input.seed, 1, UINT32_MAX, 'seed');
  assertInteger(input.power, 1, MAX_POWER, 'power');
  const duration = getTripDurationMs(input.route);
  assertInteger(input.startAt, 0, Number.MAX_SAFE_INTEGER - duration, 'startAt');
  const route = {
    routeId: input.route.routeId,
    contentVersion: input.route.contentVersion,
    returnDurationMs: input.route.returnDurationMs,
    nodes: Object.freeze(input.route.nodes.map(copyNode)),
  };
  return Object.freeze({
    ...route,
    tripId: input.tripId,
    petId: input.petId,
    startAt: input.startAt,
    expectedReturnAt: input.startAt + duration,
    power: input.power,
    seed: input.seed,
    rulesVersion: TRIP_RULES_VERSION,
    contentHash: routeContentHash(route),
  });
}

function roundTripContentHash(snapshot: RouteDefinition, battle: FrozenTripBattles): string {
  const stats = (value: BattleStats) => [value.hp, value.atk, value.def, value.spd, value.luk];
  return fingerprint([TRIP_ROUND_RULES_VERSION, routeContentHash(snapshot), stats(battle.petStats),
    battle.encounters.map(({ nodeId, enemy }) => [nodeId, enemy.enemyId, enemy.definitionVersion, enemy.displayName, stats(enemy.stats)])]);
}

/** Freeze the equipped pet stats and the exact authored enemy for each battle node. */
export function createRoundTripSnapshot(input: CreateTripSnapshotInput & { readonly petStats: BattleStats }): TripSnapshotV2 {
  const base = createTripSnapshot(input);
  const battle = Object.freeze({ petStats: freezeBattleStatsV2(input.petStats),
    encounters: Object.freeze(base.nodes.filter(node => node.kind === 'BATTLE').map(node => {
      const enemy = findBattleEnemyV2(node.enemyId);
      if (!enemy) throw new RangeError(`No round battle enemy is defined for ${node.enemyId}`);
      return Object.freeze({ nodeId: node.nodeId, enemy });
    })) });
  return Object.freeze({ ...base, rulesVersion: TRIP_ROUND_RULES_VERSION, battle, contentHash: roundTripContentHash(base, battle) });
}

function ruinsBossNode(snapshot: RouteDefinition): string | null {
  if (snapshot.routeId !== 'starfall-ruins') return null;
  return snapshot.nodes.find(node => node.kind === 'BATTLE' && node.nodeId === 'ruins-core-guardian'
    && node.enemyId === 'ruins-core-guardian')?.nodeId ?? null;
}

function skillTripContentHash(route: RouteDefinition, battle: TripSnapshotV3['battle']): string {
  return fingerprint([TRIP_SKILL_RULES_VERSION, roundTripContentHash(route, battle), battle.petSkill, battle.bossNodeId]);
}

export function createSkilledTripSnapshot(input: CreateTripSnapshotInput & { readonly petStats: BattleStats;
  readonly profession: CharacterProfession }): TripSnapshotV3 {
  const base = createRoundTripSnapshot(input);
  const petSkill = battleSkillForProfession(input.profession);
  if (!BATTLE_SKILLS_V3.includes(petSkill)) throw new RangeError('Unknown battle profession');
  const battle = Object.freeze({ ...base.battle, petSkill, bossNodeId: ruinsBossNode(base) });
  return Object.freeze({ ...base, rulesVersion: TRIP_SKILL_RULES_VERSION, battle, contentHash: skillTripContentHash(base, battle) });
}

function validateFrozenBattles(snapshot: RoundTripSnapshot): void {
  const { battle } = snapshot;
  const skilled = snapshot.rulesVersion === TRIP_SKILL_RULES_VERSION;
  if (!battle || typeof battle !== 'object' || Object.keys(battle).length !== (skilled ? 4 : 2) || !Array.isArray(battle.encounters)) {
    throw new RangeError('Invalid round battle snapshot shape');
  }
  if (skilled && (!BATTLE_SKILLS_V3.includes(snapshot.battle.petSkill) || snapshot.battle.bossNodeId !== ruinsBossNode(snapshot))) {
    throw new RangeError('Invalid frozen profession skill or Boss node');
  }
  freezeBattleStatsV2(battle.petStats);
  const nodes = snapshot.nodes.filter(node => node.kind === 'BATTLE');
  if (battle.encounters.length !== nodes.length) throw new RangeError('Snapshot must freeze every battle encounter');
  for (const [index, node] of nodes.entries()) {
    const encounter = battle.encounters[index];
    if (!encounter || typeof encounter !== 'object' || Object.keys(encounter).length !== 2 || encounter.nodeId !== node.nodeId
      || freezeBattleEnemyV2(encounter.enemy).enemyId !== node.enemyId) {
      throw new RangeError('Frozen enemy does not match its route node');
    }
  }
}

function validateSnapshot(snapshot: TripSnapshot): void {
  if (snapshot.rulesVersion !== TRIP_RULES_VERSION && snapshot.rulesVersion !== TRIP_ROUND_RULES_VERSION
    && snapshot.rulesVersion !== TRIP_SKILL_RULES_VERSION) {
    throw new RangeError('Unsupported trip rules version; do not re-simulate with newer rules');
  }
  assertId(snapshot.tripId, 'tripId', 125);
  assertId(snapshot.petId, 'petId');
  assertInteger(snapshot.seed, 1, UINT32_MAX, 'seed');
  assertInteger(snapshot.power, 1, MAX_POWER, 'power');
  const duration = getTripDurationMs(snapshot);
  assertInteger(snapshot.startAt, 0, Number.MAX_SAFE_INTEGER - duration, 'startAt');
  let contentHash: string;
  if (snapshot.rulesVersion === TRIP_RULES_VERSION) contentHash = routeContentHash(snapshot);
  else {
    validateFrozenBattles(snapshot);
    contentHash = snapshot.rulesVersion === TRIP_SKILL_RULES_VERSION ? skillTripContentHash(snapshot, snapshot.battle)
      : roundTripContentHash(snapshot, snapshot.battle);
  }
  if (snapshot.expectedReturnAt !== snapshot.startAt + duration || snapshot.contentHash !== contentHash) {
    throw new RangeError('Trip snapshot content or timing does not match its frozen version');
  }
}

const EMPTY_REWARDS: RewardDraft = Object.freeze({
  xp: 0,
  coins: 0,
  items: Object.freeze([]),
  cgIds: Object.freeze([]),
});

/** Produce the initial checkpoint at departure (no random draws or game rewards yet). */
export function createTripCheckpoint(snapshot: TripSnapshot): TripCheckpoint {
  validateSnapshot(snapshot);
  return Object.freeze({
    tripId: snapshot.tripId,
    phase: 'OUTBOUND',
    nodeIndex: 0,
    rngState: snapshot.seed,
    drawCount: 0,
    sequence: 0,
    logicalTime: snapshot.startAt,
    nextDueAt: snapshot.startAt + snapshot.nodes[0]!.durationMs,
    returnReason: null,
    actualReturnedAt: null,
    rewardDraft: EMPTY_REWARDS,
    ...(snapshot.rulesVersion !== TRIP_RULES_VERSION ? { battleHp: snapshot.battle.petStats.hp } : {}),
  });
}

function resolveRoundEncounter(snapshot: RoundTripSnapshot, node: BattleNode, petHp: number, rngState: number) {
  const encounter = snapshot.battle.encounters.find(candidate => candidate.nodeId === node.nodeId);
  if (!encounter) throw new RangeError('Missing frozen battle encounter');
  const input = { petStats: snapshot.battle.petStats, petHp, enemy: encounter.enemy, rngState };
  const battle = snapshot.rulesVersion === TRIP_SKILL_RULES_VERSION ? simulateBattleV3({ ...input,
    petSkill: snapshot.battle.petSkill, boss: snapshot.battle.bossNodeId === node.nodeId ? BATTLE_BOSS_V3 : null }) : simulateBattleV2(input);
  // Reserve a drop draw for every resolved encounter, including losses.
  const drop = drawRandomInt(battle.rngState, BASIS_POINTS);
  return { ...battle, rngState: drop.state, drawCount: battle.drawCount + 1, dropRoll: drop.value };
}

/** Rebuild only the bounded RNG/HP cursor from frozen inputs. This never writes facts or rewards. */
function validateRoundCursor(snapshot: RoundTripSnapshot, checkpoint: TripCheckpoint): void {
  let rngState = snapshot.seed, drawCount = 0, petHp = snapshot.battle.petStats.hp;
  let defeated = false;
  for (const node of snapshot.nodes.slice(0, checkpoint.nodeIndex)) {
    if (defeated) throw new RangeError('Checkpoint cannot resolve nodes after a defeat');
    if (node.kind === 'BATTLE') {
      const battle = resolveRoundEncounter(snapshot, node, petHp, rngState);
      rngState = battle.rngState;
      drawCount += battle.drawCount;
      petHp = battle.report.petEndHp;
      defeated = battle.report.outcome === 'LOSS';
    } else {
      rngState = nextRandomUint32(rngState);
      drawCount++;
    }
  }
  if (checkpoint.rngState !== rngState || checkpoint.drawCount !== drawCount || checkpoint.battleHp !== petHp
    || defeated !== (checkpoint.returnReason === 'DEFEATED')) {
    throw new RangeError('Checkpoint contradicts the frozen round battle cursor');
  }
}

function validateCheckpoint(snapshot: TripSnapshot, checkpoint: TripCheckpoint): void {
  if (checkpoint.tripId !== snapshot.tripId) throw new RangeError('Checkpoint belongs to another trip');
  assertInteger(checkpoint.nodeIndex, 0, snapshot.nodes.length, 'nodeIndex');
  assertInteger(checkpoint.rngState, 1, UINT32_MAX, 'rngState');
  assertInteger(checkpoint.logicalTime, snapshot.startAt, snapshot.expectedReturnAt, 'logicalTime');
  let draws = 0;
  let lastNodeAt = snapshot.startAt;
  for (const node of snapshot.nodes.slice(0, checkpoint.nodeIndex)) {
    draws += node.kind === 'BATTLE' ? 2 : 1;
    lastNodeAt += node.durationMs;
  }
  if (checkpoint.logicalTime < lastNodeAt) throw new RangeError('Checkpoint logical time contradicts its resolved nodes');
  if (snapshot.rulesVersion !== TRIP_RULES_VERSION) {
    validateRoundCursor(snapshot, checkpoint);
  } else {
    if (Object.hasOwn(checkpoint, 'battleHp') || checkpoint.drawCount !== draws) {
      throw new RangeError('Checkpoint draw count contradicts its resolved nodes');
    }
    let expectedState = snapshot.seed;
    for (let i = 0; i < draws; i++) expectedState = nextRandomUint32(expectedState);
    if (checkpoint.rngState !== expectedState) throw new RangeError('Checkpoint random state contradicts its seed and draw count');
  }
  validateRewards(checkpoint.rewardDraft, checkpoint.nodeIndex);
  const nextNode = snapshot.nodes[checkpoint.nodeIndex];
  if (checkpoint.phase === 'OUTBOUND') {
    if (nextNode === undefined || checkpoint.nextDueAt !== lastNodeAt + nextNode.durationMs
      || checkpoint.nextDueAt <= checkpoint.logicalTime || checkpoint.returnReason !== null
      || checkpoint.actualReturnedAt !== null || checkpoint.sequence !== checkpoint.nodeIndex) {
      throw new RangeError('Invalid outbound checkpoint');
    }
    return;
  }
  if (checkpoint.returnReason !== 'COMPLETED' && checkpoint.returnReason !== 'RECALLED'
    && checkpoint.returnReason !== 'DEFEATED') {
    throw new RangeError('Returning/completed checkpoints require a return reason');
  }
  if ((checkpoint.returnReason === 'COMPLETED' && nextNode !== undefined)
    || (checkpoint.returnReason === 'RECALLED' && nextNode === undefined)
    || (checkpoint.returnReason === 'DEFEATED' && snapshot.nodes[checkpoint.nodeIndex - 1]?.kind !== 'BATTLE')) {
    throw new RangeError('Return reason contradicts completed nodes');
  }
  if (checkpoint.phase === 'RETURNING') {
    if (checkpoint.nextDueAt === null || checkpoint.nextDueAt <= checkpoint.logicalTime
      || checkpoint.actualReturnedAt !== null || checkpoint.sequence !== checkpoint.nodeIndex + 1) {
      throw new RangeError('Invalid returning checkpoint');
    }
    assertInteger(checkpoint.nextDueAt, lastNodeAt + snapshot.returnDurationMs,
      snapshot.expectedReturnAt, 'nextDueAt');
  } else if (checkpoint.phase === 'COMPLETE') {
    if (checkpoint.nextDueAt !== null || checkpoint.actualReturnedAt !== checkpoint.logicalTime
      || checkpoint.sequence !== checkpoint.nodeIndex + 2) {
      throw new RangeError('Invalid completed checkpoint');
    }
    assertInteger(checkpoint.logicalTime, lastNodeAt + snapshot.returnDurationMs,
      snapshot.expectedReturnAt, 'actualReturnedAt');
  } else {
    throw new RangeError('Unknown checkpoint phase');
  }
  const returnAt = (checkpoint.nextDueAt ?? checkpoint.actualReturnedAt!) - snapshot.returnDurationMs;
  if (checkpoint.logicalTime < returnAt) throw new RangeError('Logical time cannot precede departure for return');
  if (checkpoint.returnReason === 'RECALLED') {
    // A recall at the exact next node time would first resolve that node.
    if (returnAt >= lastNodeAt + nextNode!.durationMs) {
      throw new RangeError('Recall cannot skip a due node');
    }
  } else if (returnAt !== lastNodeAt) {
    throw new RangeError('Normal or defeated return must begin at its last node');
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateRewards(draft: RewardDraft, nodeCount: number): void {
  const max = nodeCount * MAX_REWARD;
  assertInteger(draft.xp, 0, max, 'rewardDraft.xp');
  assertInteger(draft.coins, 0, max, 'rewardDraft.coins');
  if (!Array.isArray(draft.items) || draft.items.length > nodeCount
    || !Array.isArray(draft.cgIds) || draft.cgIds.length > nodeCount) {
    throw new RangeError('Reward list exceeds resolved nodes');
  }
  let previous = '';
  for (const item of draft.items as readonly ItemReward[]) {
    assertId(item.itemId, 'rewardDraft.itemId');
    assertInteger(item.quantity, 1, max, 'rewardDraft.quantity');
    if (compareIds(item.itemId, previous) <= 0) throw new RangeError('Reward items must be sorted and unique');
    previous = item.itemId;
  }
  previous = '';
  for (const cgId of draft.cgIds as readonly string[]) {
    assertId(cgId, 'rewardDraft.cgId');
    if (compareIds(cgId, previous) <= 0) throw new RangeError('Reward CGs must be sorted and unique');
    previous = cgId;
  }
}

function addRewards(draft: RewardDraft, xp: number, coins: number,
  item: ItemReward | null = null, cgId: string | null = null): RewardDraft {
  const items = draft.items.map((entry) => ({ ...entry }));
  if (item !== null) {
    const existing = items.findIndex((entry) => entry.itemId === item.itemId);
    if (existing < 0) items.push({ ...item });
    else items[existing] = { itemId: item.itemId, quantity: items[existing]!.quantity + item.quantity };
  }
  items.sort((a, b) => compareIds(a.itemId, b.itemId));
  const cgIds = [...draft.cgIds];
  if (cgId !== null && !cgIds.includes(cgId)) cgIds.push(cgId);
  cgIds.sort(compareIds);
  return Object.freeze({
    xp: draft.xp + xp,
    coins: draft.coins + coins,
    items: Object.freeze(items.map((entry) => Object.freeze(entry))),
    cgIds: Object.freeze(cgIds),
  });
}

function advance(snapshot: TripSnapshot, checkpoint: TripCheckpoint, targetTime: number,
  recall: boolean): TripAdvanceResult {
  validateSnapshot(snapshot);
  validateCheckpoint(snapshot, checkpoint);
  assertInteger(targetTime, 0, Number.MAX_SAFE_INTEGER, 'targetTime');

  const effectiveTime = Math.max(checkpoint.logicalTime, targetTime);
  let progress = checkpoint;
  const facts: TripFact[] = [];

  function append(scheduledAt: number, detail: TripFactDetails): void {
    const sequence = progress.sequence + 1;
    Object.freeze(detail.payload);
    facts.push(Object.freeze({
      ...detail,
      eventId: `${snapshot.tripId}:${sequence}`,
      tripId: snapshot.tripId,
      petId: snapshot.petId,
      sequence,
      scheduledAt,
    }));
    progress = { ...progress, sequence };
  }

  function draw(maxExclusive: number): number {
    const random = drawRandomInt(progress.rngState, maxExclusive);
    progress = { ...progress, rngState: random.state, drawCount: progress.drawCount + 1 };
    return random.value;
  }

  function enterReturn(at: number, reason: ReturnReason): void {
    const dueAt = at + snapshot.returnDurationMs;
    progress = { ...progress, phase: 'RETURNING', returnReason: reason, nextDueAt: dueAt };
    append(at, { type: 'RETURNING', payload: { reason, dueAt } });
  }

  // At most 12 nodes plus return/arrival. No per-second or wall-clock-dependent loops.
  while (progress.nextDueAt !== null && progress.nextDueAt <= effectiveTime) {
    const at = progress.nextDueAt;
    if (progress.phase === 'RETURNING') {
      append(at, { type: 'TRIP_RETURNED', payload: {
        reason: progress.returnReason!, actualReturnedAt: at,
      } });
      progress = { ...progress, phase: 'COMPLETE', actualReturnedAt: at,
        logicalTime: at, nextDueAt: null };
      break;
    }

    const node = snapshot.nodes[progress.nodeIndex]!;
    let defeated = false;
    switch (node.kind) {
      case 'GATHER': {
        const quantity = node.minQuantity + draw(node.maxQuantity - node.minQuantity + 1);
        progress = { ...progress, rewardDraft: addRewards(progress.rewardDraft, node.xp,
          0, { itemId: node.itemId, quantity }) };
        append(at, { type: 'GATHER_RESOLVED', payload: {
          nodeId: node.nodeId, itemId: node.itemId, quantity, xp: node.xp,
        } });
        break;
      }
      case 'BATTLE': {
        let won: boolean, dropRoll: number, detail: { winChanceBps: number } | { battle: BattleReportV2 | BattleReportV3 };
        if (snapshot.rulesVersion !== TRIP_RULES_VERSION) {
          const battle = resolveRoundEncounter(snapshot, node, progress.battleHp!, progress.rngState);
          progress = { ...progress, battleHp: battle.report.petEndHp, rngState: battle.rngState,
            drawCount: progress.drawCount + battle.drawCount };
          won = battle.report.outcome === 'WIN';
          dropRoll = battle.dropRoll;
          detail = { battle: battle.report };
        } else {
          // V1 always consumes two draws (including the possible drop on a loss).
          const winChanceBps = Math.min(9_500, Math.max(500, 5_000 + (snapshot.power - node.enemyPower) * 100));
          won = draw(BASIS_POINTS) < winChanceBps;
          dropRoll = draw(BASIS_POINTS);
          detail = { winChanceBps };
        }
        const drop = won && node.drop !== null && dropRoll < node.drop.chanceBps
          ? Object.freeze({ itemId: node.drop.itemId, quantity: node.drop.quantity }) : null;
        const xp = won ? node.winXp : node.lossXp;
        const coins = won ? node.winCoins : 0;
        progress = { ...progress, rewardDraft: addRewards(progress.rewardDraft, xp, coins, drop) };
        append(at, { type: 'BATTLE_RESOLVED', payload: {
          nodeId: node.nodeId, enemyId: node.enemyId, outcome: won ? 'WIN' : 'LOSS',
          ...detail, xp, coins, drop,
        } });
        defeated = !won;
        break;
      }
      case 'EVENT': {
        const cgId = draw(BASIS_POINTS) < node.chanceBps ? node.cgId : null;
        progress = { ...progress, rewardDraft: addRewards(progress.rewardDraft, 0, 0, null, cgId) };
        append(at, { type: 'EVENT_RESOLVED', payload: { nodeId: node.nodeId, eventDefId: node.eventDefId, cgId } });
        break;
      }
    }
    progress = { ...progress, nodeIndex: progress.nodeIndex + 1 };
    const nextNode = snapshot.nodes[progress.nodeIndex];
    if (defeated) enterReturn(at, 'DEFEATED');
    else if (nextNode === undefined) enterReturn(at, 'COMPLETED');
    else progress = { ...progress, nextDueAt: at + nextNode.durationMs };
  }

  // At an identical logical time all scheduled events precede a user recall.
  if (recall && progress.phase === 'OUTBOUND') enterReturn(effectiveTime, 'RECALLED');
  if (progress.phase !== 'COMPLETE' && progress.logicalTime !== effectiveTime) {
    progress = { ...progress, logicalTime: effectiveTime };
  }
  const complete = progress.phase === 'COMPLETE';
  return Object.freeze({
    status: complete ? 'SETTLED' : 'TRAVELING',
    presence: complete ? 'HOME' : progress.phase === 'RETURNING' ? 'RETURNING' : 'AWAY',
    checkpoint: progress === checkpoint ? checkpoint : Object.freeze(progress),
    facts: Object.freeze(facts),
    rewardDraft: progress.rewardDraft,
  });
}

/** Resolve only scheduled events at or before target UTC epoch milliseconds. */
export function advanceTrip(snapshot: TripSnapshot, checkpoint: TripCheckpoint, targetTime: number): TripAdvanceResult {
  return advance(snapshot, checkpoint, targetTime, false);
}

/** Advance due nodes first, then return early; unresolved nodes cannot award rewards. */
export function recallTrip(snapshot: TripSnapshot, checkpoint: TripCheckpoint, targetTime: number): TripAdvanceResult {
  return advance(snapshot, checkpoint, targetTime, true);
}

/** 15 minute demo route; values are POC fixtures rather than a finalized economy. */
export const DEMO_ROUTE: RouteDefinition = Object.freeze({
  routeId: 'morning-dew-meadow',
  contentVersion: 1,
  returnDurationMs: 3 * MINUTE_MS,
  nodes: Object.freeze([
    Object.freeze({ kind: 'GATHER', nodeId: 'meadow-herbs', durationMs: 3 * MINUTE_MS,
      itemId: 'herb', minQuantity: 1, maxQuantity: 3, xp: 4 }),
    Object.freeze({ kind: 'BATTLE', nodeId: 'meadow-slime', durationMs: 5 * MINUTE_MS,
      enemyId: 'slime', enemyPower: 12, winXp: 20, winCoins: 8, lossXp: 5,
      drop: Object.freeze({ itemId: 'slime-gel', quantity: 1, chanceBps: 2_000 }) }),
    Object.freeze({ kind: 'EVENT', nodeId: 'dewdrop-view', durationMs: 4 * MINUTE_MS,
      eventDefId: 'dew-postcard', cgId: 'morning-dew', chanceBps: 6_500 }),
  ]),
});
