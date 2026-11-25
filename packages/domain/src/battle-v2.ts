import { drawRandomInt } from '#trip-core';
import { MAX_BATTLE_STAT } from '#progression';
import type { BattleStats } from '#progression';

/** Gameplay version only. This module is not linked into trip-v1. */
export const BATTLE_RULES_VERSION = 'battle-v2' as const;
export const BATTLE_ENEMY_CATALOG_VERSION = 1 as const;
export const MAX_BATTLE_ROUNDS_V2 = 20;
export const BATTLE_DRAWS_PER_ROUND_V2 = 6;
const BPS = 10_000, UINT32_MAX = 0xffff_ffff;
const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'luk'] as const;

export interface BattleEnemyV2 {
  readonly enemyId: string;
  readonly definitionVersion: number;
  readonly displayName: string;
  readonly stats: BattleStats;
}
export type BattleSideV2 = 'PET' | 'ENEMY';
export type BattleTerminationV2 = 'ENEMY_KO' | 'PET_KO' | 'ROUND_LIMIT';
export interface BattleActionV2 {
  readonly actor: BattleSideV2;
  readonly hit: boolean;
  readonly critical: boolean;
  readonly damage: number;
  readonly targetHpBefore: number;
  readonly targetHpAfter: number;
}
export interface BattleRoundV2 {
  readonly round: number;
  readonly first: BattleSideV2;
  /** First attack, then at most one counterattack. A defeated actor does not attack. */
  readonly actions: readonly BattleActionV2[];
  readonly petHp: number;
  readonly enemyHp: number;
}
export interface BattleReportV2 {
  readonly rulesVersion: typeof BATTLE_RULES_VERSION;
  readonly petStats: BattleStats;
  readonly petStartHp: number;
  readonly petEndHp: number;
  readonly enemy: BattleEnemyV2;
  readonly enemyEndHp: number;
  readonly outcome: 'WIN' | 'LOSS';
  readonly termination: BattleTerminationV2;
  readonly rounds: readonly BattleRoundV2[];
}
export interface SimulateBattleV2Input {
  readonly petStats: BattleStats;
  /** This is the travel checkpoint's battle HP, not home health/energy. */
  readonly petHp: number;
  readonly enemy: BattleEnemyV2;
  readonly rngState: number;
}
export interface BattleSimulationV2 {
  readonly report: BattleReportV2;
  readonly rngState: number;
  /** Six per executed round, including an unused second attack after KO. */
  readonly drawCount: number;
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${label}: expected integer ${min}..${max}`);
}
function closed(value: object, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new RangeError(`Invalid ${label} shape`);
}
export function freezeBattleStatsV2(stats: BattleStats): BattleStats {
  closed(stats, STAT_KEYS, 'battle stats');
  for (const key of STAT_KEYS) integer(stats[key], key === 'hp' ? 1 : 0, MAX_BATTLE_STAT, `battle ${key}`);
  return Object.freeze({ hp: stats.hp, atk: stats.atk, def: stats.def, spd: stats.spd, luk: stats.luk });
}
export function freezeBattleEnemyV2(enemy: BattleEnemyV2): BattleEnemyV2 {
  closed(enemy, ['enemyId', 'definitionVersion', 'displayName', 'stats'], 'battle enemy');
  if (typeof enemy.enemyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(enemy.enemyId)
    || typeof enemy.displayName !== 'string' || !enemy.displayName.trim() || enemy.displayName.length > 64
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(enemy.displayName)) throw new RangeError('Invalid battle enemy identity');
  integer(enemy.definitionVersion, 1, Number.MAX_SAFE_INTEGER, 'enemy definition version');
  return Object.freeze({ enemyId: enemy.enemyId, definitionVersion: enemy.definitionVersion, displayName: enemy.displayName,
    stats: freezeBattleStatsV2(enemy.stats) });
}

function enemy(enemyId: string, displayName: string, hp: number, atk: number, def: number, spd: number, luk: number): BattleEnemyV2 {
  return freezeBattleEnemyV2({ enemyId, definitionVersion: 1, displayName, stats: { hp, atk, def, spd, luk } });
}
/** Explicit new encounter content for the six real nodes in the existing
 * regions. These are game balance numbers, NOT inferred from old enemyPower.
 * The catalog is consulted only at a new V2 departure; replay uses frozen
 * enemy stats even when the current catalog later changes. */
export const BATTLE_ENEMIES_V2: readonly BattleEnemyV2[] = Object.freeze([
  enemy('slime', '晨露史莱姆', 34, 9, 5, 7, 4),
  enemy('forest-slime', '森林史莱姆', 62, 19, 11, 15, 9),
  enemy('forest-wisp', '迷雾精灵', 78, 25, 14, 24, 18),
  enemy('ruins-sentinel', '遗迹哨兵', 110, 39, 28, 28, 15),
  enemy('ruins-watch', '内殿守卫', 135, 45, 30, 40, 25),
  enemy('ruins-core-guardian', '遗迹核心守护者', 160, 48, 34, 34, 30),
]);
export function findBattleEnemyV2(enemyId: string, definitionVersion: number = 1): BattleEnemyV2 | undefined {
  return BATTLE_ENEMIES_V2.find(value => value.enemyId === enemyId && value.definitionVersion === definitionVersion);
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
/** Integer hit/crit probabilities. SPD both determines initiative and makes
 * faster characters harder to dodge. LUK increases critical chance and
 * modestly resists opposing critical hits. Bounds prevent invulnerability. */
export function battleHitChanceV2(attacker: BattleStats, defender: BattleStats): number {
  return clamp(9_000 + (attacker.spd - defender.spd) * 70, 7_000, 9_800);
}
export function battleCriticalChanceV2(attacker: BattleStats, defender: BattleStats): number {
  return clamp(500 + attacker.luk * 40 - defender.luk * 10, 500, 3_000);
}
interface AttackDraws { readonly hitRoll: number; readonly critRoll: number; readonly varianceBps: number }
function attack(actor: BattleSideV2, attacker: BattleStats, defender: BattleStats, targetHp: number, rolls: AttackDraws): BattleActionV2 {
  const hit = rolls.hitRoll < battleHitChanceV2(attacker, defender);
  const critical = hit && rolls.critRoll < battleCriticalChanceV2(attacker, defender);
  const base = Math.max(1, attacker.atk - Math.floor(defender.def * 6_000 / BPS));
  const varied = Math.max(1, Math.floor(base * rolls.varianceBps / BPS));
  const damage = hit ? Math.min(targetHp, critical ? Math.floor(varied * 15_000 / BPS) : varied) : 0;
  return Object.freeze({ actor, hit, critical, damage, targetHpBefore: targetHp, targetHpAfter: targetHp - damage });
}

/** Pure bounded multi-round game simulation. No clock, Math.random, live
 * character/catalog lookup, real-world actions, reward settlement or I/O.
 * RNG schedule is versioned: always PET hit/crit/variance then ENEMY
 * hit/crit/variance, independent of initiative and unused rolls after KO. */
export function simulateBattleV2(raw: SimulateBattleV2Input): BattleSimulationV2 {
  closed(raw, ['petStats', 'petHp', 'enemy', 'rngState'], 'battle input');
  const petStats = freezeBattleStatsV2(raw.petStats), enemyStats = freezeBattleEnemyV2(raw.enemy);
  integer(raw.petHp, 1, petStats.hp, 'starting pet HP');
  integer(raw.rngState, 1, UINT32_MAX, 'battle RNG state');
  let petHp = raw.petHp, enemyHp = enemyStats.stats.hp, rngState = raw.rngState, drawCount = 0;
  const rounds: BattleRoundV2[] = [];
  const first: BattleSideV2 = petStats.spd >= enemyStats.stats.spd ? 'PET' : 'ENEMY'; // stable PET tie-breaking
  function draw(bound: number): number {
    const next = drawRandomInt(rngState, bound); rngState = next.state; drawCount++; return next.value;
  }
  function attackDraws(): AttackDraws {
    return { hitRoll: draw(BPS), critRoll: draw(BPS), varianceBps: 9_000 + draw(2_001) };
  }
  for (let round = 1; round <= MAX_BATTLE_ROUNDS_V2 && petHp > 0 && enemyHp > 0; round++) {
    const petRolls = attackDraws(), enemyRolls = attackDraws();
    const actions: BattleActionV2[] = [];
    for (const actor of [first, first === 'PET' ? 'ENEMY' : 'PET'] as const) {
      if (petHp === 0 || enemyHp === 0) break;
      if (actor === 'PET') {
        const action = attack(actor, petStats, enemyStats.stats, enemyHp, petRolls);
        enemyHp = action.targetHpAfter; actions.push(action);
      } else {
        const action = attack(actor, enemyStats.stats, petStats, petHp, enemyRolls);
        petHp = action.targetHpAfter; actions.push(action);
      }
    }
    rounds.push(Object.freeze({ round, first, actions: Object.freeze(actions), petHp, enemyHp }));
  }
  const termination: BattleTerminationV2 = enemyHp === 0 ? 'ENEMY_KO' : petHp === 0 ? 'PET_KO' : 'ROUND_LIMIT';
  // If neither combatant wins within the strict cap the encounter is a loss
  // and the trip retreats; stalling never yields a victory/drop.
  const report: BattleReportV2 = Object.freeze({ rulesVersion: BATTLE_RULES_VERSION, petStats, petStartHp: raw.petHp,
    petEndHp: petHp, enemy: enemyStats, enemyEndHp: enemyHp, outcome: termination === 'ENEMY_KO' ? 'WIN' : 'LOSS',
    termination, rounds: Object.freeze(rounds) });
  return Object.freeze({ report, rngState, drawCount });
}
