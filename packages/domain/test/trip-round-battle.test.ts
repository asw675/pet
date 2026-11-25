import { describe, expect, it } from 'vitest';
import { BATTLE_DRAWS_PER_ROUND_V2 } from '../src/battle-v2.js';
import { advanceTrip, createRoundTripSnapshot, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE, recallTrip } from '../src/index.js';
import type { TripFact, TripSnapshotV2 } from '../src/index.js';
import { findRouteDefinition } from '../src/route-catalog.js';

const MINUTE = 60_000;
const START = 1_000;
const petStats = { hp: 200, atk: 48, def: 0, spd: 30, luk: 0 };
const departure = { tripId: 'round-trip', petId: 'pet-a', startAt: START, seed: 1_234, power: 30 };
const battleFacts = (facts: readonly TripFact[]) => facts.flatMap(fact =>
  fact.type === 'BATTLE_RESOLVED' && 'battle' in fact.payload ? [fact.payload.battle] : []);

describe('integrated round battle trips', () => {
  it('preserves exact battle and drop results across segmented advances and a JSON checkpoint restart', () => {
    const snapshot = createRoundTripSnapshot({ ...departure, route: findRouteDefinition('mist-forest')!, petStats });
    const beginning = createTripCheckpoint(snapshot);
    const offline = advanceTrip(snapshot, beginning, snapshot.expectedReturnAt + 72 * 60 * MINUTE);
    const firstEncounter = advanceTrip(snapshot, beginning, START + 18 * MINUTE);
    const resumed = advanceTrip(JSON.parse(JSON.stringify(snapshot)), JSON.parse(JSON.stringify(firstEncounter.checkpoint)), snapshot.expectedReturnAt);
    expect(firstEncounter.checkpoint.battleHp).toBeLessThan(petStats.hp);
    expect(offline.status).toBe('SETTLED');
    expect(offline.checkpoint.returnReason).toBe('COMPLETED');
    expect([...firstEncounter.facts, ...resumed.facts]).toEqual(offline.facts);
    expect(resumed.checkpoint).toEqual(offline.checkpoint);
    const battles = battleFacts(offline.facts);
    expect(battles).toHaveLength(2);
    expect(battles[1]!.petStartHp).toBe(battles[0]!.petEndHp);
    expect(battles[1]!.petStartHp).toBe(firstEncounter.checkpoint.battleHp);
    expect(offline.checkpoint.drawCount).toBe(3 + battles.reduce((sum, battle) => sum + battle.rounds.length * BATTLE_DRAWS_PER_ROUND_V2 + 1, 0));
  });

  it('retreats on defeat without future loot and preserves ordinary recall timing', () => {
    const snapshot = createRoundTripSnapshot({ ...departure, route: DEMO_ROUTE, petStats: { hp: 1, atk: 1, def: 0, spd: 0, luk: 0 } });
    const initial = createTripCheckpoint(snapshot);
    const defeated = advanceTrip(snapshot, initial, snapshot.expectedReturnAt);
    expect(defeated.checkpoint).toMatchObject({ returnReason: 'DEFEATED', battleHp: 0, nodeIndex: 2 });
    expect(defeated.rewardDraft).toMatchObject({ xp: 9, coins: 0, cgIds: [] });
    expect(battleFacts(defeated.facts)[0]).toMatchObject({ outcome: 'LOSS', termination: 'PET_KO' });
    expect(defeated.facts.map(fact => fact.type)).toEqual(['GATHER_RESOLVED', 'BATTLE_RESOLVED', 'RETURNING', 'TRIP_RETURNED']);
    const recalled = recallTrip(snapshot, initial, START + 4 * MINUTE);
    expect(recalled.checkpoint).toMatchObject({ returnReason: 'RECALLED', battleHp: 1, nodeIndex: 1, drawCount: 1 });
    expect(battleFacts(recalled.facts)).toEqual([]);
  });

  it('rejects changed combat statistics, enemies, RNG state or persisted HP while keeping the legacy shape', () => {
    const snapshot = createRoundTripSnapshot({ ...departure, route: DEMO_ROUTE, petStats });
    const checkpoint = createTripCheckpoint(snapshot);
    const altered: TripSnapshotV2 = { ...snapshot, battle: { ...snapshot.battle, petStats: { ...petStats, atk: 49 } } };
    expect(() => createTripCheckpoint(altered)).toThrow(/frozen version/);
    const encounter = snapshot.battle.encounters[0]!;
    expect(() => createTripCheckpoint({ ...snapshot, battle: { ...snapshot.battle, encounters: [{ ...encounter,
      enemy: { ...encounter.enemy, stats: { ...encounter.enemy.stats, hp: 99 } } }] } })).toThrow(/frozen version/);
    expect(() => advanceTrip(snapshot, { ...checkpoint, battleHp: 1 }, START)).toThrow(/battle cursor/);
    expect(() => advanceTrip(snapshot, { ...checkpoint, rngState: 3 }, START)).toThrow(/battle cursor/);
    const legacy = createTripSnapshot({ ...departure, route: DEMO_ROUTE });
    const legacyCheckpoint = createTripCheckpoint(legacy);
    expect(legacy.rulesVersion).toBe('trip-v1');
    expect(legacy).not.toHaveProperty('battle');
    expect(legacyCheckpoint).not.toHaveProperty('battleHp');
    expect(advanceTrip(legacy, legacyCheckpoint, legacy.expectedReturnAt).facts[1]).toMatchObject({
      type: 'BATTLE_RESOLVED', payload: { winChanceBps: 6_800 },
    });
  });
});
