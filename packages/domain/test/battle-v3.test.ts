import { describe, expect, it } from 'vitest';
import { findBattleEnemyV2, simulateBattleV2 } from '../src/battle-v2.js';
import { BATTLE_BOSS_V3, battleSkillForProfession, simulateBattleV3 } from '../src/battle-v3.js';
import { advanceTrip, createRoundTripSnapshot, createSkilledTripSnapshot, createTripCheckpoint, recallTrip } from '../src/index.js';
import { STARFALL_RUINS_ROUTE } from '../src/route-catalog.js';

const boss = findBattleEnemyV2('ruins-core-guardian')!;
const stats = { hp: 250, atk: 60, def: 30, spd: 55, luk: 21 };
const start = 100_000;
const departure = { tripId: 'boss-trip', petId: 'star', startAt: start, seed: 8, power: 100, route: STARFALL_RUINS_ROUTE, petStats: stats };

describe('versioned class skills and ruins guardian', () => {
  it.each([['MAGE', 'STARFLARE'], ['RANGER', 'KEEN_SHOT'], ['MECHANICAL_SUPPORT', 'MECHANICAL_GUARD']] as const)(
    'runs the %s skill and guardian frenzy in seeded rounds without extra random draws', (profession, skill) => {
      expect(battleSkillForProfession(profession)).toBe(skill);
      const input = { petStats: stats, petHp: stats.hp, enemy: boss, rngState: 8, petSkill: skill, boss: BATTLE_BOSS_V3 } as const;
      const first = simulateBattleV3(input);
      expect(simulateBattleV3(input)).toEqual(first);
      const actions = first.report.rounds.flatMap(round => round.actions);
      expect(actions.flatMap(action => action.skills)).toEqual(expect.arrayContaining([skill, 'GUARDIAN_FRENZY']));
      expect(actions[1]!.skills).not.toContain('GUARDIAN_FRENZY');
      expect(first.drawCount).toBe(first.report.rounds.length * 6);
      expect(first.report).toMatchObject({ rulesVersion: 'battle-v3', boss: BATTLE_BOSS_V3, outcome: 'WIN' });
    },
  );

  it('changes actual damage and critical results on the same frozen rolls', () => {
    for (const [petSkill, rngState, round, index, oldDamage, newDamage] of [
      ['STARFLARE', 1, 2, 0, 37, 51], ['KEEN_SHOT', 5, 0, 0, 36, 54], ['MECHANICAL_GUARD', 2, 0, 1, 27, 17],
    ] as const) {
      const input = { petStats: stats, petHp: stats.hp, enemy: boss, rngState };
      const prior = simulateBattleV2(input).report.rounds[round]!.actions[index]!;
      const current = simulateBattleV3({ ...input, petSkill, boss: null }).report.rounds[round]!.actions[index]!;
      expect([prior.damage, current.damage]).toEqual([oldDamage, newDamage]);
      if (petSkill === 'KEEN_SHOT') expect([prior.critical, current.critical]).toEqual([false, true]);
    }
  });

  it('pins profession and Boss identity in V3 without changing V2 and keeps pre-encounter recall ordinary', () => {
    const old = createRoundTripSnapshot(departure);
    const fresh = createSkilledTripSnapshot({ ...departure, profession: 'MAGE' });
    expect(fresh.battle).toMatchObject({ petSkill: 'STARFLARE', bossNodeId: 'ruins-core-guardian' });
    expect(fresh.contentHash).not.toBe(old.contentHash);
    expect(() => createTripCheckpoint({ ...fresh, battle: { ...fresh.battle, petSkill: 'KEEN_SHOT' } })).toThrow(/frozen version/);
    expect(() => createTripCheckpoint({ ...fresh, battle: { ...fresh.battle, bossNodeId: null } })).toThrow(/Boss node/);
    const checkpoint = createTripCheckpoint(fresh);
    const recalled = recallTrip(fresh, checkpoint, start + 40 * 60_000);
    expect(recalled.checkpoint.returnReason).toBe('RECALLED');
    expect(recalled.facts.map(fact => fact.type)).toEqual(['GATHER_RESOLVED', 'RETURNING']);
    const previous = advanceTrip(old, createTripCheckpoint(old), old.expectedReturnAt);
    const historicalBattle = previous.facts.find(fact => fact.type === 'BATTLE_RESOLVED')!;
    expect(historicalBattle.payload).toMatchObject({ battle: { rulesVersion: 'battle-v2' } });
    expect(historicalBattle.payload).not.toHaveProperty('battle.petSkill');
  });
});
