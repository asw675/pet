import { BATTLE_DRAWS_PER_ROUND_V2, MAX_BATTLE_ROUNDS_V2, battleCriticalChanceV2, battleHitChanceV2,
  freezeBattleEnemyV2, freezeBattleStatsV2 } from '#battle-v2';
import type { BattleActionV2, BattleReportV2, BattleSideV2, SimulateBattleV2Input } from '#battle-v2';
import type { CharacterProfession } from './character-catalog.js';
import type { BattleStats } from '#progression';
import { drawRandomInt } from '#trip-random';

export const SKILLED_BATTLE_RULES_VERSION = 'battle-v3';
export const BATTLE_BOSS_V3 = 'RUINS_GUARDIAN';
export const BATTLE_SKILLS_V3 = ['STARFLARE', 'KEEN_SHOT', 'MECHANICAL_GUARD'] as const;
export type BattleSkillV3 = typeof BATTLE_SKILLS_V3[number];
export type BattleActionSkillV3 = BattleSkillV3 | 'GUARDIAN_FRENZY';
export type BattleBossV3 = typeof BATTLE_BOSS_V3;
const BPS = 10_000;
const skillByProfession = {
  MAGE: 'STARFLARE', RANGER: 'KEEN_SHOT', MECHANICAL_SUPPORT: 'MECHANICAL_GUARD',
} as const satisfies Record<CharacterProfession, BattleSkillV3>;

export function battleSkillForProfession(profession: CharacterProfession): BattleSkillV3 {
  return skillByProfession[profession];
}

export interface BattleActionV3 extends BattleActionV2 {
  readonly skills: readonly BattleActionSkillV3[];
}

export interface BattleRoundV3 {
  readonly round: number;
  readonly first: BattleSideV2;
  readonly actions: readonly BattleActionV3[];
  readonly petHp: number;
  readonly enemyHp: number;
}

export interface BattleReportV3 extends Omit<BattleReportV2, 'rulesVersion' | 'rounds'> {
  readonly rulesVersion: typeof SKILLED_BATTLE_RULES_VERSION;
  readonly petSkill: BattleSkillV3;
  readonly boss: BattleBossV3 | null;
  readonly rounds: readonly BattleRoundV3[];
}

interface AttackRolls { readonly hit: number; readonly critical: number; readonly variance: number }

/** Six draws per executed round as in the previous system. Skill triggering
 * depends on frozen rules, round and health, never on additional randomness. */
export function simulateBattleV3(raw: SimulateBattleV2Input & { petSkill: BattleSkillV3; boss: BattleBossV3 | null }): {
  readonly report: BattleReportV3; readonly rngState: number; readonly drawCount: number;
} {
  const petStats = freezeBattleStatsV2(raw.petStats), enemy = freezeBattleEnemyV2(raw.enemy);
  const { petSkill, boss } = raw;
  if (!BATTLE_SKILLS_V3.includes(petSkill) || (boss !== null && (boss !== BATTLE_BOSS_V3 || enemy.enemyId !== 'ruins-core-guardian'))
    || !Number.isInteger(raw.petHp) || raw.petHp < 1 || raw.petHp > petStats.hp
    || !Number.isInteger(raw.rngState) || raw.rngState < 1 || raw.rngState > 0xffff_ffff) {
    throw new RangeError('Invalid skill battle input');
  }
  let petHp = raw.petHp, enemyHp = enemy.stats.hp, rngState = raw.rngState;
  const rounds: BattleRoundV3[] = [];
  const first: BattleSideV2 = petStats.spd >= enemy.stats.spd ? 'PET' : 'ENEMY';
  const second: BattleSideV2 = first === 'PET' ? 'ENEMY' : 'PET';

  function draw(maxExclusive: number): number {
    const next = drawRandomInt(rngState, maxExclusive);
    rngState = next.state;
    return next.value;
  }
  function roll(): AttackRolls {
    return { hit: draw(BPS), critical: draw(BPS), variance: 9_000 + draw(2_001) };
  }
  function attack(actor: BattleSideV2, round: number, rolls: AttackRolls): BattleActionV3 {
    const petAttack = actor === 'PET';
    const attacker: BattleStats = petAttack ? petStats : enemy.stats;
    const defender: BattleStats = petAttack ? enemy.stats : petStats;
    const targetHp = petAttack ? enemyHp : petHp;
    const starflare = petAttack && petSkill === 'STARFLARE' && round % 3 === 0;
    const keen = petAttack && petSkill === 'KEEN_SHOT' && round === 1;
    const guard = !petAttack && petSkill === 'MECHANICAL_GUARD' && (round - 1) % 3 === 0;
    const frenzy = !petAttack && boss === BATTLE_BOSS_V3 && enemyHp * 2 <= enemy.stats.hp;
    const skills: BattleActionSkillV3[] = [];
    if (starflare) skills.push('STARFLARE');
    if (keen) skills.push('KEEN_SHOT');
    if (guard) skills.push('MECHANICAL_GUARD');
    if (frenzy) skills.push('GUARDIAN_FRENZY');
    const hit = rolls.hit < Math.min(9_900, battleHitChanceV2(attacker, defender) + (keen ? 1_500 : 0));
    const critical = hit && rolls.critical < battleCriticalChanceV2(attacker, defender) + (keen ? 1_000 : 0);
    const base = Math.max(1, attacker.atk - Math.floor(defender.def * 6_000 / BPS));
    let amount = Math.max(1, Math.floor(base * rolls.variance / BPS));
    if (critical) amount = Math.floor(amount * 15_000 / BPS);
    if (starflare || frenzy) amount = Math.floor(amount * (starflare ? 14_000 : 15_000) / BPS);
    if (guard) amount = Math.max(1, Math.floor(amount * 6_500 / BPS));
    const damage = hit ? Math.min(targetHp, amount) : 0;
    return Object.freeze({ actor, hit, critical, damage, targetHpBefore: targetHp, targetHpAfter: targetHp - damage,
      skills: Object.freeze(skills) });
  }

  for (let round = 1; round <= MAX_BATTLE_ROUNDS_V2 && petHp > 0 && enemyHp > 0; round++) {
    const petRolls = roll(), enemyRolls = roll();
    const actions: BattleActionV3[] = [];
    for (const actor of [first, second]) {
      if (petHp === 0 || enemyHp === 0) break;
      const action = attack(actor, round, actor === 'PET' ? petRolls : enemyRolls);
      if (actor === 'PET') enemyHp = action.targetHpAfter;
      else petHp = action.targetHpAfter;
      actions.push(action);
    }
    rounds.push(Object.freeze({ round, first, actions: Object.freeze(actions), petHp, enemyHp }));
  }
  const termination = enemyHp === 0 ? 'ENEMY_KO' : petHp === 0 ? 'PET_KO' : 'ROUND_LIMIT';
  const report: BattleReportV3 = Object.freeze({ rulesVersion: SKILLED_BATTLE_RULES_VERSION, petStats, petStartHp: raw.petHp,
    petEndHp: petHp, enemy, enemyEndHp: enemyHp, outcome: termination === 'ENEMY_KO' ? 'WIN' : 'LOSS', termination,
    petSkill, boss, rounds: Object.freeze(rounds) });
  return Object.freeze({ report, rngState, drawCount: rounds.length * BATTLE_DRAWS_PER_ROUND_V2 });
}
