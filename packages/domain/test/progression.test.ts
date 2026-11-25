import { describe, expect, it } from 'vitest';
import {
  MAX_BATTLE_POWER, MAX_BATTLE_STAT, MAX_LEVEL, ZERO_BATTLE_BONUS,
  bondStageForScore10, computeBattlePower, computeBattleStats, cumulativeXpAtLevel,
  levelForXp, progressionForXp, xpRequiredForNextLevel,
} from '../src/progression.js';
import type { BattleStats, CharacterProgressionProfile } from '../src/progression.js';
import { advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE } from '../src/index.js';

const star = Object.freeze({
  basePower: 30,
  baseStats: Object.freeze({ hp: 75, atk: 22, def: 12, spd: 14, luk: 16 }),
  growthPerLevel: Object.freeze({ hp: 8, atk: 4, def: 2, spd: 2, luk: 2 }),
});
const fluffy = Object.freeze({
  basePower: 25,
  baseStats: Object.freeze({ hp: 84, atk: 18, def: 14, spd: 22, luk: 20 }),
  growthPerLevel: Object.freeze({ hp: 9, atk: 3, def: 2, spd: 4, luk: 3 }),
});

describe('historic cumulative XP and growth thresholds', () => {
  it.each([[0, 1], [99, 1], [100, 2], [234, 2], [235, 3], [404, 3], [405, 4], [7884, 19], [7885, 20],
    [7886, 20], [Number.MAX_SAFE_INTEGER, 20]])('retains the V1 XP→level golden %d → %d', (xp, level) => {
    expect(levelForXp(xp)).toBe(level);
  });

  it('matches each of the nineteen historic step thresholds exactly', () => {
    let total = 0;
    for (let level = 1; level < MAX_LEVEL; level++) {
      const cost = 100 + 35 * (level - 1);
      expect(xpRequiredForNextLevel(level)).toBe(cost);
      expect(cumulativeXpAtLevel(level)).toBe(total);
      expect(levelForXp(total)).toBe(level);
      expect(levelForXp(total + cost - 1)).toBe(level);
      total += cost;
      expect(levelForXp(total)).toBe(level + 1);
    }
    expect(total).toBe(7885);
    expect(cumulativeXpAtLevel(MAX_LEVEL)).toBe(total);
    expect(xpRequiredForNextLevel(MAX_LEVEL)).toBeNull();
  });

  it('shows exact remaining XP without truncating stored XP beyond the cap', () => {
    expect(progressionForXp(0)).toEqual({ level: 1, cumulativeXp: 0, levelStartXp: 0,
      xpInLevel: 0, xpRequiredForNextLevel: 100, xpRemainingToNextLevel: 100 });
    expect(progressionForXp(101)).toEqual({ level: 2, cumulativeXp: 101, levelStartXp: 100,
      xpInLevel: 1, xpRequiredForNextLevel: 135, xpRemainingToNextLevel: 134 });
    const max = progressionForXp(Number.MAX_SAFE_INTEGER);
    expect(max).toEqual({ level: 20, cumulativeXp: Number.MAX_SAFE_INTEGER, levelStartXp: 7885,
      xpInLevel: Number.MAX_SAFE_INTEGER - 7885, xpRequiredForNextLevel: null, xpRemainingToNextLevel: null });
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cumulative XP %s', (xp) => {
    expect(() => levelForXp(xp)).toThrow(RangeError);
    expect(() => progressionForXp(xp)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, 21, NaN, Infinity])('rejects unsupported levels %s rather than silently wrapping', (level) => {
    expect(() => xpRequiredForNextLevel(level)).toThrow(RangeError);
    expect(() => cumulativeXpAtLevel(level)).toThrow(RangeError);
    expect(() => computeBattleStats(star, level)).toThrow(RangeError);
  });
});

describe('integer battle stats and compatibility with trip-v1', () => {
  it('keeps the original Lv.1 profiles and powers before adding equipment', () => {
    expect(computeBattleStats(star, 1)).toEqual(star.baseStats);
    expect(computeBattleStats(star, 1)).not.toBe(star.baseStats);
    expect(computeBattleStats(fluffy, 1)).toEqual(fluffy.baseStats);
    expect(computeBattlePower(star, 1)).toBe(30);
    expect(computeBattlePower(fluffy, 1, ZERO_BATTLE_BONUS)).toBe(25);
  });

  it('computes base + integer growth × (Lv-1) + equipment, with camp health unrelated', () => {
    const bonus = Object.freeze({ hp: 10, atk: 2, def: 1, spd: 0, luk: 0 });
    expect(computeBattleStats(star, 2, bonus)).toEqual({ hp: 93, atk: 28, def: 15, spd: 16, luk: 18 });
    expect(computeBattleStats(fluffy, 4, bonus)).toEqual({ hp: 121, atk: 29, def: 21, spd: 34, luk: 29 });
    expect(computeBattleStats(star, 20).hp).toBe(227);
    expect(star.baseStats.hp).toBe(75);
  });

  it('computes the explicit single-power translation at new departures', () => {
    const bonus = { hp: 10, atk: 2, def: 1, spd: 0, luk: 0 };
    // Lv.2 Star: explicit level increments + stat deltas (18, 6, 3, 2, 2).
    expect(computeBattlePower(star, 2, bonus)).toBe(30 + 2 + 1 + 12 + 3 + 1 + 1);
    expect(computeBattlePower(star, 2)).toBe(44);
    expect(computeBattlePower(fluffy, 2)).toBe(38);
    for (const profile of [star, fluffy]) {
      for (let level = 1; level < MAX_LEVEL; level++) {
        expect(computeBattlePower(profile, level + 1)).toBeGreaterThan(computeBattlePower(profile, level));
      }
    }
  });

  it('caps the translated power at the frozen simulator limit without capping XP or camp health', () => {
    const strong = { hp: 0, atk: 100_000, def: 0, spd: 0, luk: 0 };
    expect(computeBattleStats(star, 20, strong).atk).toBe(100_098);
    expect(computeBattlePower(star, 20, strong)).toBe(MAX_BATTLE_POWER);
  });

  it('never invalidates or re-evaluates a previously frozen trip-v1 snapshot', () => {
    const frozen = createTripSnapshot({ tripId: 'trip-historical', petId: 'pet-1', startAt: 1000,
      seed: 8, power: 30, route: DEMO_ROUTE });
    const original = JSON.stringify(frozen);
    const before = advanceTrip(frozen, createTripCheckpoint(frozen), frozen.expectedReturnAt);
    const newPower = computeBattlePower(star, 10, { hp: 20, atk: 30, def: 8, spd: 6, luk: 5 });
    expect(newPower).toBeGreaterThan(30);
    const after = advanceTrip(frozen, createTripCheckpoint(frozen), frozen.expectedReturnAt);
    expect(JSON.stringify(frozen)).toBe(original);
    expect(frozen.power).toBe(30);
    expect(after).toEqual(before);
  });

  it.each([0, -1, 1001, 0.25, Infinity, NaN])('rejects invalid legacy base power %s', (basePower) => {
    expect(() => computeBattlePower({ ...star, basePower }, 2)).toThrow(RangeError);
  });

  it('rejects malformed stat shapes, non-integer, negative, or derived out-of-range stats', () => {
    for (const bonus of [
      { ...ZERO_BATTLE_BONUS, atk: -1 }, { ...ZERO_BATTLE_BONUS, def: 1.5 },
      { ...ZERO_BATTLE_BONUS, hp: MAX_BATTLE_STAT }, { ...ZERO_BATTLE_BONUS, healthPoints10: 1000 },
      { hp: 1, atk: 1 }, { ...ZERO_BATTLE_BONUS, spd: NaN },
    ]) expect(() => computeBattleStats(star, 1, bonus as BattleStats)).toThrow(RangeError);
    expect(() => computeBattleStats({ ...star, baseStats: { ...star.baseStats, hp: 0 } }, 1)).toThrow(RangeError);
    expect(() => computeBattleStats({ ...star, growthPerLevel: { ...star.growthPerLevel, atk: MAX_BATTLE_STAT } }, 2)).toThrow(RangeError);
    expect(() => computeBattleStats({ ...star, growthPerLevel: null } as unknown as CharacterProgressionProfile, 2)).toThrow(RangeError);
  });
});

describe('fixed-point bond milestones', () => {
  it.each([[0, 0], [199, 0], [200, 1], [499, 1], [500, 2], [799, 2], [800, 3], [1000, 3]])('maps %d to stage %d', (score10, stage) => {
    expect(bondStageForScore10(score10)).toBe(stage);
  });
  it.each([-1, 1001, 199.9, Infinity, NaN])('rejects invalid score %s instead of normalizing wrong units', (score10) => {
    expect(() => bondStageForScore10(score10)).toThrow(RangeError);
  });
});
