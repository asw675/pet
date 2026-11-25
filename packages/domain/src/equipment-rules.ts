import type { BattleStats } from './progression.js';

export const EQUIPMENT_SLOTS = Object.freeze(['WEAPON', 'ARMOR', 'ACCESSORY'] as const);
export const EQUIPMENT_RARITIES = Object.freeze(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const);
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];
export type EquipmentRarity = (typeof EQUIPMENT_RARITIES)[number];

/** V1 candidate equipment upgrade cap; catalog entries may choose less. */
export const MAX_ENHANCEMENT = 5;
const EQUIPMENT_STAT_LIMIT = 1_000_000;
const statKeys = ['hp', 'atk', 'def', 'spd', 'luk'] as const;
type StatKey = (typeof statKeys)[number];

export interface EquipmentDefinition {
  readonly definitionId: string;
  readonly slot: EquipmentSlot;
  readonly rarity: EquipmentRarity;
  readonly baseBonus: BattleStats;
  readonly enhancementBonus: BattleStats;
  readonly upgradeMaterialId: string;
  readonly salvageMaterialId: string;
  readonly maxEnhancement?: number;
}

/** Caller projects owned and equipped instances from authoritative state.
 * The rules check loadout shape, not ownership or spending authorization. */
export interface EquippedInstance {
  readonly slot: EquipmentSlot;
  readonly instanceId: string;
  readonly definition: EquipmentDefinition;
  readonly enhancement: number;
}

export interface MaterialAmount { readonly itemId: string; readonly quantity: number }
export interface UpgradeCost { readonly coins: number; readonly materials: readonly MaterialAmount[] }
export type UpgradeEvaluation =
  | { readonly ok: true; readonly fromEnhancement: number; readonly toEnhancement: number;
    readonly cost: UpgradeCost; readonly newBonus: BattleStats }
  | { readonly ok: false; readonly reason: 'MAX_ENHANCEMENT'; readonly maxEnhancement: number };
export interface SalvageEvaluation { readonly materials: readonly MaterialAmount[] }

const rarityRank: Readonly<Record<EquipmentRarity, number>> = Object.freeze({
  COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5,
});

function boundedInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function requireId(id: string, label: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new RangeError(`Invalid ${label}`);
}

function requireSlot(slot: EquipmentSlot): void {
  if (!EQUIPMENT_SLOTS.includes(slot)) throw new RangeError('Unknown equipment slot');
}

function requireStats(stats: BattleStats, label: string): void {
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)
    || Object.keys(stats).length !== statKeys.length || !statKeys.every(key => Object.hasOwn(stats, key))) {
    throw new RangeError(`${label} must contain exactly hp, atk, def, spd, luk`);
  }
  for (const key of statKeys) boundedInteger(stats[key], 0, EQUIPMENT_STAT_LIMIT, `${label}.${key}`);
}

function requireDefinition(def: EquipmentDefinition): number {
  if (def === null || typeof def !== 'object') throw new RangeError('Missing equipment definition');
  requireId(def.definitionId, 'equipment definition ID');
  requireSlot(def.slot);
  if (!EQUIPMENT_RARITIES.includes(def.rarity)) throw new RangeError('Unknown equipment rarity');
  requireStats(def.baseBonus, 'equipment base bonus');
  requireStats(def.enhancementBonus, 'equipment enhancement bonus');
  requireId(def.upgradeMaterialId, 'upgrade material ID');
  requireId(def.salvageMaterialId, 'salvage material ID');
  const cap = def.maxEnhancement === undefined ? MAX_ENHANCEMENT : def.maxEnhancement;
  boundedInteger(cap, 0, MAX_ENHANCEMENT, 'equipment enhancement cap');
  // Validate the full allowed range, not just an item's current level.
  for (const key of statKeys) {
    boundedInteger(def.baseBonus[key] + cap * def.enhancementBonus[key], 0, EQUIPMENT_STAT_LIMIT, `max equipment ${key} bonus`);
  }
  return cap;
}

function bonusForValidatedDefinition(def: EquipmentDefinition, enhancement: number): BattleStats {
  const calculate = (key: StatKey): number => def.baseBonus[key] + enhancement * def.enhancementBonus[key];
  return { hp: calculate('hp'), atk: calculate('atk'), def: calculate('def'), spd: calculate('spd'), luk: calculate('luk') };
}

/** Base plus an integer per-enhancement contribution (including +0). */
export function equipmentBonus(def: EquipmentDefinition, enhancement: number): BattleStats {
  const cap = requireDefinition(def);
  boundedInteger(enhancement, 0, cap, 'equipment enhancement');
  return bonusForValidatedDefinition(def, enhancement);
}

/** Add the three mutually exclusive equip slots, reject a repeated instance
 * or mismatched slot rather than double-counting. Empty loadout => zeros. */
export function computeEquipmentBonuses(loadout: readonly EquippedInstance[]): BattleStats {
  if (!Array.isArray(loadout) || loadout.length > EQUIPMENT_SLOTS.length) throw new RangeError('Invalid equipment loadout size');
  const slots = new Set<EquipmentSlot>();
  const instances = new Set<string>();
  const total = { hp: 0, atk: 0, def: 0, spd: 0, luk: 0 };
  for (const item of loadout as readonly EquippedInstance[]) {
    if (item === null || typeof item !== 'object') throw new RangeError('Invalid equipped instance');
    requireSlot(item.slot);
    requireId(item.instanceId, 'equipment instance ID');
    const bonus = equipmentBonus(item.definition, item.enhancement);
    if (item.definition.slot !== item.slot) throw new RangeError('Equipment definition does not match its equipped slot');
    if (slots.has(item.slot) || instances.has(item.instanceId)) throw new RangeError('Duplicate equipment slot or instance');
    slots.add(item.slot);
    instances.add(item.instanceId);
    for (const key of statKeys) {
      total[key] += bonus[key];
      boundedInteger(total[key], 0, EQUIPMENT_STAT_LIMIT, `aggregate equipment ${key} bonus`);
    }
  }
  return total;
}

/** Pure quote. V1 candidate: rank k=1..5, next enhancement t=1..5,
 * cost coins=10*k*t, upgrade materials=k+floor((t-1)/2). No wallet changes,
 * random success/failure, item creation or implicit ownership permission. */
export function evaluateUpgrade(def: EquipmentDefinition, currentEnhancement: number): UpgradeEvaluation {
  const cap = requireDefinition(def);
  boundedInteger(currentEnhancement, 0, cap, 'equipment enhancement');
  if (currentEnhancement === cap) return { ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: cap };
  const next = currentEnhancement + 1, rank = rarityRank[def.rarity];
  return {
    ok: true, fromEnhancement: currentEnhancement, toEnhancement: next,
    cost: { coins: 10 * rank * next, materials: [{ itemId: def.upgradeMaterialId, quantity: rank + Math.floor((next - 1) / 2) }] },
    newBonus: bonusForValidatedDefinition(def, next),
  };
}

/** Pure salvage quote: rank + floor(enhancement/2) of a specified material,
 * never a coin refund or reconstruction of every material already spent. */
export function evaluateSalvage(def: EquipmentDefinition, enhancement: number): SalvageEvaluation {
  const cap = requireDefinition(def);
  boundedInteger(enhancement, 0, cap, 'equipment enhancement');
  return { materials: [{ itemId: def.salvageMaterialId, quantity: rarityRank[def.rarity] + Math.floor(enhancement / 2) }] };
}
