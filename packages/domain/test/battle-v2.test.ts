import { describe, expect, it } from 'vitest';
import { nextRandomUint32 } from '../src/index.js';
import {
  BATTLE_DRAWS_PER_ROUND_V2, BATTLE_ENEMIES_V2, MAX_BATTLE_ROUNDS_V2, findBattleEnemyV2, simulateBattleV2,
} from '../src/battle-v2.js';
import { ROUTE_CATALOG } from '../src/route-catalog.js';

const balanced = { hp: 100, atk: 20, def: 20, spd: 20, luk: 20 };
const slug = { enemyId: 'fixture-slug', displayName: '测试目标', definitionVersion: 1, stats: balanced };

describe('versioned battle rules', () => {
  it('replays the same frozen battle and consumes a fixed number of draws per round', () => {
    const input = { petStats: balanced, enemy: slug, petHp: 90, rngState: 118 };
    const battle = simulateBattleV2(input);
    expect(simulateBattleV2({ ...input, petStats: { ...balanced }, enemy: { ...slug, stats: { ...balanced } } })).toEqual(battle);
    expect(battle.drawCount).toBe(battle.report.rounds.length * BATTLE_DRAWS_PER_ROUND_V2);
    let state = input.rngState;
    for (let index = 0; index < battle.drawCount; index++) state = nextRandomUint32(state);
    expect(battle.rngState).toBe(state);
    expect(battle.report.rounds[0]?.first).toBe('PET');
    expect(Object.isFrozen(battle.report.rounds[0]?.actions)).toBe(true);
  });

  it('skips a defeated actor’s counterattack while consuming the fixed draw budget', () => {
    const result = simulateBattleV2({ petStats: { ...balanced, atk: 200, spd: 200 }, petHp: 100,
      enemy: { ...slug, stats: { ...balanced, hp: 1, spd: 0 } }, rngState: 1 });
    expect(result.report).toMatchObject({ outcome: 'WIN', termination: 'ENEMY_KO', enemyEndHp: 0 });
    expect(result.report.rounds[0]?.actions).toEqual([
      { actor: 'PET', hit: true, critical: expect.any(Boolean), damage: 1, targetHpBefore: 1, targetHpAfter: 0 },
    ]);
    expect(result.drawCount).toBe(BATTLE_DRAWS_PER_ROUND_V2);
  });

  it('caps sustained battles and treats running out of rounds as a loss', () => {
    const resilient = { hp: 1000, atk: 1, def: 100, spd: 10, luk: 0 };
    const battle = simulateBattleV2({ petStats: resilient, enemy: { ...slug, stats: resilient }, petHp: 1000, rngState: 2 });
    expect(battle.report).toMatchObject({ termination: 'ROUND_LIMIT', outcome: 'LOSS' });
    expect(battle.report.rounds).toHaveLength(MAX_BATTLE_ROUNDS_V2);
    expect(battle.report.petEndHp).toBeGreaterThan(0);
    expect(battle.report.enemyEndHp).toBeGreaterThan(0);
  });

  it('covers each authored encounter and rejects unsupported versions or malformed battle inputs', () => {
    const authored = ROUTE_CATALOG.flatMap(entry => entry.route.nodes.flatMap(node => node.kind === 'BATTLE' ? [node.enemyId] : [])).sort();
    expect(BATTLE_ENEMIES_V2.map(enemy => enemy.enemyId).sort()).toEqual(authored);
    expect(findBattleEnemyV2(authored[0]!, 2)).toBeUndefined();
    expect(() => simulateBattleV2({ petStats: balanced, enemy: slug, petHp: 101, rngState: 1 })).toThrow(/starting pet HP/);
    expect(() => simulateBattleV2({ petStats: balanced, enemy: slug, petHp: 100, rngState: 0 })).toThrow(/RNG state/);
  });
});
