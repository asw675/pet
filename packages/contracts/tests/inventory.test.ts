import { describe, expect, it } from 'vitest';
import {
  battleStatsSchema, equipmentDefinitionSchema, equipmentEquipPayloadSchema, equipmentSalvagePayloadSchema,
  equipmentUnequipPayloadSchema, equipmentUpgradePayloadSchema, inventoryEquipmentInstanceSchema,
  inventoryLimits, inventoryPageSchema, itemDefinitionSchema, itemUsePayloadSchema, levelProgressionSchema,
  shopOfferSchema, shopPurchasePayloadSchema,
} from '../src/inventory.js';
import type { InventoryEquipmentInstance, InventoryPage, InventoryPet, ItemDefinition } from '../src/inventory.js';

const stats = (hp = 0, atk = 0, def = 0, spd = 0, luk = 0) => ({ hp, atk, def, spd, luk });
const ore = { itemId: 'iron-ore', displayName: '铁矿石', description: '强化素材', rarity: 'COMMON',
  kind: 'MATERIAL', storage: 'STACK', stackable: true } satisfies ItemDefinition;
const scrap = { ...ore, itemId: 'iron-scrap', displayName: '铁屑' } satisfies ItemDefinition;
const ration = { ...ore, itemId: 'ration', displayName: '旅行口粮', kind: 'CONSUMABLE',
  effect: { kind: 'RESTORE_ENERGY', amount10: 200 } } satisfies ItemDefinition;
const gift = { ...ore, itemId: 'sweet-biscuit', displayName: '饼干', kind: 'GIFT',
  effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: 40 } } satisfies ItemDefinition;
const staff = { itemId: 'apprentice-staff', displayName: '见习法杖', description: '基础魔法武器', rarity: 'COMMON',
  kind: 'EQUIPMENT', storage: 'INSTANCE', stackable: false, equipment: { definitionId: 'apprentice-staff', slot: 'WEAPON', rarity: 'COMMON',
    baseBonus: stats(0, 4, 0, 0, 1), enhancementBonus: stats(0, 2, 0, 0, 1),
    upgradeMaterialId: ore.itemId, salvageMaterialId: scrap.itemId, maxEnhancement: 5 } } satisfies ItemDefinition;

const pet = { petId: 'pet-1', characterId: 'star-singer', nickname: '星咏',
  progression: { level: 1, cumulativeXp: 50, levelStartXp: 0, xpInLevel: 50,
    xpRequiredForNextLevel: 100, xpRemainingToNextLevel: 50 },
  stats: stats(75, 22, 12, 14, 16), battlePower: 30, bondStage: 0, equipped: [],
} satisfies InventoryPet;
const ownedStaff = { instanceId: 'gear-1', definitionId: staff.itemId, definitionVersion: 1,
  enhancement: 2, acquiredAt: 123, equipped: null, definitionState: 'AVAILABLE', bonus: stats(0, 8, 0, 0, 3),
  upgrade: { ok: true, fromEnhancement: 2, toEnhancement: 3, cost: { coins: 30, materials: [{ itemId: ore.itemId, quantity: 2 }] },
    newBonus: stats(0, 10, 0, 0, 4), affordable: true },
  salvage: { materials: [{ itemId: scrap.itemId, quantity: 2 }], canSalvage: true },
} satisfies InventoryEquipmentInstance;

const page = { revision: 4, catalogVersion: 1, walletCoins: 30, definitions: [ore, scrap, ration, gift, staff],
  stacks: [{ itemId: ore.itemId, quantity: 2, definitionState: 'AVAILABLE' },
    { itemId: ration.itemId, quantity: 0, definitionState: 'AVAILABLE' }],
  instances: [ownedStaff], offers: [{ offerId: 'shop-ration', itemId: ration.itemId,
    catalogVersion: 1, priceCoins: 2, minQuantity: 1, maxQuantity: 20 },
  { offerId: 'shop-apprentice-staff', itemId: staff.itemId, catalogVersion: 1, priceCoins: 12, minQuantity: 1, maxQuantity: 3 }],
  pets: [pet],
} satisfies InventoryPage;

const availableEquipped = { ...ownedStaff, equipped: { petId: pet.petId, slot: 'WEAPON' },
  salvage: { materials: ownedStaff.salvage.materials, canSalvage: false, reason: 'EQUIPPED' } } satisfies InventoryEquipmentInstance;
const equippedPet = { ...pet, equipped: [{ slot: 'WEAPON', instanceId: ownedStaff.instanceId }] } satisfies InventoryPet;
const equippedPage = { ...page, instances: [availableEquipped], pets: [equippedPet] } satisfies InventoryPage;
const unavailable = { ...ownedStaff, instanceId: 'old-staff', definitionVersion: 2, definitionState: 'UNAVAILABLE', bonus: null,
  upgrade: { ok: false, reason: 'UNAVAILABLE' }, salvage: { materials: [], canSalvage: false, reason: 'UNAVAILABLE' } } satisfies InventoryEquipmentInstance;

const withInstance = (change: Record<string, unknown>) => ({ ...page, instances: [{ ...ownedStaff, ...change }] });
const withPet = (change: Record<string, unknown>) => ({ ...page, pets: [{ ...pet, ...change }] });

describe('coherent versioned inventory wire projections', () => {
  it('accepts stack, equipment, offers, growth and authority quotes in their exact shapes', () => {
    expect(inventoryPageSchema.parse(page)).toEqual(page);
    expect(inventoryPageSchema.parse(equippedPage)).toEqual(equippedPage);
  });

  it('accepts absent historical definitions and refuses to substitute current assets/bonuses', () => {
    const historical = { ...page, instances: [ownedStaff, unavailable, { ...unavailable, instanceId: 'old-unknown', definitionId: 'forgotten-gear' }],
      stacks: [...page.stacks, { itemId: 'forgotten-herb', quantity: 7, definitionState: 'LEGACY_UNKNOWN' }] };
    expect(inventoryPageSchema.parse(historical)).toEqual(historical);
    expect(inventoryPageSchema.safeParse({ ...historical, instances: [{ ...unavailable, bonus: stats(0, 1) }] }).success).toBe(false);
    expect(inventoryPageSchema.safeParse({ ...historical, instances: [{ ...unavailable, upgrade: ownedStaff.upgrade }] }).success).toBe(false);
    expect(inventoryPageSchema.safeParse({ ...historical, instances: [{ ...unavailable, salvage: ownedStaff.salvage }] }).success).toBe(false);
  });

  it('permits an explicitly unavailable historical instance still recorded in a pet loadout', () => {
    const history = { ...unavailable, equipped: { petId: pet.petId, slot: 'WEAPON' } };
    const oldPet = { ...pet, stats: null, equipped: [{ slot: 'WEAPON', instanceId: unavailable.instanceId }] };
    expect(inventoryPageSchema.safeParse({ ...page, instances: [history], pets: [oldPet] }).success).toBe(true);
  });

  it('accepts truthful unaffordable quotes for an insufficient coin or material balance', () => {
    const quotes = [{ ...ownedStaff, upgrade: { ...ownedStaff.upgrade, affordable: false } }];
    expect(inventoryPageSchema.safeParse({ ...page, walletCoins: 29, instances: quotes }).success).toBe(true);
    expect(inventoryPageSchema.safeParse({ ...page, stacks: [{ ...page.stacks[0]!, quantity: 1 }], instances: quotes }).success).toBe(true);
    expect(inventoryPageSchema.safeParse({ ...page, instances: quotes }).success).toBe(false);
  });

  it('accepts a reached enhancement cap and a lower authored cap without inventing a next cost', () => {
    const capped = { ...ownedStaff, enhancement: 5, bonus: stats(0, 14, 0, 0, 6),
      upgrade: { ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 } };
    expect(inventoryPageSchema.safeParse({ ...page, instances: [capped] }).success).toBe(true);
    const lower = { ...staff, equipment: { ...staff.equipment, maxEnhancement: 2 } };
    expect(inventoryPageSchema.safeParse({ ...page, definitions: [ore, scrap, ration, gift, lower],
      instances: [{ ...ownedStaff, upgrade: { ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 2 } }] }).success).toBe(true);
  });

  it('supports definitions without an explicit cap (domain default 5), and never admits real-money fields', () => {
    const { maxEnhancement, ...withoutCap } = staff.equipment;
    expect(maxEnhancement).toBe(5);
    expect(equipmentDefinitionSchema.safeParse(withoutCap).success).toBe(true);
    expect(shopOfferSchema.safeParse({ ...page.offers[0], realPrice: 0.99, currency: 'USD' }).success).toBe(false);
  });
});

describe('rejects malformed or contradictory inventory views', () => {
  it.each([
    ['extra page field', { ...page, privatePath: '/Users/private/file' }],
    ['duplicate definition', { ...page, definitions: [...page.definitions, staff] }],
    ['duplicate held stack', { ...page, stacks: [...page.stacks, page.stacks[0]] }],
    ['duplicate instance ID', { ...page, instances: [ownedStaff, ownedStaff] }],
    ['duplicate pet ID', { ...page, pets: [pet, pet] }],
    ['duplicate offer ID', { ...page, offers: [...page.offers, { ...page.offers[0], itemId: ore.itemId }] }],
    ['duplicate offered item', { ...page, offers: [...page.offers, { ...page.offers[0], offerId: 'another-offer' }] }],
    ['offer unknown item', { ...page, offers: [{ ...page.offers[0], itemId: 'missing' }] }],
    ['offer stale version', { ...page, offers: [{ ...page.offers[0], catalogVersion: 2 }] }],
    ['missing equipment material', { ...page, definitions: [scrap, ration, gift, staff] }],
    ['upgrade depends on non-material', { ...page, definitions: [ore, scrap, ration, gift, { ...staff, equipment: { ...staff.equipment, upgradeMaterialId: ration.itemId } }] }],
    ['stack of instance definition', { ...page, stacks: [{ itemId: staff.itemId, quantity: 1, definitionState: 'AVAILABLE' }] }],
    ['known stack mislabeled legacy', { ...page, stacks: [{ ...page.stacks[0], definitionState: 'LEGACY_UNKNOWN' }] }],
    ['unknown stack falsely available', { ...page, stacks: [{ itemId: 'unknown', quantity: 1, definitionState: 'AVAILABLE' }] }],
    ['wrong historical version claims available', withInstance({ definitionVersion: 2 })],
    ['current definition mislabeled unavailable', { ...page, instances: [{ ...unavailable, definitionVersion: 1 }] }],
    ['unknown current gear claims availability', withInstance({ definitionId: 'unknown' })],
    ['bonus contradicts enhancement', withInstance({ bonus: stats(0, 999) })],
    ['wrong upgrade new bonus', withInstance({ upgrade: { ...ownedStaff.upgrade, newBonus: stats(0, 999) } })],
    ['wrong upgrade source enhancement', withInstance({ upgrade: { ...ownedStaff.upgrade, fromEnhancement: 1, toEnhancement: 2 } })],
    ['upgrade jumps over next enhancement', withInstance({ upgrade: { ...ownedStaff.upgrade, toEnhancement: 4 } })],
    ['upgrade exceeds authored cap', { ...page, definitions: [ore, scrap, ration, gift, { ...staff, equipment: { ...staff.equipment, maxEnhancement: 2 } }] }],
    ['false maximum quote', withInstance({ upgrade: { ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 } })],
    ['wrong upgrade material', withInstance({ upgrade: { ...ownedStaff.upgrade, cost: { coins: 30, materials: [{ itemId: scrap.itemId, quantity: 2 }] } } })],
    ['non-material quote', withInstance({ upgrade: { ...ownedStaff.upgrade, cost: { coins: 30, materials: [{ itemId: ore.itemId, quantity: 2 }, { itemId: gift.itemId, quantity: 1 }] } } })],
    ['duplicate quote material', withInstance({ upgrade: { ...ownedStaff.upgrade, cost: { coins: 30, materials: [{ itemId: ore.itemId, quantity: 1 }, { itemId: ore.itemId, quantity: 1 }] } } })],
    ['wrong salvage material', withInstance({ salvage: { materials: [{ itemId: ore.itemId, quantity: 2 }], canSalvage: true } })],
    ['affordable despite insufficient wallet', { ...page, walletCoins: 29 }],
    ['affordable despite insufficient material', { ...page, stacks: [] }],
    ['salvage permitted while equipped', { ...equippedPage, instances: [{ ...availableEquipped, salvage: ownedStaff.salvage }] }],
    ['unequipped incorrectly blocked as equipped', withInstance({ salvage: availableEquipped.salvage })],
    ['assignment references missing pet', { ...equippedPage, pets: [] }],
    ['assignment not in owner loadout', { ...equippedPage, pets: [pet] }],
    ['loadout references absent instance', { ...equippedPage, instances: [] }],
    ['available wrong equipped slot', { ...equippedPage, instances: [{ ...availableEquipped, equipped: { petId: pet.petId, slot: 'ARMOR' } }],
      pets: [{ ...equippedPet, equipped: [{ slot: 'ARMOR', instanceId: ownedStaff.instanceId }] }] }],
    ['equipped instance used by two owners', { ...equippedPage, pets: [equippedPet, { ...equippedPet, petId: 'pet-2' }] }],
    ['duplicate loadout slot', { ...equippedPage, pets: [{ ...equippedPet, equipped: [...equippedPet.equipped, ...equippedPet.equipped] }] }],
    ['invalid pet battle power', withPet({ battlePower: 1001 })],
    ['wrong bond stage', withPet({ bondStage: 4 })],
    ['false zero battle HP', withPet({ stats: stats() })],
  ] satisfies [string, unknown][])('rejects %s', (_label, invalid) => expect(inventoryPageSchema.safeParse(invalid).success).toBe(false));

  it.each(['definitions', 'stacks', 'instances', 'offers', 'pets'] as const)('bounds %s collection size before trusting projection', key => {
    const first = page[key][0];
    const invalid = { ...page, [key]: Array.from({ length: inventoryLimits[key] + 1 }, () => first) };
    const result = inventoryPageSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected collection bound');
    expect(result.error.issues.some(issue => issue.code === 'too_big' && issue.path[0] === key)).toBe(true);
  });
});

describe('strict scalar and definition validation', () => {
  it.each([
    { ...ore, storage: 'INSTANCE' }, { ...ration, effect: { kind: 'RESTORE_ENERGY', amount10: 0 } },
    { ...ration, effect: { kind: 'RESTORE_HEALTH', amount10: 1001 } }, { ...ration, effect: { kind: 'EVAL', data: 'x' } },
    { ...gift, effect: { ...gift.effect, moodGain10: 1.5 } }, { ...staff, rarity: 'RARE' }, { ...staff, stackable: true },
    { ...staff, itemId: 'different' }, { ...staff, equipment: { ...staff.equipment, slot: 'EXTRA' } },
    { ...staff, equipment: { ...staff.equipment, maxEnhancement: 6 } },
    { ...staff, equipment: { ...staff.equipment, enhancementBonus: stats(0, 1_000_000) } },
    { ...ore, itemId: '../path' }, { ...ore, displayName: '   ' }, { ...ore, assetPath: 'secret' },
  ])('rejects malformed item DTO %#', invalid => expect(itemDefinitionSchema.safeParse(invalid).success).toBe(false));

  it.each([stats(-1), stats(0, 0.5), stats(0, 1_000_001), { ...stats(), health: 1 }])('rejects malformed battle stat DTO %#', invalid => {
    expect(battleStatsSchema.safeParse(invalid).success).toBe(false);
  });

  it('preserves valid cumulative XP beyond max level without a phantom next level', () => {
    expect(levelProgressionSchema.safeParse(pet.progression).success).toBe(true);
    expect(levelProgressionSchema.safeParse({ level: 20, cumulativeXp: 100_000, levelStartXp: 7885,
      xpInLevel: 92115, xpRequiredForNextLevel: null, xpRemainingToNextLevel: null }).success).toBe(true);
    for (const bad of [{ ...pet.progression, xpInLevel: 49 }, { ...pet.progression, xpRemainingToNextLevel: 49 },
      { ...pet.progression, level: 20 }, { ...pet.progression, level: 21 }, { ...pet.progression, cumulativeXp: -1 },
      { ...pet.progression, xpRequiredForNextLevel: null, xpRemainingToNextLevel: null }]) {
      expect(levelProgressionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects unsafe integer counts and enhancement values before any authority use', () => {
    expect(inventoryPageSchema.safeParse({ ...page, walletCoins: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(inventoryPageSchema.safeParse({ ...page, stacks: [{ ...page.stacks[0], quantity: -1 }] }).success).toBe(false);
    expect(inventoryEquipmentInstanceSchema.safeParse({ ...ownedStaff, enhancement: 6 }).success).toBe(false);
    expect(inventoryEquipmentInstanceSchema.safeParse({ ...ownedStaff, acquiredAt: -1 }).success).toBe(false);
    expect(shopOfferSchema.safeParse({ ...page.offers[0], priceCoins: 0 }).success).toBe(false);
    expect(shopOfferSchema.safeParse({ ...page.offers[0], minQuantity: 21, maxQuantity: 20 }).success).toBe(false);
  });
});

describe('inventory commands accept intent, never values computed by the renderer', () => {
  const purchase = { offerId: 'shop-ration', quantity: 1, catalogVersion: 1 };
  const equip = { petId: 'pet-1', instanceId: 'gear-1', slot: 'WEAPON', catalogVersion: 1 };
  const unequip = { petId: 'pet-1', slot: 'WEAPON', catalogVersion: 1 };
  const change = { instanceId: 'gear-1', expectedEnhancement: 2, catalogVersion: 1 };
  const use = { petId: 'pet-1', itemId: 'ration', catalogVersion: 1 };
  it('accepts the six closed command payloads exactly', () => {
    expect(shopPurchasePayloadSchema.parse(purchase)).toEqual(purchase);
    expect(equipmentEquipPayloadSchema.parse(equip)).toEqual(equip);
    expect(equipmentUnequipPayloadSchema.parse(unequip)).toEqual(unequip);
    expect(equipmentUpgradePayloadSchema.parse(change)).toEqual(change);
    expect(equipmentSalvagePayloadSchema.parse(change)).toEqual(change);
    expect(itemUsePayloadSchema.parse(use)).toEqual(use);
  });

  it.each([
    ['purchase price', shopPurchasePayloadSchema, { ...purchase, priceCoins: 0 }],
    ['purchase output', shopPurchasePayloadSchema, { ...purchase, itemId: 'staff' }],
    ['purchase zero count', shopPurchasePayloadSchema, { ...purchase, quantity: 0 }],
    ['purchase count overflow', shopPurchasePayloadSchema, { ...purchase, quantity: inventoryLimits.purchaseQuantity + 1 }],
    ['purchase bad version', shopPurchasePayloadSchema, { ...purchase, catalogVersion: 0 }],
    ['equip slot', equipmentEquipPayloadSchema, { ...equip, slot: 'EXTRA' }],
    ['equip bonus', equipmentEquipPayloadSchema, { ...equip, newBonus: stats(1000) }],
    ['unequip instance injection', equipmentUnequipPayloadSchema, { ...unequip, instanceId: 'other' }],
    ['upgrade invented next level', equipmentUpgradePayloadSchema, { ...change, toEnhancement: 5 }],
    ['upgrade omitted expectation', equipmentUpgradePayloadSchema, { instanceId: 'gear-1', catalogVersion: 1 }],
    ['salvage material grant', equipmentSalvagePayloadSchema, { ...change, materials: [] }],
    ['salvage invalid enhancement expectation', equipmentSalvagePayloadSchema, { ...change, expectedEnhancement: 6 }],
    ['use amount', itemUsePayloadSchema, { ...use, quantity: 100 }],
    ['use effect', itemUsePayloadSchema, { ...use, effect: { kind: 'RESTORE_HEALTH', amount10: 1000 } }],
    ['use path', itemUsePayloadSchema, { ...use, itemId: '../external' }],
  ] as const)('rejects untrusted %s', (_name, schema, payload) => expect(schema.safeParse(payload).success).toBe(false));
});
