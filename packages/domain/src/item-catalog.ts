import { EQUIPMENT_RARITIES, equipmentBonus, MAX_ENHANCEMENT } from '#equipment-rules';
import type { EquipmentDefinition, EquipmentRarity } from '#equipment-rules';
import type { BattleStats } from './progression.js';

/** V1 balance content. Changing authored prices/effects/offer quantities or
 * definitions requires a new catalog revision, not a reinterpretation of saves. */
export const ITEM_CATALOG_VERSION = 1 as const;
export const MAX_CATALOG_ITEMS = 256;
export const MAX_SHOP_OFFERS = 256;
export const MAX_PURCHASE_QUANTITY = 100;

interface CommonItemDefinition {
  readonly itemId: string;
  readonly displayName: string;
  readonly description: string;
  readonly rarity: EquipmentRarity;
}

interface StackStorage { readonly storage: 'STACK'; readonly stackable: true }

/** Declared data only. Amounts are fixed-point tenths of a pet's 0..100 need,
 * not battle HP or money; later authoritative home use applies the cap/state rules. */
export type ConsumableEffect =
  | { readonly kind: 'RESTORE_ENERGY'; readonly amount10: number }
  | { readonly kind: 'RESTORE_HEALTH'; readonly amount10: number };
export interface GiftEffect {
  readonly kind: 'RAISE_BOND_AND_MOOD';
  readonly bondGain10: number;
  readonly moodGain10: number;
}

export type MaterialItemDefinition = CommonItemDefinition & StackStorage & { readonly kind: 'MATERIAL' };
export type ConsumableItemDefinition = CommonItemDefinition & StackStorage & {
  readonly kind: 'CONSUMABLE'; readonly effect: ConsumableEffect;
};
export type GiftItemDefinition = CommonItemDefinition & StackStorage & {
  readonly kind: 'GIFT'; readonly effect: GiftEffect;
};
export type EquipmentItemDefinition = CommonItemDefinition & {
  readonly kind: 'EQUIPMENT'; readonly storage: 'INSTANCE'; readonly stackable: false;
  readonly equipment: EquipmentDefinition;
};
export type StackItemDefinition = MaterialItemDefinition | ConsumableItemDefinition | GiftItemDefinition;
export type ItemDefinition = StackItemDefinition | EquipmentItemDefinition;

/** One item per offer unit; prices only in the local game's integer coin balance.
 * Bounds are per purchase operation, not stock counters or recurring entitlements. */
export interface ShopOffer {
  readonly offerId: string;
  readonly itemId: string;
  readonly catalogVersion: number;
  readonly priceCoins: number;
  readonly minQuantity: number;
  readonly maxQuantity: number;
}

export interface ItemCatalog {
  readonly version: number;
  readonly items: readonly ItemDefinition[];
  readonly shopOffers: readonly ShopOffer[];
}

const commonKeys = ['itemId', 'displayName', 'description', 'rarity', 'kind', 'storage', 'stackable'] as const;

function exactKeys(object: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (object === null || typeof object !== 'object' || Array.isArray(object)
    || !required.every(key => Object.hasOwn(object, key))
    || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new RangeError('Invalid closed item catalog data');
  }
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${label}`);
}

function id(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new RangeError(`Invalid ${label}`);
}

function text(value: string, max: number): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new RangeError('Invalid item text');
}

function validateItem(item: ItemDefinition): void {
  if (item === null || typeof item !== 'object') throw new RangeError('Invalid item');
  id(item.itemId, 'item ID');
  text(item.displayName, 80);
  text(item.description, 512);
  if (!EQUIPMENT_RARITIES.includes(item.rarity)) throw new RangeError('Invalid item rarity');
  if (item.kind === 'EQUIPMENT') {
    exactKeys(item, [...commonKeys, 'equipment']);
    if (item.storage !== 'INSTANCE' || item.stackable !== false) throw new RangeError('Equipment must use unique instances');
    exactKeys(item.equipment, ['definitionId', 'slot', 'rarity', 'baseBonus', 'enhancementBonus',
      'upgradeMaterialId', 'salvageMaterialId'], ['maxEnhancement']);
    if (item.equipment.definitionId !== item.itemId || item.equipment.rarity !== item.rarity) {
      throw new RangeError('Equipment identity/rarity must match item');
    }
    // Existing equipment rules validate exact stats, rarity, slot and the
    // entire allowed enhancement range. Do not duplicate their calculations.
    equipmentBonus(item.equipment, item.equipment.maxEnhancement ?? MAX_ENHANCEMENT);
    return;
  }
  if (item.storage !== 'STACK' || item.stackable !== true) throw new RangeError('Stack item must not use equipment instances');
  if (item.kind === 'MATERIAL') {
    exactKeys(item, commonKeys);
    return;
  }
  if (item.kind === 'CONSUMABLE') {
    exactKeys(item, [...commonKeys, 'effect']);
    exactKeys(item.effect, ['kind', 'amount10']);
    if (item.effect.kind !== 'RESTORE_ENERGY' && item.effect.kind !== 'RESTORE_HEALTH') throw new RangeError('Unknown consumable effect');
    integer(item.effect.amount10, 1, 1000, 'consumable amount in tenths');
    return;
  }
  if (item.kind === 'GIFT') {
    exactKeys(item, [...commonKeys, 'effect']);
    exactKeys(item.effect, ['kind', 'bondGain10', 'moodGain10']);
    if (item.effect.kind !== 'RAISE_BOND_AND_MOOD') throw new RangeError('Unknown gift effect');
    integer(item.effect.bondGain10, 1, 1000, 'gift bond gain in tenths');
    integer(item.effect.moodGain10, 1, 1000, 'gift mood gain in tenths');
    return;
  }
  throw new RangeError('Unknown item kind');
}

/** Validate authored content, including cross references to stack materials and
 * the one-offer-per-item V1 storefront. Work is bounded by catalog limits. */
export function validateItemCatalog(catalog: ItemCatalog): void {
  exactKeys(catalog, ['version', 'items', 'shopOffers']);
  integer(catalog.version, 1, Number.MAX_SAFE_INTEGER, 'item catalog version');
  if (!Array.isArray(catalog.items) || catalog.items.length < 1 || catalog.items.length > MAX_CATALOG_ITEMS
    || !Array.isArray(catalog.shopOffers) || catalog.shopOffers.length > MAX_SHOP_OFFERS) {
    throw new RangeError('Invalid bounded item catalog size');
  }
  const items = new Map<string, ItemDefinition>();
  for (const item of catalog.items as readonly ItemDefinition[]) {
    validateItem(item);
    if (items.has(item.itemId)) throw new RangeError('Duplicate item ID');
    items.set(item.itemId, item);
  }
  for (const item of items.values()) {
    if (item.kind !== 'EQUIPMENT') continue;
    for (const materialId of [item.equipment.upgradeMaterialId, item.equipment.salvageMaterialId]) {
      if (items.get(materialId)?.kind !== 'MATERIAL') throw new RangeError('Equipment material must reference a declared stack material');
    }
  }
  const offerIds = new Set<string>();
  const offeredItems = new Set<string>();
  for (const offer of catalog.shopOffers as readonly ShopOffer[]) {
    exactKeys(offer, ['offerId', 'itemId', 'catalogVersion', 'priceCoins', 'minQuantity', 'maxQuantity']);
    id(offer.offerId, 'shop offer ID');
    id(offer.itemId, 'shop item ID');
    if (offer.catalogVersion !== catalog.version) throw new RangeError('Offer must use the item catalog version');
    integer(offer.priceCoins, 1, Number.MAX_SAFE_INTEGER, 'offer coin price');
    integer(offer.minQuantity, 1, MAX_PURCHASE_QUANTITY, 'minimum offer quantity');
    integer(offer.maxQuantity, offer.minQuantity, MAX_PURCHASE_QUANTITY, 'maximum offer quantity');
    if (!items.has(offer.itemId)) throw new RangeError('Shop offer refers to an unknown item');
    if (offerIds.has(offer.offerId) || offeredItems.has(offer.itemId)) throw new RangeError('Duplicate shop offer or offered item');
    offerIds.add(offer.offerId);
    offeredItems.add(offer.itemId);
  }
}

function freezeItem(item: ItemDefinition): ItemDefinition {
  if (item.kind === 'EQUIPMENT') {
    return Object.freeze({ ...item, equipment: Object.freeze({ ...item.equipment,
      baseBonus: Object.freeze({ ...item.equipment.baseBonus }),
      enhancementBonus: Object.freeze({ ...item.equipment.enhancementBonus }),
    }) });
  }
  if (item.kind === 'CONSUMABLE') return Object.freeze({ ...item, effect: Object.freeze({ ...item.effect }) });
  if (item.kind === 'GIFT') return Object.freeze({ ...item, effect: Object.freeze({ ...item.effect }) });
  return Object.freeze({ ...item });
}

/** Returns detached, deeply frozen definitions; callers cannot mutate prices,
 * effects or bonus stats through any alias into their authoring objects. */
export function defineItemCatalog(source: ItemCatalog): ItemCatalog {
  validateItemCatalog(source);
  return Object.freeze({ version: source.version,
    items: Object.freeze(source.items.map(freezeItem)),
    shopOffers: Object.freeze(source.shopOffers.map(offer => Object.freeze({ ...offer }))),
  });
}

const material = (itemId: string, displayName: string, description: string, rarity: EquipmentRarity = 'COMMON'): MaterialItemDefinition =>
  ({ itemId, displayName, description, rarity, kind: 'MATERIAL', storage: 'STACK', stackable: true });
const consumable = (itemId: string, displayName: string, description: string, effect: ConsumableEffect): ConsumableItemDefinition =>
  ({ itemId, displayName, description, rarity: 'COMMON', kind: 'CONSUMABLE', storage: 'STACK', stackable: true, effect });
const gift = (itemId: string, displayName: string, description: string, effect: GiftEffect): GiftItemDefinition =>
  ({ itemId, displayName, description, rarity: 'COMMON', kind: 'GIFT', storage: 'STACK', stackable: true, effect });
const stats = (hp = 0, atk = 0, def = 0, spd = 0, luk = 0): BattleStats => ({ hp, atk, def, spd, luk });
const equipment = (itemId: string, displayName: string, description: string, slot: EquipmentDefinition['slot'],
  rarity: EquipmentRarity, baseBonus: BattleStats, enhancementBonus: BattleStats,
  upgradeMaterialId: string, salvageMaterialId: string): EquipmentItemDefinition => ({
  itemId, displayName, description, rarity, kind: 'EQUIPMENT', storage: 'INSTANCE', stackable: false,
  equipment: { definitionId: itemId, slot, rarity, baseBonus, enhancementBonus, upgradeMaterialId, salvageMaterialId, maxEnhancement: MAX_ENHANCEMENT },
});
const offer = (itemId: string, priceCoins: number, maxQuantity: number): ShopOffer => ({
  offerId: `shop-${itemId}`, itemId, catalogVersion: ITEM_CATALOG_VERSION, priceCoins, minQuantity: 1, maxQuantity,
});

/** Starter content and the first three routes' reward identities. All effects,
 * equipment numbers and prices are V1 balance candidates; no I/O, inventory
 * mutation, real-currency transaction, automatic item use or item ID generation. */
export const ITEM_CATALOG = defineItemCatalog({
  version: ITEM_CATALOG_VERSION,
  items: [
    material('herb', '晨露草', '晨露草原产出的常见草药。'),
    material('slime-gel', '史莱姆凝胶', '史莱姆可能掉落的柔软凝胶。'),
    material('forest-wood', '林地木料', '林地采集所得的坚韧木材。'),
    material('ruin-shard', '遗迹碎片', '遗迹探索所得的神秘碎片。', 'UNCOMMON'),
    material('iron-ore', '铁矿石', '基础装备强化所需材料。'),
    material('iron-scrap', '铁屑', '回收基础装备时产出的材料。'),
    material('glimmer-dust', '微光尘', '微光凝聚而成的稀有强化材料。', 'UNCOMMON'),
    consumable('ration', '旅行口粮', '在家使用可恢复20点精力；路线准备也可要求口粮。', { kind: 'RESTORE_ENERGY', amount10: 200 }),
    consumable('healing-potion', '恢复药水', '在家使用可恢复25点健康；路线准备可单独配置用途。', { kind: 'RESTORE_HEALTH', amount10: 250 }),
    gift('sweet-biscuit', '甜甜饼干', '送给伙伴的小小点心。', { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: 40 }),
    gift('flower-bouquet', '晨花花束', '带有淡淡香气的花束。', { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 20, moodGain10: 60 }),
    equipment('apprentice-staff', '见习法杖', '适合初学魔法的轻巧法杖。', 'WEAPON', 'COMMON', stats(0, 4, 0, 0, 1), stats(0, 2, 0, 0, 1), 'iron-ore', 'iron-scrap'),
    equipment('forest-bow', '林地短弓', '便于在林地活动的轻弓。', 'WEAPON', 'COMMON', stats(0, 3, 0, 3, 0), stats(0, 1, 0, 1, 0), 'iron-ore', 'iron-scrap'),
    equipment('mechanical-tool', '机巧工具', '兼顾近身作业与防护的机巧装备。', 'WEAPON', 'COMMON', stats(0, 3, 2, 0, 0), stats(0, 1, 1, 0, 0), 'iron-ore', 'iron-scrap'),
    equipment('traveler-coat', '旅行外套', '保护旅行者免受轻微伤害的外套。', 'ARMOR', 'COMMON', stats(8, 0, 2), stats(3, 0, 1), 'iron-ore', 'iron-scrap'),
    equipment('guardian-vest', '守护背心', '具有较好防护的探索装备。', 'ARMOR', 'UNCOMMON', stats(16, 0, 4), stats(5, 0, 1), 'ruin-shard', 'iron-scrap'),
    equipment('lucky-charm', '幸运护符', '旅途中寄托好运的小饰品。', 'ACCESSORY', 'COMMON', stats(0, 0, 0, 0, 4), stats(0, 0, 0, 0, 1), 'iron-ore', 'iron-scrap'),
    equipment('glimmer-ring', '微光戒指', '铭刻了微光纹路的戒指。', 'ACCESSORY', 'UNCOMMON', stats(4, 2, 0, 0, 3), stats(2, 1, 0, 0, 1), 'glimmer-dust', 'glimmer-dust'),
  ],
  shopOffers: [
    offer('ration', 2, 20), offer('healing-potion', 4, 10),
    offer('sweet-biscuit', 3, 10), offer('flower-bouquet', 5, 10),
    offer('iron-ore', 3, 20), offer('glimmer-dust', 7, 10),
    offer('apprentice-staff', 12, 3), offer('forest-bow', 12, 3), offer('mechanical-tool', 14, 3),
    offer('traveler-coat', 10, 3), offer('guardian-vest', 18, 3),
    offer('lucky-charm', 9, 3), offer('glimmer-ring', 16, 3),
  ],
});

export const BUILTIN_ITEMS = ITEM_CATALOG.items;
export const SHOP_OFFERS = ITEM_CATALOG.shopOffers;

/** These lookups operate on a validated catalog, not user-supplied arbitrary files. */
export function findItemDefinition(itemId: string, catalog: ItemCatalog = ITEM_CATALOG): ItemDefinition | undefined {
  return catalog.items.find(item => item.itemId === itemId);
}

export function findShopOffer(offerId: string, catalog: ItemCatalog = ITEM_CATALOG): ShopOffer | undefined {
  return catalog.shopOffers.find(offer => offer.offerId === offerId);
}
