import { describe, expect, it } from 'vitest';
import { DEMO_ROUTE } from '../src/index.js';
import { EQUIPMENT_SLOTS, evaluateSalvage, evaluateUpgrade, MAX_ENHANCEMENT } from '../src/equipment-rules.js';
import {
  BUILTIN_ITEMS, defineItemCatalog, findItemDefinition, findShopOffer, ITEM_CATALOG,
  ITEM_CATALOG_VERSION, MAX_CATALOG_ITEMS, MAX_PURCHASE_QUANTITY, MAX_SHOP_OFFERS, SHOP_OFFERS, validateItemCatalog,
} from '../src/item-catalog.js';
import type { EquipmentItemDefinition, ItemCatalog, ItemDefinition, ShopOffer } from '../src/item-catalog.js';

const ration = findItemDefinition('ration')!;
const gift = findItemDefinition('sweet-biscuit')!;
const staff = findItemDefinition('apprentice-staff') as EquipmentItemDefinition;
const rationOffer = findShopOffer('shop-ration')!;

function withItem(itemId: string, change: Record<string, unknown>): ItemCatalog {
  return { ...ITEM_CATALOG, items: BUILTIN_ITEMS.map(item => item.itemId === itemId ? { ...item, ...change } as ItemDefinition : item) };
}
function withOffer(offerId: string, change: Record<string, unknown>): ItemCatalog {
  return { ...ITEM_CATALOG, shopOffers: SHOP_OFFERS.map(offer => offer.offerId === offerId ? { ...offer, ...change } as ShopOffer : offer) };
}

describe('immutable, versioned item and commerce content', () => {
  it('defines a validated small catalog and one versioned offer per offered item', () => {
    expect(ITEM_CATALOG_VERSION).toBe(1);
    expect(() => validateItemCatalog(ITEM_CATALOG)).not.toThrow();
    expect(BUILTIN_ITEMS).toBe(ITEM_CATALOG.items);
    expect(SHOP_OFFERS).toBe(ITEM_CATALOG.shopOffers);
    expect(BUILTIN_ITEMS).toHaveLength(18);
    expect(SHOP_OFFERS).toHaveLength(13);
    expect(new Set(BUILTIN_ITEMS.map(item => item.itemId)).size).toBe(BUILTIN_ITEMS.length);
    expect(new Set(SHOP_OFFERS.map(offer => offer.offerId)).size).toBe(SHOP_OFFERS.length);
    expect(new Set(SHOP_OFFERS.map(offer => offer.itemId)).size).toBe(SHOP_OFFERS.length);
    for (const offer of SHOP_OFFERS) {
      expect(offer.catalogVersion).toBe(ITEM_CATALOG_VERSION);
      expect(findItemDefinition(offer.itemId)).toBeDefined();
      expect(offer.priceCoins).toBeGreaterThan(0);
      expect(offer.minQuantity).toBeGreaterThanOrEqual(1);
      expect(offer.maxQuantity).toBeLessThanOrEqual(MAX_PURCHASE_QUANTITY);
    }
  });

  it('preserves every original route material identity and prepares the forest/ruins identities', () => {
    const dropIds = DEMO_ROUTE.nodes.flatMap(node => node.kind === 'GATHER' ? [node.itemId] : node.kind === 'BATTLE' && node.drop ? [node.drop.itemId] : []);
    expect(dropIds).toEqual(['herb', 'slime-gel']);
    for (const id of [...dropIds, 'forest-wood', 'ruin-shard']) {
      expect(findItemDefinition(id)).toMatchObject({ itemId: id, kind: 'MATERIAL', storage: 'STACK', stackable: true });
    }
  });

  it('declares fixed-point home supply and gift effects without executable data or changing state', () => {
    expect(ration).toMatchObject({ kind: 'CONSUMABLE', storage: 'STACK', stackable: true,
      effect: { kind: 'RESTORE_ENERGY', amount10: 200 } });
    expect(findItemDefinition('healing-potion')).toMatchObject({ kind: 'CONSUMABLE', storage: 'STACK', stackable: true,
      effect: { kind: 'RESTORE_HEALTH', amount10: 250 } });
    expect(gift).toMatchObject({ kind: 'GIFT', storage: 'STACK', stackable: true,
      effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: 40 } });
  });

  it('covers three slots, three starter weapon styles and declared enhancement/salvage stack materials', () => {
    const gear = BUILTIN_ITEMS.filter((item): item is EquipmentItemDefinition => item.kind === 'EQUIPMENT');
    expect(new Set(gear.map(item => item.equipment.slot))).toEqual(new Set(EQUIPMENT_SLOTS));
    expect(gear.filter(item => item.equipment.slot === 'WEAPON').map(item => item.itemId)).toEqual([
      'apprentice-staff', 'forest-bow', 'mechanical-tool',
    ]);
    for (const item of gear) {
      expect(item.storage).toBe('INSTANCE');
      expect(item.stackable).toBe(false);
      expect(item.equipment.definitionId).toBe(item.itemId);
      expect(item.equipment.rarity).toBe(item.rarity);
      expect(item.equipment.maxEnhancement).toBe(MAX_ENHANCEMENT);
      const up = evaluateUpgrade(item.equipment, MAX_ENHANCEMENT - 1);
      expect(up.ok).toBe(true);
      if (!up.ok) throw new Error('expected upgrade');
      expect(up.toEnhancement).toBe(5);
      expect(evaluateUpgrade(item.equipment, 5)).toEqual({ ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 });
      for (const entry of [...up.cost.materials, ...evaluateSalvage(item.equipment, 5).materials]) {
        expect(findItemDefinition(entry.itemId)).toMatchObject({ kind: 'MATERIAL', storage: 'STACK', stackable: true });
      }
    }
  });

  it('returns undefined for unknown IDs rather than prototype keys or arbitrary paths', () => {
    for (const id of ['missing', '__proto__', 'constructor', '../ration', 'https://example.invalid']) {
      expect(findItemDefinition(id)).toBeUndefined();
      expect(findShopOffer(id)).toBeUndefined();
    }
  });

  it('deep-freezes every built-in data object, including nested bonuses and effects', () => {
    expect(Object.isFrozen(ITEM_CATALOG)).toBe(true);
    expect(Object.isFrozen(BUILTIN_ITEMS)).toBe(true);
    expect(Object.isFrozen(SHOP_OFFERS)).toBe(true);
    for (const item of BUILTIN_ITEMS) {
      expect(Object.isFrozen(item)).toBe(true);
      if (item.kind === 'EQUIPMENT') {
        expect(Object.isFrozen(item.equipment)).toBe(true);
        expect(Object.isFrozen(item.equipment.baseBonus)).toBe(true);
        expect(Object.isFrozen(item.equipment.enhancementBonus)).toBe(true);
      } else if (item.kind !== 'MATERIAL') expect(Object.isFrozen(item.effect)).toBe(true);
    }
    expect(SHOP_OFFERS.every(Object.isFrozen)).toBe(true);
  });

  it('takes detached nested copies of authoring arrays, prices and equipment stats', () => {
    const copy = {
      version: 2, items: BUILTIN_ITEMS.map(item => item.kind === 'EQUIPMENT' ? {
        ...item, equipment: { ...item.equipment, baseBonus: { ...item.equipment.baseBonus }, enhancementBonus: { ...item.equipment.enhancementBonus } },
      } : item.kind === 'MATERIAL' ? { ...item } : { ...item, effect: { ...item.effect } }) as ItemDefinition[],
      shopOffers: SHOP_OFFERS.map(entry => ({ ...entry, catalogVersion: 2 })),
    };
    const frozen = defineItemCatalog(copy);
    const mutableStaff = copy.items.find(item => item.itemId === staff.itemId) as EquipmentItemDefinition;
    (mutableStaff.equipment.baseBonus as { atk: number }).atk = 999;
    const detachedStaff = findItemDefinition(staff.itemId, frozen) as EquipmentItemDefinition;
    expect(detachedStaff.equipment.baseBonus.atk).toBe(staff.equipment.baseBonus.atk);
    copy.shopOffers[0]!.priceCoins = 999;
    copy.items.pop();
    expect(frozen.items).toHaveLength(18);
    expect(frozen.shopOffers[0]?.priceCoins).toBe(2);
    expect(frozen.shopOffers[0]?.catalogVersion).toBe(2);
    expect(rationOffer.priceCoins).toBe(2);
  });
});

describe('bounded and closed catalog validation', () => {
  it.each([
    ['duplicate item ID', { ...ITEM_CATALOG, items: [...BUILTIN_ITEMS, BUILTIN_ITEMS[0]!] }],
    ['duplicate offer ID', { ...ITEM_CATALOG, shopOffers: [...SHOP_OFFERS, { ...rationOffer, itemId: 'herb' }] }],
    ['duplicate offered item', { ...ITEM_CATALOG, shopOffers: [...SHOP_OFFERS, { ...rationOffer, offerId: 'another-ration-offer' }] }],
    ['unknown offer item', withOffer(rationOffer.offerId, { itemId: 'missing' })],
    ['incorrect offer version', withOffer(rationOffer.offerId, { catalogVersion: 2 })],
    ['empty item catalog', { ...ITEM_CATALOG, items: [] }],
    ['item count overflow', { ...ITEM_CATALOG, items: Array.from({ length: MAX_CATALOG_ITEMS + 1 }, (_, i) => ({ ...BUILTIN_ITEMS[0]!, itemId: `synthetic-${i}` })) }],
    ['offer count overflow', { ...ITEM_CATALOG, shopOffers: Array.from({ length: MAX_SHOP_OFFERS + 1 }, () => rationOffer) }],
  ] satisfies [string, ItemCatalog][])('rejects %s', (_label, result) => {
    expect(() => defineItemCatalog(result)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid catalog version %s', version => {
    expect(() => defineItemCatalog({ ...ITEM_CATALOG, version })).toThrow(RangeError);
  });

  it.each([
    { priceCoins: 0 }, { priceCoins: -1 }, { priceCoins: 0.5 }, { priceCoins: NaN }, { priceCoins: Number.MAX_SAFE_INTEGER + 1 },
    { minQuantity: 0 }, { minQuantity: 22, maxQuantity: 20 }, { maxQuantity: MAX_PURCHASE_QUANTITY + 1 }, { maxQuantity: 1.2 },
    { offerId: '../malformed' }, { money: 'USD' }, { currency: 'EUR' },
  ])('rejects malformed offer %o', change => {
    expect(() => defineItemCatalog(withOffer(rationOffer.offerId, change))).toThrow(RangeError);
  });

  it.each([
    { storage: 'INSTANCE' }, { stackable: false }, { itemId: 'item/name' }, { displayName: '   ' }, { rarity: 'CUSTOM' },
    { kind: 'SCRIPT' }, { effect: { kind: 'EVAL', code: 'something' } }, { effect: { kind: 'RESTORE_ENERGY', amount10: 0 } },
    { effect: { kind: 'RESTORE_HEALTH', amount10: 1001 } }, { effect: { kind: 'RESTORE_HEALTH', amount10: 1.5 } },
    { location: '../file' },
  ])('rejects malformed consumable %o', change => {
    expect(() => defineItemCatalog(withItem(ration.itemId, change))).toThrow(RangeError);
  });

  it.each([
    { effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: -1 } },
    { effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 1001, moodGain10: 10 } },
    { effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: 10, script: 'x' } },
  ])('rejects invalid gift effects %o', change => {
    expect(() => defineItemCatalog(withItem(gift.itemId, change))).toThrow(RangeError);
  });

  it.each([
    { definitionId: 'different-item' }, { rarity: 'RARE' }, { slot: 'EXTRA' }, { maxEnhancement: 6 },
    { enhancementBonus: { ...staff.equipment.enhancementBonus, atk: 1_000_000 } },
    { upgradeMaterialId: 'missing-material' }, { upgradeMaterialId: 'ration' }, { salvageMaterialId: staff.itemId },
  ])('rejects mismatched, invalid or non-material equipment dependencies %o', change => {
    expect(() => defineItemCatalog(withItem(staff.itemId, { equipment: { ...staff.equipment, ...change } }))).toThrow(RangeError);
  });
});
