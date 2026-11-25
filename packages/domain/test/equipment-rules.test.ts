import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_RARITIES, MAX_ENHANCEMENT, computeEquipmentBonuses, equipmentBonus, evaluateSalvage, evaluateUpgrade,
} from '../src/equipment-rules.js';
import type { EquipmentDefinition, EquippedInstance, EquipmentRarity, EquipmentSlot } from '../src/equipment-rules.js';
import { computeBattlePower, computeBattleStats, ZERO_BATTLE_BONUS } from '../src/progression.js';

const sword = Object.freeze({
  definitionId: 'training-blade', slot: 'WEAPON', rarity: 'COMMON',
  baseBonus: Object.freeze({ hp: 0, atk: 5, def: 0, spd: 1, luk: 0 }),
  enhancementBonus: Object.freeze({ hp: 0, atk: 2, def: 1, spd: 0, luk: 0 }),
  upgradeMaterialId: 'iron-ore', salvageMaterialId: 'iron-scrap',
} as const satisfies EquipmentDefinition);
const coat = Object.freeze({
  definitionId: 'field-coat', slot: 'ARMOR', rarity: 'UNCOMMON',
  baseBonus: Object.freeze({ hp: 8, atk: 0, def: 4, spd: 0, luk: 0 }),
  enhancementBonus: Object.freeze({ hp: 3, atk: 0, def: 1, spd: 0, luk: 0 }),
  upgradeMaterialId: 'cloth', salvageMaterialId: 'cloth', maxEnhancement: 3,
} as const satisfies EquipmentDefinition);
const charm = Object.freeze({
  definitionId: 'lucky-charm', slot: 'ACCESSORY', rarity: 'RARE',
  baseBonus: Object.freeze({ hp: 2, atk: 0, def: 0, spd: 0, luk: 4 }),
  enhancementBonus: Object.freeze({ hp: 0, atk: 0, def: 0, spd: 0, luk: 1 }),
  upgradeMaterialId: 'glimmer', salvageMaterialId: 'glimmer',
} as const satisfies EquipmentDefinition);

function equipped(definition: EquipmentDefinition, instanceId: string, enhancement: number): EquippedInstance {
  return { slot: definition.slot, definition, instanceId, enhancement };
}

describe('equipment instances and three mutually exclusive slots', () => {
  it('computes integer bonuses at +0 and each valid enhancement without mutating definitions', () => {
    expect(equipmentBonus(sword, 0)).toEqual(sword.baseBonus);
    expect(equipmentBonus(sword, 0)).not.toBe(sword.baseBonus);
    expect(equipmentBonus(sword, 3)).toEqual({ hp: 0, atk: 11, def: 3, spd: 1, luk: 0 });
    expect(equipmentBonus(sword, 5)).toEqual({ hp: 0, atk: 15, def: 5, spd: 1, luk: 0 });
    expect(equipmentBonus(coat, 3)).toEqual({ hp: 17, atk: 0, def: 7, spd: 0, luk: 0 });
    expect(sword.baseBonus.atk).toBe(5);
  });

  it('combines weapon, armor and accessory bonuses, order-independently', () => {
    const loadout = Object.freeze([equipped(sword, 'instance-a', 1), equipped(coat, 'instance-b', 2), equipped(charm, 'instance-c', 3)]);
    const expected = { hp: 16, atk: 7, def: 7, spd: 1, luk: 7 };
    expect(computeEquipmentBonuses(loadout)).toEqual(expected);
    expect(computeEquipmentBonuses([...loadout].reverse())).toEqual(expected);
    expect(computeEquipmentBonuses([])).toEqual(ZERO_BATTLE_BONUS);
  });

  it('rejects repeated slots even when equipment instance IDs differ', () => {
    expect(() => computeEquipmentBonuses([equipped(sword, 'a', 0), equipped(sword, 'b', 4)])).toThrow(/duplicate equipment slot/i);
  });

  it('rejects duplicate instance IDs even when their claimed definitions or slots differ', () => {
    expect(() => computeEquipmentBonuses([equipped(sword, 'same', 0), equipped(coat, 'same', 0)])).toThrow(/duplicate equipment slot or instance/i);
  });

  it('rejects mismatched and unknown slots rather than silently equipping items', () => {
    expect(() => computeEquipmentBonuses([{ ...equipped(sword, 'a', 0), slot: 'ARMOR' }])).toThrow(/does not match/i);
    expect(() => computeEquipmentBonuses([{ ...equipped(sword, 'a', 0), slot: 'HELMET' as EquipmentSlot }])).toThrow(/unknown equipment slot/i);
    expect(() => computeEquipmentBonuses([equipped(sword, '', 0)])).toThrow(/instance ID/i);
  });

  it('rejects loadouts larger than three and malformed entries', () => {
    expect(() => computeEquipmentBonuses([equipped(sword, 'a', 0), equipped(coat, 'b', 0), equipped(charm, 'c', 0), equipped(sword, 'd', 0)])).toThrow(/size/i);
    expect(() => computeEquipmentBonuses([null as unknown as EquippedInstance])).toThrow(RangeError);
  });

  it.each([-1, 0.5, MAX_ENHANCEMENT + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid enhancement %s in all economy helpers', (enhancement) => {
    expect(() => equipmentBonus(sword, enhancement)).toThrow(RangeError);
    expect(() => evaluateUpgrade(sword, enhancement)).toThrow(RangeError);
    expect(() => evaluateSalvage(sword, enhancement)).toThrow(RangeError);
  });

  it('rejects malformed content definitions, invalid costs/IDs and overflowing authored bonuses', () => {
    for (const invalid of [
      { definitionId: '../bad' }, { rarity: 'CUSTOM' as EquipmentRarity }, { slot: 'UNKNOWN' as EquipmentSlot },
      { upgradeMaterialId: '' }, { salvageMaterialId: 'asset/name' }, { maxEnhancement: 6 }, { maxEnhancement: -1 },
      { baseBonus: { ...sword.baseBonus, atk: -1 } }, { enhancementBonus: { ...sword.enhancementBonus, def: 0.1 } },
      { enhancementBonus: { ...sword.enhancementBonus, hp: 1_000_000 } }, { baseBonus: { ...sword.baseBonus, atk: Infinity } },
    ]) expect(() => equipmentBonus({ ...sword, ...invalid }, 0)).toThrow(RangeError);
    const large = { ...sword, baseBonus: { ...ZERO_BATTLE_BONUS, hp: 600_000 }, enhancementBonus: ZERO_BATTLE_BONUS };
    expect(() => computeEquipmentBonuses([equipped(large, 'a', 0), equipped({ ...coat, baseBonus: large.baseBonus, enhancementBonus: ZERO_BATTLE_BONUS }, 'b', 0)])).toThrow(/aggregate equipment hp bonus/i);
  });
});

describe('deterministic equipment purchasing quotes, not state transitions', () => {
  it('quotes the next enhancement and exact integer coin/material cost', () => {
    expect(evaluateUpgrade(sword, 0)).toEqual({ ok: true, fromEnhancement: 0, toEnhancement: 1,
      cost: { coins: 10, materials: [{ itemId: 'iron-ore', quantity: 1 }] }, newBonus: equipmentBonus(sword, 1) });
    expect(evaluateUpgrade(sword, 2)).toEqual({ ok: true, fromEnhancement: 2, toEnhancement: 3,
      cost: { coins: 30, materials: [{ itemId: 'iron-ore', quantity: 2 }] }, newBonus: equipmentBonus(sword, 3) });
    expect(evaluateUpgrade(charm, 4)).toEqual({ ok: true, fromEnhancement: 4, toEnhancement: 5,
      cost: { coins: 150, materials: [{ itemId: 'glimmer', quantity: 5 }] }, newBonus: equipmentBonus(charm, 5) });
  });

  it.each(EQUIPMENT_RARITIES.map((rarity, index) => [rarity, index + 1] as const))('scales %s upgrades by rarity rank %d', (rarity, rank) => {
    const quote = evaluateUpgrade({ ...sword, rarity }, 3);
    expect(quote).toMatchObject({ ok: true, toEnhancement: 4, cost: { coins: 40 * rank,
      materials: [{ itemId: 'iron-ore', quantity: rank + 1 }] } });
  });

  it('stops upgrades at the global or authored cap; capped equipment has no next cost', () => {
    expect(evaluateUpgrade(sword, 5)).toEqual({ ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 });
    expect(evaluateUpgrade(coat, 3)).toEqual({ ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 3 });
    expect(evaluateUpgrade({ ...sword, maxEnhancement: 0 }, 0)).toEqual({ ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 0 });
    expect(() => equipmentBonus(coat, 4)).toThrow(RangeError);
    expect(() => evaluateUpgrade(coat, 4)).toThrow(RangeError);
    expect(() => evaluateSalvage(coat, 4)).toThrow(RangeError);
  });

  it('salvages a finite amount of materials and gives no implicit coin refund', () => {
    expect(evaluateSalvage(sword, 0)).toEqual({ materials: [{ itemId: 'iron-scrap', quantity: 1 }] });
    expect(evaluateSalvage(sword, 5)).toEqual({ materials: [{ itemId: 'iron-scrap', quantity: 3 }] });
    expect(evaluateSalvage(charm, 4)).toEqual({ materials: [{ itemId: 'glimmer', quantity: 5 }] });
    expect(evaluateSalvage({ ...sword, rarity: 'LEGENDARY' }, 5)).toEqual({ materials: [{ itemId: 'iron-scrap', quantity: 7 }] });
  });

  it('repeated quotes are pure and never alter the equipped instance or definition', () => {
    const entry = Object.freeze(equipped(sword, 'owned-1', 2));
    const old = computeEquipmentBonuses([entry]);
    expect(evaluateUpgrade(entry.definition, entry.enhancement)).toEqual(evaluateUpgrade(entry.definition, entry.enhancement));
    expect(evaluateSalvage(entry.definition, entry.enhancement)).toEqual(evaluateSalvage(entry.definition, entry.enhancement));
    expect(computeEquipmentBonuses([entry])).toEqual(old);
    expect(entry.enhancement).toBe(2);
  });

  it('feeds validated equipped bonuses into new departure stats without mutating the profile', () => {
    const profile = Object.freeze({ basePower: 30, baseStats: { hp: 75, atk: 22, def: 12, spd: 14, luk: 16 },
      growthPerLevel: { hp: 8, atk: 4, def: 2, spd: 2, luk: 2 } });
    const loadout = [equipped(sword, 'a', 1), equipped(coat, 'b', 2), equipped(charm, 'c', 3)];
    const bonus = computeEquipmentBonuses(loadout);
    expect(computeBattleStats(profile, 1, bonus)).toEqual({ hp: 91, atk: 29, def: 19, spd: 15, luk: 23 });
    expect(computeBattlePower(profile, 1, bonus)).toBe(30 + 1 + 14 + 7 + 0 + 3);
    expect(computeBattlePower(profile, 1)).toBe(30);
  });
});
