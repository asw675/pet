/** V1 growth rules. They compute projections and departure power only;
 * an existing TripSnapshot keeps the exact power with which it departed. */
export const MAX_LEVEL = 20;
export const MAX_BATTLE_STAT = 1_000_000;
/** Preserve the range accepted by the existing trip-v1 simulator. */
export const MAX_BATTLE_POWER = 1_000;

/** Integer combat attributes; hp is battle HP, not pet healthPoints10. */
export interface BattleStats {
  readonly hp: number;
  readonly atk: number;
  readonly def: number;
  readonly spd: number;
  readonly luk: number;
}

/** Structural profile shared by revisioned character definitions. */
export interface CharacterProgressionProfile {
  readonly basePower: number;
  readonly baseStats: BattleStats;
  readonly growthPerLevel: BattleStats;
}

export interface LevelProgression {
  readonly level: number;
  readonly cumulativeXp: number;
  readonly levelStartXp: number;
  readonly xpInLevel: number;
  readonly xpRequiredForNextLevel: number | null;
  readonly xpRemainingToNextLevel: number | null;
}

export const ZERO_BATTLE_BONUS: BattleStats = Object.freeze({ hp: 0, atk: 0, def: 0, spd: 0, luk: 0 });
const battleStatKeys = ['hp', 'atk', 'def', 'spd', 'luk'] as const;
type StatKey = (typeof battleStatKeys)[number];

function boundedInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function requireLevel(level: number): void { boundedInteger(level, 1, MAX_LEVEL, 'level'); }
function requireXp(xp: number): void { boundedInteger(xp, 0, Number.MAX_SAFE_INTEGER, 'cumulative XP'); }

/** Next-level cost, not cumulative XP. At the cap there is no next level. */
export function xpRequiredForNextLevel(level: number): number | null {
  requireLevel(level);
  return level === MAX_LEVEL ? null : 100 + 35 * (level - 1);
}

/** The cumulative XP threshold for entering a level. */
export function cumulativeXpAtLevel(level: number): number {
  requireLevel(level);
  let total = 0;
  for (let current = 1; current < level; current++) total += 100 + 35 * (current - 1);
  return total;
}

/** Exactly the historic V1 threshold calculation. XP beyond Lv.20 is valid. */
export function levelForXp(cumulativeXp: number): number {
  requireXp(cumulativeXp);
  let remaining = cumulativeXp;
  let level = 1;
  while (level < MAX_LEVEL && remaining >= 100 + 35 * (level - 1)) {
    remaining -= 100 + 35 * (level - 1);
    level += 1;
  }
  return level;
}

export function progressionForXp(cumulativeXp: number): LevelProgression {
  const level = levelForXp(cumulativeXp);
  const levelStartXp = cumulativeXpAtLevel(level);
  const xpInLevel = cumulativeXp - levelStartXp;
  const nextCost = xpRequiredForNextLevel(level);
  return {
    level, cumulativeXp, levelStartXp, xpInLevel,
    xpRequiredForNextLevel: nextCost,
    xpRemainingToNextLevel: nextCost === null ? null : nextCost - xpInLevel,
  };
}

function requireStats(stats: BattleStats, label: string, baseHpPositive: boolean): void {
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)
    || Object.keys(stats).length !== battleStatKeys.length
    || !battleStatKeys.every(key => Object.hasOwn(stats, key))) {
    throw new RangeError(`${label} must contain exactly hp, atk, def, spd, luk`);
  }
  for (const key of battleStatKeys) boundedInteger(stats[key], baseHpPositive && key === 'hp' ? 1 : 0,
    MAX_BATTLE_STAT, `${label}.${key}`);
}

function requireProfile(profile: CharacterProgressionProfile): void {
  if (profile === null || typeof profile !== 'object') throw new RangeError('Missing character progression profile');
  boundedInteger(profile.basePower, 1, MAX_BATTLE_POWER, 'base power');
  requireStats(profile.baseStats, 'base stats', true);
  requireStats(profile.growthPerLevel, 'level growth', false);
}

/** Deterministic integer HP/ATK/DEF/SPD/LUK projection. Does not mutate
 * profile, XP, equipment or gameplay-state health/mood/energy. */
export function computeBattleStats(profile: CharacterProgressionProfile, level: number,
  equipmentBonus: BattleStats = ZERO_BATTLE_BONUS): BattleStats {
  requireProfile(profile);
  requireLevel(level);
  requireStats(equipmentBonus, 'equipment bonus', false);
  const calculate = (key: StatKey): number => {
    const stat = profile.baseStats[key] + (level - 1) * profile.growthPerLevel[key] + equipmentBonus[key];
    boundedInteger(stat, key === 'hp' ? 1 : 0, MAX_BATTLE_STAT, `computed ${key}`);
    return stat;
  };
  return { hp: calculate('hp'), atk: calculate('atk'), def: calculate('def'), spd: calculate('spd'), luk: calculate('luk') };
}

/** V1 candidate translation into the frozen single-power simulator input:
 * basePower + 2*(Lv-1) + floor(ΔHP/10) + 2*ΔATK + ΔDEF + floor(ΔSPD/2) + floor(ΔLUK/2).
 * Here Δ is the non-negative difference from Lv.1/no-equipment stats.
 * Thus an original Lv.1 Star/Fluffy with no gear keeps power 30/25. Apply
 * this only when NEW trips depart, never to an already persisted snapshot. */
export function computeBattlePower(profile: CharacterProgressionProfile, level: number,
  equipmentBonus: BattleStats = ZERO_BATTLE_BONUS): number {
  const stats = computeBattleStats(profile, level, equipmentBonus);
  const delta = (key: StatKey) => stats[key] - profile.baseStats[key];
  const power = profile.basePower + 2 * (level - 1)
    + Math.floor(delta('hp') / 10) + 2 * delta('atk') + delta('def')
    + Math.floor(delta('spd') / 2) + Math.floor(delta('luk') / 2);
  return Math.min(MAX_BATTLE_POWER, power);
}

export type BondStage = 0 | 1 | 2 | 3;
/** Stored fixed-point score (0..1000) maps to thresholds 20/50/80. */
export function bondStageForScore10(bond10: number): BondStage {
  boundedInteger(bond10, 0, 1_000, 'bond score in tenths');
  return bond10 >= 800 ? 3 : bond10 >= 500 ? 2 : bond10 >= 200 ? 1 : 0;
}
