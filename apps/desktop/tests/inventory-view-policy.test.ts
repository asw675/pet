import { describe, expect, it } from 'vitest';
import { appSnapshotSchema, domainCommandSchema } from '@pet-desktop/contracts';
import type { AppSnapshot } from '@pet-desktop/contracts';
import { inventoryLimits, inventoryPageSchema } from '@pet-desktop/contracts/inventory';
import type { BattleStats, InventoryEquipmentInstance, InventoryPage, InventoryPet, ItemDefinition, ShopOffer } from '@pet-desktop/contracts/inventory';
import {
  availableEquipmentDefinition, confirmInventoryQuote, createInventoryQuote, declaredEffectText, equipmentName,
  inventoryMatchesSnapshot, inventoryQueryCanAccept, itemUseBlockReason, legacyPageOffset,
  parsePurchaseQuantity, purchaseTotal, stackDefinition, stockCount, usableInventoryPage,
} from '../src/renderer/shared/inventory-view-policy';
import type { InventoryOperation, StampedInventoryPage } from '../src/renderer/shared/inventory-view-policy';

const stats = (hp = 0, atk = 0, def = 0, spd = 0, luk = 0): BattleStats => ({ hp, atk, def, spd, luk });
const ore = { itemId: 'iron-ore', displayName: '铁矿石', description: '强化素材', rarity: 'COMMON',
  kind: 'MATERIAL', storage: 'STACK', stackable: true } satisfies ItemDefinition;
const scrap = { ...ore, itemId: 'iron-scrap', displayName: '铁屑' } satisfies ItemDefinition;
const ration = { ...ore, itemId: 'ration', displayName: '旅行口粮', kind: 'CONSUMABLE',
  effect: { kind: 'RESTORE_ENERGY', amount10: 200 } } satisfies ItemDefinition;
const gift = { ...ore, itemId: 'sweet-biscuit', displayName: '饼干', kind: 'GIFT',
  effect: { kind: 'RAISE_BOND_AND_MOOD', bondGain10: 10, moodGain10: 40 } } satisfies ItemDefinition;
const staff = { itemId: 'apprentice-staff', displayName: '见习法杖', description: '基础魔法武器', rarity: 'COMMON',
  kind: 'EQUIPMENT', storage: 'INSTANCE', stackable: false,
  equipment: { definitionId: 'apprentice-staff', slot: 'WEAPON', rarity: 'COMMON', baseBonus: stats(0, 4, 0, 0, 1),
    enhancementBonus: stats(0, 2, 0, 0, 1), upgradeMaterialId: ore.itemId, salvageMaterialId: scrap.itemId, maxEnhancement: 5 },
} satisfies ItemDefinition;
const free = (instanceId: string, enhancement = 2): InventoryEquipmentInstance => ({
  instanceId, definitionId: staff.itemId, definitionVersion: 1, enhancement, acquiredAt: 123,
  equipped: null, definitionState: 'AVAILABLE', bonus: stats(0, 4 + enhancement * 2, 0, 0, 1 + enhancement),
  upgrade: enhancement < 5 ? { ok: true, fromEnhancement: enhancement, toEnhancement: enhancement + 1,
    cost: { coins: 30, materials: [{ itemId: ore.itemId, quantity: 2 }] },
    newBonus: stats(0, 6 + enhancement * 2, 0, 0, 2 + enhancement), affordable: true } : { ok: false, reason: 'MAX_ENHANCEMENT', maxEnhancement: 5 },
  salvage: { materials: [{ itemId: scrap.itemId, quantity: 2 }], canSalvage: true },
});
const equipped = (id: string, owner: string, enhancement = 1): InventoryEquipmentInstance => ({
  ...free(id, enhancement), equipped: { petId: owner, slot: 'WEAPON' },
  salvage: { materials: [{ itemId: scrap.itemId, quantity: 2 }], canSalvage: false, reason: 'EQUIPPED' },
});
const archived = { ...free('old-armor'), definitionId: 'retired-armor', definitionVersion: 1, definitionState: 'UNAVAILABLE',
  equipped: { petId: 'pet-b', slot: 'ARMOR' }, bonus: null, upgrade: { ok: false, reason: 'UNAVAILABLE' },
  salvage: { materials: [], canSalvage: false, reason: 'UNAVAILABLE' } } satisfies InventoryEquipmentInstance;
const pet = (petId: string, characterId: string, nickname: string, loadout: InventoryPet['equipped']): InventoryPet => ({
  petId, characterId, nickname, progression: { level: 1, cumulativeXp: 50, levelStartXp: 0, xpInLevel: 50,
    xpRequiredForNextLevel: 100, xpRemainingToNextLevel: 50 },
  stats: stats(75, 22, 12, 14, 16), battlePower: 30, bondStage: 0, equipped: loadout,
});

const page: InventoryPage = inventoryPageSchema.parse({
  revision: 4, catalogVersion: 1, walletCoins: 100, legacyStackOffset: 0, legacyStackTotal: 1,
  definitions: [ore, scrap, ration, gift, staff],
  stacks: [{ itemId: ore.itemId, quantity: 10, definitionState: 'AVAILABLE' },
    { itemId: ration.itemId, quantity: 3, definitionState: 'AVAILABLE' },
    { itemId: gift.itemId, quantity: 1, definitionState: 'AVAILABLE' },
    { itemId: 'legacy-stack', quantity: 2, definitionState: 'LEGACY_UNKNOWN' }],
  instances: [free('gear-free'), equipped('gear-star', 'pet-a'), equipped('gear-fluffy', 'pet-b'), archived],
  offers: [{ offerId: 'shop-ration', itemId: ration.itemId, catalogVersion: 1, priceCoins: 2, minQuantity: 1, maxQuantity: 20 },
    { offerId: 'shop-staff', itemId: staff.itemId, catalogVersion: 1, priceCoins: 12, minQuantity: 1, maxQuantity: 3 }],
  pets: [pet('pet-a', 'star-singer', '星咏', [{ slot: 'WEAPON', instanceId: 'gear-star' }]),
    pet('pet-b', 'fluffy-ranger', '绒绒', [{ slot: 'WEAPON', instanceId: 'gear-fluffy' }, { slot: 'ARMOR', instanceId: 'old-armor' }])],
});
const snapshot: AppSnapshot = appSnapshotSchema.parse({
  revision: page.revision, walletCoins: page.walletCoins, primaryPetId: 'pet-a', doNotDisturb: false, pausedRender: false,
  pets: page.pets.map((entry, i) => ({
    petId: entry.petId, characterId: entry.characterId, nickname: entry.nickname,
    presence: i === 0 ? 'HOME' : 'AWAY', activity: i === 0 ? 'IDLE' : null,
    mood: 'CALM', healthStatus: 'NORMAL', visibility: i === 0 ? 'VISIBLE' : 'HIDDEN',
    moodScore: 70, healthPoints: 100, energy: 80, bond: 10, level: 1, xp: 50, revision: 1,
    ...(i === 1 ? { trip: { tripId: 'trip-b', routeId: 'morning-dew-meadow', status: 'TRAVELING', expectedReturnAt: 10000 } } : {}),
  })),
});
const stamp: StampedInventoryPage = { generation: 2, inventory: page };
const q = (operation: InventoryOperation, view = stamp, live = snapshot, generation: number | null = 2, allow = true) =>
  createInventoryQuote(view, generation, live, operation, allow);
const confirm = (quote: NonNullable<ReturnType<typeof q>>, view = stamp, live = snapshot, generation: number | null = 2, allow = true) =>
  confirmInventoryQuote(quote, view, generation, live, allow);
const rowValue = (quote: NonNullable<ReturnType<typeof q>>, label: string) => quote.rows.find(row => row.label === label)?.value;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withPage = (inventory: InventoryPage): StampedInventoryPage => ({ generation: 2, inventory });

describe('inventory projection freshness and authority agreement', () => {
  it('only exposes actual inventory when same-revision snapshot wallet, every owned instance, names, level and XP agree', () => {
    expect(inventoryMatchesSnapshot(page, snapshot)).toBe(true);
    expect(usableInventoryPage(stamp, 2, snapshot)).toBe(page);
    expect(usableInventoryPage(stamp, 1, snapshot)).toBeNull();
    expect(usableInventoryPage(stamp, null, snapshot)).toBeNull();
    expect(usableInventoryPage(stamp, 2, null)).toBeNull();
    expect(usableInventoryPage(null, 2, snapshot)).toBeNull();
    for (const change of [{ revision: 5 }, { walletCoins: 99 }, { pets: snapshot.pets.slice(0, 1) }]) {
      expect(usableInventoryPage(stamp, 2, { ...snapshot, ...change })).toBeNull();
    }
    for (const change of [{ petId: 'different' }, { characterId: 'nova' }, { nickname: '假名' }, { level: 2 }, { xp: 51 }]) {
      expect(usableInventoryPage(stamp, 2, { ...snapshot, pets: [{ ...snapshot.pets[0]!, ...change }, snapshot.pets[1]!] })).toBeNull();
    }
  });

  it('fails closed during command/query loading, generation changes and a stale page after navigation', () => {
    const operation = { type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 } as const;
    expect(q(operation, stamp, snapshot, 2, false)).toBeUndefined();
    expect(q(operation, stamp, snapshot, null)).toBeUndefined();
    expect(q(operation, { ...stamp, generation: 1 })).toBeUndefined();
    expect(q(operation, stamp, { ...snapshot, revision: 5 })).toBeUndefined();
  });
  it('does not stamp a late query older than its starting revision or the live snapshot; ahead pages wait for exact authority', () => {
    expect(inventoryQueryCanAccept(page, snapshot, snapshot, 4)).toBe(true);
    expect(inventoryQueryCanAccept(page, snapshot, snapshot, 5)).toBe(false);
    expect(inventoryQueryCanAccept(page, snapshot, { ...snapshot, revision: 5 }, 4)).toBe(false);
    expect(inventoryQueryCanAccept(page, { ...snapshot, walletCoins: 105 }, snapshot, 4)).toBe(false);
    expect(inventoryQueryCanAccept(page, snapshot, { ...snapshot, walletCoins: 105 }, 4)).toBe(false);
    const ahead = { ...page, revision: 6 };
    const aheadSnapshot = { ...snapshot, revision: 6 };
    expect(inventoryQueryCanAccept(ahead, aheadSnapshot, snapshot, 4)).toBe(true);
    expect(usableInventoryPage(withPage(ahead), 2, snapshot)).toBeNull();
    expect(usableInventoryPage(withPage(ahead), 2, aheadSnapshot)).toBe(ahead);
    expect(inventoryQueryCanAccept(page, snapshot, snapshot, 4, 128)).toBe(false);
    expect(usableInventoryPage(stamp, 2, snapshot, 128)).toBeNull();
  });
  it('uses the true archive total for bounded next/previous offsets, never an omitted legacy row as stock', () => {
    const first = { ...page, legacyStackOffset: 0, legacyStackTotal: 257 };
    const middle = { ...first, legacyStackOffset: 128 };
    const last = { ...first, legacyStackOffset: 256 };
    expect(legacyPageOffset(first, -1)).toBeUndefined();
    expect(legacyPageOffset(first, 1)).toBe(128);
    expect(legacyPageOffset(middle, -1)).toBe(0);
    expect(legacyPageOffset(middle, 1)).toBe(256);
    expect(legacyPageOffset(last, 1)).toBeUndefined();
    expect(legacyPageOffset({ ...first, legacyStackOffset: 999936, legacyStackTotal: 2_000_000 }, 1)).toBeUndefined();
    const legacy = { itemId: staff.itemId, quantity: 3, definitionState: 'LEGACY_UNKNOWN' as const };
    const collision = inventoryPageSchema.parse({ ...page, legacyStackTotal: 2, stacks: [
      ...page.stacks.filter(stack => stack.definitionState === 'AVAILABLE'), legacy,
      ...page.stacks.filter(stack => stack.definitionState === 'LEGACY_UNKNOWN'),
    ] });
    expect(stackDefinition(collision, legacy)).toBeUndefined();
    expect(stockCount(collision, staff.itemId)).toBe(0);
    expect(q({ type: 'ITEM_USE', itemId: staff.itemId, petId: 'pet-a' }, withPage(collision))).toBeUndefined();
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-staff', quantity: 1 }, withPage(collision))).toBeDefined();
  });
});

describe('shop quote from actual offer, exact integer amount and explicit confirmation', () => {
  const offer = page.offers[0]!;
  it.each(['', '0', '-1', '1.2', '1e1', ' 1 ', '01', '21', '101'])('refuses malformed or out-of-range quantity %s', (text) => {
    expect(parsePurchaseQuantity(text, offer)).toBeUndefined();
  });
  it('accepts exact authorized boundaries and checks multiplication overflow before game-coin spend', () => {
    expect(parsePurchaseQuantity('1', offer)).toBe(1);
    expect(parsePurchaseQuantity('20', offer)).toBe(20);
    expect(purchaseTotal(offer, 20)).toBe(40);
    const huge: ShopOffer = { ...offer, priceCoins: Number.MAX_SAFE_INTEGER };
    expect(purchaseTotal(huge, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(purchaseTotal(huge, 2)).toBeUndefined();
    expect(purchaseTotal(offer, 1.5)).toBeUndefined();
  });
  it('shows the real unit price, quantity, actual wallet, held stock and total then sends only closed quantity intent', () => {
    const before = JSON.stringify([page, snapshot]);
    const quote = q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 2 })!;
    expect(quote).toMatchObject({ generation: 2, revision: 4, catalogVersion: 1, title: '购买 旅行口粮' });
    expect(rowValue(quote, '单价')).toBe('2');
    expect(rowValue(quote, '购买数量')).toBe('2');
    expect(rowValue(quote, '当前持有')).toBe('3');
    expect(rowValue(quote, '总价')).toBe('4');
    expect(rowValue(quote, '预计余额')).toBe('96');
    const command = confirm(quote);
    expect(command).toEqual({ type: 'SHOP_PURCHASE', payload: { offerId: 'shop-ration', quantity: 2, catalogVersion: 1 } });
    expect(domainCommandSchema.safeParse({ ...command, commandId: 'gesture', expectedRevision: quote.revision, issuedAt: 1 }).success).toBe(true);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.operation)).toBe(true);
    expect(quote.rows.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify([page, snapshot])).toBe(before);
  });
  it('quotes equipment purchases as separate +0 instances and checks shared inventory capacity', () => {
    const quote = q({ type: 'SHOP_PURCHASE', offerId: 'shop-staff', quantity: 2 })!;
    expect(quote.warning).toContain('独立的 +0 实例');
    expect(rowValue(quote, '总价')).toBe('24');
    const full = clone(page);
    full.instances = Array.from({ length: inventoryLimits.instances }, (_, i) => free(`gear-${i}`));
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-staff', quantity: 1 }, withPage(full))).toBeUndefined();
  });
  it('rejects unavailable offers, insufficient wallet and unsafe stack growth', () => {
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'missing', quantity: 1 })).toBeUndefined();
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-staff', quantity: 4 })).toBeUndefined();
    const walletLow = { ...page, walletCoins: 1 };
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 }, withPage(walletLow), { ...snapshot, walletCoins: 1 })).toBeUndefined();
    const large = { ...page, stacks: page.stacks.map(s => s.itemId === 'ration' ? { ...s, quantity: Number.MAX_SAFE_INTEGER } : s) };
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 }, withPage(large))).toBeUndefined();
  });
  it('calculates active stack capacity independently from paged archived rows', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) =>
      ({ itemId: `material-${i}`, quantity: 1, definitionState: 'AVAILABLE' as const }));
    const archive = Array.from({ length: inventoryLimits.legacyStackPage }, (_, i) =>
      ({ itemId: `legacy-${i}`, quantity: 1, definitionState: 'LEGACY_UNKNOWN' as const }));
    const nearCapacity = { ...page, stacks: [...rows(inventoryLimits.stackCapacity - 1), ...archive],
      legacyStackOffset: 0, legacyStackTotal: inventoryLimits.legacyStackPage };
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 }, withPage(nearCapacity))).toBeDefined();
    const full = { ...nearCapacity, stacks: [...rows(inventoryLimits.stackCapacity), ...archive] };
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 }, withPage(full))).toBeUndefined();
    expect(q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 }, withPage({ ...full,
      stacks: [{ itemId: 'ration', quantity: 1, definitionState: 'AVAILABLE' }, ...rows(inventoryLimits.stackCapacity - 1), ...archive] }))).toBeDefined();
  });
  it('cannot reuse a prior purchase confirmation if generation, revision, catalog, price, item, balance or quantity evidence changes', () => {
    const quote = q({ type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 2 })!;
    expect(confirm(quote, stamp, snapshot, 3)).toBeUndefined();
    expect(confirm(quote, stamp, snapshot, 2, false)).toBeUndefined();
    expect(confirm(quote, withPage({ ...page, revision: 5 }), { ...snapshot, revision: 5 })).toBeUndefined();
    expect(confirm(quote, withPage({ ...page, walletCoins: 110 }), { ...snapshot, walletCoins: 110 })).toBeUndefined();
    const offerChanged = { ...page, offers: page.offers.map(o => o.offerId === 'shop-ration' ? { ...o, priceCoins: 3 } : o) };
    expect(confirm(quote, withPage(offerChanged))).toBeUndefined();
    const catalogChanged = { ...page, catalogVersion: 2, offers: page.offers.map(o => ({ ...o, catalogVersion: 2 })) };
    expect(confirm(quote, withPage(catalogChanged))).toBeUndefined();
    const stockChanged = { ...page, stacks: page.stacks.map(s => s.itemId === 'ration' ? { ...s, quantity: 4 } : s) };
    expect(confirm(quote, withPage(stockChanged))).toBeUndefined();
    const forged = { ...quote, operation: { type: 'SHOP_PURCHASE', offerId: 'shop-ration', quantity: 1 } } as const;
    expect(confirm(forged)).toBeUndefined();
  });
});

describe('equipment and item gestures retain exact instance/owner, effect and authoritative cost', () => {
  it('makes replacement explicit with both original and intended distinct instances; only sends intended slot', () => {
    const quote = q({ type: 'EQUIPMENT_EQUIP', instanceId: 'gear-free', petId: 'pet-a' })!;
    expect(rowValue(quote, '角色')).toBe('星咏');
    expect(rowValue(quote, '装备槽')).toBe('武器');
    expect(rowValue(quote, '新装备实例')).toBe('gear-free');
    expect(rowValue(quote, '原装备实例')).toBe('gear-star');
    expect(quote.warning).toContain('不会销毁');
    expect(confirm(quote)).toEqual({ type: 'EQUIPMENT_EQUIP', payload: {
      petId: 'pet-a', instanceId: 'gear-free', slot: 'WEAPON', catalogVersion: 1,
    } });
    const changed = clone(page);
    changed.pets[0]!.equipped = [{ slot: 'WEAPON', instanceId: 'replacement-elsewhere' }];
    changed.instances = changed.instances.map(instance => instance.instanceId === 'gear-star' ? { ...instance, instanceId: 'replacement-elsewhere' } : instance);
    expect(confirm(quote, withPage(changed))).toBeUndefined();
  });
  it('never transfers an equipment instance currently worn by another pet, nor equips a missing or historical definition', () => {
    for (const instanceId of ['gear-star', 'gear-fluffy', 'old-armor', 'nonexistent']) {
      expect(q({ type: 'EQUIPMENT_EQUIP', instanceId, petId: 'pet-a' })).toBeUndefined();
    }
    expect(q({ type: 'EQUIPMENT_EQUIP', instanceId: 'gear-free', petId: 'missing' })).toBeUndefined();
  });
  it('permits next-trip equipment preparation for the current away pet without claiming to change frozen battle', () => {
    const quote = q({ type: 'EQUIPMENT_EQUIP', instanceId: 'gear-free', petId: 'pet-b' })!;
    expect(rowValue(quote, '角色')).toBe('绒绒');
    expect(quote.warning).toContain('已冻结的本次旅程战斗输入不变');
    expect(confirm(quote)).toEqual({ type: 'EQUIPMENT_EQUIP', payload: {
      petId: 'pet-b', instanceId: 'gear-free', slot: 'WEAPON', catalogVersion: 1,
    } });
  });
  it('unequips exact owner/slot (including an archived worn item) rather than silently deleting it', () => {
    const quote = q({ type: 'EQUIPMENT_UNEQUIP', petId: 'pet-b', slot: 'ARMOR' })!;
    expect(rowValue(quote, '装备实例')).toBe('old-armor');
    expect(rowValue(quote, '装备')).toContain('历史装备');
    expect(quote.warning).toContain('仍留在共享背包');
    expect(confirm(quote)).toEqual({ type: 'EQUIPMENT_UNEQUIP', payload: { petId: 'pet-b', slot: 'ARMOR', catalogVersion: 1 } });
    expect(q({ type: 'EQUIPMENT_UNEQUIP', petId: 'pet-a', slot: 'ARMOR' })).toBeUndefined();
  });
  it('quotes exactly the service-supplied upgrade bonus, price, material cost and target version, without computing local costs', () => {
    const quote = q({ type: 'EQUIPMENT_UPGRADE', instanceId: 'gear-free' })!;
    expect(rowValue(quote, '强化变化')).toBe('+2 → +3');
    expect(rowValue(quote, '强化后属性')).toContain('ATK 10');
    expect(rowValue(quote, '金币费用')).toBe('30');
    expect(rowValue(quote, '材料费用')).toBe('铁矿石 × 2');
    expect(confirm(quote)).toEqual({ type: 'EQUIPMENT_UPGRADE', payload: { instanceId: 'gear-free', expectedEnhancement: 2, catalogVersion: 1 } });
    const changed = clone(page);
    const instance = changed.instances[0]!;
    if (!instance.upgrade.ok) throw new Error('invalid fixture');
    instance.upgrade.cost.coins = 31;
    expect(confirm(quote, withPage(changed))).toBeUndefined();
    const advanced = { ...page, instances: page.instances.map(p => p.instanceId === 'gear-free' ? free('gear-free', 3) : p) };
    expect(confirm(quote, withPage(advanced))).toBeUndefined();
  });
  it('blocks max enhancement, unavailable history, unaffordable or contradictory stock quotes', () => {
    expect(q({ type: 'EQUIPMENT_UPGRADE', instanceId: 'old-armor' })).toBeUndefined();
    const cap = { ...page, instances: page.instances.map(p => p.instanceId === 'gear-free' ? free('gear-free', 5) : p) };
    expect(q({ type: 'EQUIPMENT_UPGRADE', instanceId: 'gear-free' }, withPage(cap))).toBeUndefined();
    const lowStock = { ...page, stacks: page.stacks.map(s => s.itemId === ore.itemId ? { ...s, quantity: 0 } : s) };
    expect(q({ type: 'EQUIPMENT_UPGRADE', instanceId: 'gear-free' }, withPage(lowStock))).toBeUndefined();
  });
  it('requires destruction confirmation for an unequipped exact instance and its actual material yield', () => {
    const quote = q({ type: 'EQUIPMENT_SALVAGE', instanceId: 'gear-free' })!;
    expect(quote.warning).toContain('永久删除');
    expect(rowValue(quote, '获得材料')).toBe('铁屑 × 2');
    expect(confirm(quote)).toEqual({ type: 'EQUIPMENT_SALVAGE', payload: { instanceId: 'gear-free', expectedEnhancement: 2, catalogVersion: 1 } });
    expect(q({ type: 'EQUIPMENT_SALVAGE', instanceId: 'gear-star' })).toBeUndefined();
    expect(q({ type: 'EQUIPMENT_SALVAGE', instanceId: 'old-armor' })).toBeUndefined();
    const changed = clone(page);
    changed.instances[0]!.salvage = { materials: [{ itemId: scrap.itemId, quantity: 3 }], canSalvage: true };
    expect(confirm(quote, withPage(changed))).toBeUndefined();
  });
  it('quotes explicit one-item home use from declared effects and shared stock, never sends stat delta or quantity', () => {
    const quote = q({ type: 'ITEM_USE', itemId: ration.itemId, petId: 'pet-a' })!;
    expect(rowValue(quote, '目标角色')).toBe('星咏');
    expect(rowValue(quote, '本次消耗')).toBe('1');
    expect(rowValue(quote, '预计剩余')).toBe('2');
    expect(rowValue(quote, '声明效果')).toContain('精力 +20');
    expect(rowValue(quote, '当前精力')).toBe('80 / 100');
    expect(confirm(quote)).toEqual({ type: 'ITEM_USE', payload: { petId: 'pet-a', itemId: ration.itemId, catalogVersion: 1 } });
    expect(declaredEffectText(gift)).toContain('好感 +1 点、心情 +4 点');
    expect(q({ type: 'ITEM_USE', itemId: gift.itemId, petId: 'pet-a' })).toBeDefined();
    for (const itemId of [ore.itemId, 'legacy-stack', 'nonexistent']) expect(q({ type: 'ITEM_USE', itemId, petId: 'pet-a' })).toBeUndefined();
    expect(q({ type: 'ITEM_USE', itemId: ration.itemId, petId: 'pet-b' })).toBeUndefined();
    const noRation = { ...page, stacks: page.stacks.map(s => s.itemId === ration.itemId ? { ...s, quantity: 0 } : s) };
    expect(q({ type: 'ITEM_USE', itemId: ration.itemId, petId: 'pet-a' }, withPage(noRation))).toBeUndefined();
  });
  it('does not propose a wasteful consumption or interruption while home activity is already blocked', () => {
    const actual = snapshot.pets[0]!;
    expect(itemUseBlockReason(ration, { ...actual, energy: 100 }, 1)).toContain('上限');
    for (const activity of ['CHAT', 'DRAG'] as const) {
      const busy = { ...snapshot, pets: [{ ...actual, activity }, snapshot.pets[1]!] };
      expect(q({ type: 'ITEM_USE', itemId: ration.itemId, petId: 'pet-a' }, stamp, busy)).toBeUndefined();
    }
    const full = { ...snapshot, pets: [{ ...actual, energy: 100, bond: 100, moodScore: 100 }, snapshot.pets[1]!] };
    expect(q({ type: 'ITEM_USE', itemId: ration.itemId, petId: 'pet-a' }, stamp, full)).toBeUndefined();
    expect(q({ type: 'ITEM_USE', itemId: gift.itemId, petId: 'pet-a' }, stamp, full)).toBeUndefined();
    const partlyFull = { ...snapshot, pets: [{ ...actual, bond: 100, moodScore: 99 }, snapshot.pets[1]!] };
    expect(q({ type: 'ITEM_USE', itemId: gift.itemId, petId: 'pet-a' }, stamp, partlyFull)).toBeDefined();
  });
  it('never borrows current definitions or bonuses for a mismatched historical equipment version', () => {
    const historical = { ...free('old-staff'), definitionVersion: 8, definitionState: 'UNAVAILABLE' as const, bonus: null,
      upgrade: { ok: false as const, reason: 'UNAVAILABLE' as const }, salvage: { materials: [] as [], canSalvage: false as const, reason: 'UNAVAILABLE' as const } };
    expect(availableEquipmentDefinition(page, historical)).toBeUndefined();
    expect(equipmentName(page, historical)).toBe('历史装备 apprentice-staff（v8）');
  });
});
