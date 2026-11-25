import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import {
  equipmentEquipPayloadSchema, equipmentSalvagePayloadSchema, equipmentUnequipPayloadSchema,
  equipmentUpgradePayloadSchema, inventoryLimits, inventoryQuerySchema, itemUsePayloadSchema, shopPurchasePayloadSchema,
} from '@pet-desktop/contracts/inventory';
import type {
  BattleStats, EquipmentEquipPayload, EquipmentRarity, EquipmentSalvagePayload, EquipmentSlot, EquipmentUnequipPayload,
  EquipmentUpgradePayload, InventoryEquipmentInstance, InventoryMaterialAmount, InventoryPage, InventoryStack,
  ItemDefinition, ItemUsePayload, ShopOffer, ShopPurchasePayload,
} from '@pet-desktop/contracts/inventory';

export interface StampedInventoryPage {
  readonly generation: number;
  readonly inventory: InventoryPage;
}

export const equipmentSlots = Object.freeze(['WEAPON', 'ARMOR', 'ACCESSORY'] as const);
export const slotLabel: Readonly<Record<EquipmentSlot, string>> = Object.freeze({ WEAPON: '武器', ARMOR: '防具', ACCESSORY: '饰品' });
export const rarityLabel: Readonly<Record<EquipmentRarity, string>> = Object.freeze({
  COMMON: '普通', UNCOMMON: '优良', RARE: '稀有', EPIC: '史诗', LEGENDARY: '传说',
});
export const itemKindLabel: Readonly<Record<ItemDefinition['kind'], string>> = Object.freeze({
  MATERIAL: '材料', CONSUMABLE: '消耗品', GIFT: '礼物', EQUIPMENT: '装备',
});

/** The inventory page is a supplemental projection, not a second wallet/pet
 * authority. Do not expose an actionable page when either is inconsistent. */
export function inventoryMatchesSnapshot(inventory: InventoryPage, snapshot: AppSnapshot): boolean {
  if (inventory.revision !== snapshot.revision || inventory.walletCoins !== snapshot.walletCoins
    || inventory.pets.length !== snapshot.pets.length) return false;
  const actualPets = new Map(snapshot.pets.map(pet => [pet.petId, pet]));
  if (actualPets.size !== snapshot.pets.length || new Set(inventory.pets.map(pet => pet.petId)).size !== inventory.pets.length) return false;
  return inventory.pets.every(pet => {
    const actual = actualPets.get(pet.petId);
    return actual?.characterId === pet.characterId && actual.nickname === pet.nickname
      && actual.level === pet.progression.level && actual.xp === pet.progression.cumulativeXp;
  });
}

export function usableInventoryPage(stamp: StampedInventoryPage | null, generation: number | null,
  snapshot: AppSnapshot | null, legacyOffset?: number): InventoryPage | null {
  return stamp && generation !== null && stamp.generation === generation && snapshot
    && (legacyOffset === undefined || stamp.inventory.legacyStackOffset === legacyOffset)
    && inventoryMatchesSnapshot(stamp.inventory, snapshot) ? stamp.inventory : null;
}

/** An ahead-of-push query may be retained awaiting the exact live snapshot.
 * Earlier or internally contradictory query responses may never be retained. */
export function inventoryQueryCanAccept(inventory: InventoryPage, returnedSnapshot: AppSnapshot,
  liveSnapshot: AppSnapshot | null, baseRevision: number, legacyOffset = inventory.legacyStackOffset): boolean {
  return liveSnapshot !== null && inventory.revision >= baseRevision && inventory.revision >= liveSnapshot.revision
    && inventory.legacyStackOffset === legacyOffset
    && inventoryMatchesSnapshot(inventory, returnedSnapshot)
    && (inventory.revision > liveSnapshot.revision || inventoryMatchesSnapshot(inventory, liveSnapshot));
}

export function legacyPageOffset(page: InventoryPage, direction: -1 | 1): number | undefined {
  const offset = page.legacyStackOffset + direction * inventoryLimits.legacyStackPage;
  return offset >= 0 && offset < page.legacyStackTotal && inventoryQuerySchema.safeParse({ legacyOffset: offset }).success
    ? offset : undefined;
}

export function itemDefinition(page: InventoryPage, itemId: string): ItemDefinition | undefined {
  return page.definitions.find(item => item.itemId === itemId);
}
/** Historical stack rows are not equipped instances, even if an old item ID
 * collides with a current definition. Never display a fabricated effect/name. */
export function stackDefinition(page: InventoryPage, stack: InventoryStack): Exclude<ItemDefinition, { kind: 'EQUIPMENT' }> | undefined {
  if (stack.definitionState !== 'AVAILABLE') return undefined;
  const definition = itemDefinition(page, stack.itemId);
  return definition?.storage === 'STACK' ? definition : undefined;
}
export function stockCount(page: InventoryPage, itemId: string): number {
  return page.stacks.find(row => row.itemId === itemId && row.definitionState === 'AVAILABLE')?.quantity ?? 0;
}
export function equippedPetName(page: InventoryPage, instance: InventoryEquipmentInstance): string {
  return instance.equipped ? page.pets.find(pet => pet.petId === instance.equipped?.petId)?.nickname ?? instance.equipped.petId : '未穿戴';
}

export function availableEquipmentDefinition(page: InventoryPage, instance: InventoryEquipmentInstance): Extract<ItemDefinition, { kind: 'EQUIPMENT' }> | undefined {
  if (instance.definitionState !== 'AVAILABLE' || instance.definitionVersion !== page.catalogVersion) return undefined;
  const item = itemDefinition(page, instance.definitionId);
  return item?.kind === 'EQUIPMENT' ? item : undefined;
}

/** Never borrow the current definition/name when an archived version is unknown. */
export function equipmentName(page: InventoryPage, instance: InventoryEquipmentInstance): string {
  return availableEquipmentDefinition(page, instance)?.displayName ?? `历史装备 ${instance.definitionId}（v${instance.definitionVersion}）`;
}
export function materialText(page: InventoryPage, amounts: readonly InventoryMaterialAmount[]): string {
  return amounts.map(({ itemId, quantity }) => `${itemDefinition(page, itemId)?.displayName ?? itemId} × ${quantity}`).join('、');
}
export function statsText(stats: BattleStats | null): string {
  return stats ? `HP ${stats.hp} · ATK ${stats.atk} · DEF ${stats.def} · SPD ${stats.spd} · LUK ${stats.luk}` : '历史属性不可用';
}
export function declaredEffectText(item: ItemDefinition): string {
  if (item.kind === 'CONSUMABLE') {
    return `目录效果：${item.effect.kind === 'RESTORE_ENERGY' ? '精力' : '健康'} +${item.effect.amount10 / 10} 点`;
  }
  if (item.kind === 'GIFT') return `目录效果：好感 +${item.effect.bondGain10 / 10} 点、心情 +${item.effect.moodGain10 / 10} 点`;
  return item.kind === 'EQUIPMENT' ? statsText(item.equipment.baseBonus) : '材料 · 无直接使用效果';
}
export function itemUseBlockReason(item: ItemDefinition, pet: PetSnapshot | undefined, availableQuantity: number): string | undefined {
  if (item.kind !== 'CONSUMABLE' && item.kind !== 'GIFT') return '此物品没有直接使用效果。';
  if (!pet) return '请选择一个已有角色。';
  if (availableQuantity < 1) return '库存数量不足。';
  if (pet.presence !== 'HOME') return '物品仅可对在家的角色使用。';
  if (pet.activity === 'CHAT' || pet.activity === 'DRAG') return '请先结束当前互动活动。';
  const wouldChange = item.kind === 'GIFT' ? pet.bond < 100 || pet.moodScore < 100 :
    item.effect.kind === 'RESTORE_ENERGY' ? pet.energy < 100 : pet.healthPoints < 100;
  if (!wouldChange) return '相关状态已经达到上限，无需消耗物品。';
  return undefined;
}

export function parsePurchaseQuantity(value: string, offer: ShopOffer): number | undefined {
  if (!/^[1-9]\d{0,2}$/u.test(value)) return undefined;
  const quantity = Number(value);
  return quantity >= offer.minQuantity && quantity <= offer.maxQuantity && quantity <= inventoryLimits.purchaseQuantity
    ? quantity : undefined;
}

/** Exact price multiplication, with no floating rounding or overflow. */
export function purchaseTotal(offer: ShopOffer, quantity: number): number | undefined {
  if (!Number.isSafeInteger(quantity) || quantity < offer.minQuantity || quantity > offer.maxQuantity
    || quantity > inventoryLimits.purchaseQuantity || !Number.isSafeInteger(offer.priceCoins) || offer.priceCoins <= 0) return undefined;
  const total = BigInt(offer.priceCoins) * BigInt(quantity);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : undefined;
}

export type InventoryOperation =
  | { readonly type: 'SHOP_PURCHASE'; readonly offerId: string; readonly quantity: number }
  | { readonly type: 'EQUIPMENT_EQUIP'; readonly petId: string; readonly instanceId: string }
  | { readonly type: 'EQUIPMENT_UNEQUIP'; readonly petId: string; readonly slot: EquipmentSlot }
  | { readonly type: 'EQUIPMENT_UPGRADE'; readonly instanceId: string }
  | { readonly type: 'EQUIPMENT_SALVAGE'; readonly instanceId: string }
  | { readonly type: 'ITEM_USE'; readonly petId: string; readonly itemId: string };

export type InventoryCommandIntent =
  | { readonly type: 'SHOP_PURCHASE'; readonly payload: ShopPurchasePayload }
  | { readonly type: 'EQUIPMENT_EQUIP'; readonly payload: EquipmentEquipPayload }
  | { readonly type: 'EQUIPMENT_UNEQUIP'; readonly payload: EquipmentUnequipPayload }
  | { readonly type: 'EQUIPMENT_UPGRADE'; readonly payload: EquipmentUpgradePayload }
  | { readonly type: 'EQUIPMENT_SALVAGE'; readonly payload: EquipmentSalvagePayload }
  | { readonly type: 'ITEM_USE'; readonly payload: ItemUsePayload };

export interface InventoryQuoteRow { readonly label: string; readonly value: string }
export interface InventoryConfirmationQuote {
  readonly generation: number;
  readonly revision: number;
  readonly catalogVersion: number;
  readonly operation: InventoryOperation;
  readonly title: string;
  readonly rows: readonly InventoryQuoteRow[];
  readonly warning: string;
  readonly confirmLabel: string;
  /** Exact ordered content shown plus source price/instance/loadout details. */
  readonly fingerprint: string;
}

interface Draft {
  readonly title: string;
  readonly rows: readonly InventoryQuoteRow[];
  readonly warning: string;
  readonly confirmLabel: string;
  readonly command: InventoryCommandIntent;
  readonly evidence: unknown;
}
const row = (label: string, value: string | number): InventoryQuoteRow => ({ label, value: String(value) });
const travelNote = (pet: PetSnapshot): string => pet.presence === 'HOME' ? ''
  : '该角色正在旅行。已冻结的本次旅程战斗输入不变，装备仅影响后续出发。';
const canReceiveStacks = (page: InventoryPage, amounts: readonly InventoryMaterialAmount[]): boolean => {
  let added = 0;
  for (const amount of amounts) {
    const held = page.stacks.find(stack => stack.itemId === amount.itemId && stack.definitionState === 'AVAILABLE');
    if (!held) added += 1;
    if (!Number.isSafeInteger((held?.quantity ?? 0) + amount.quantity)) return false;
  }
  return page.stacks.filter(stack => stack.definitionState === 'AVAILABLE').length + added <= inventoryLimits.stackCapacity;
};

function draftOperation(page: InventoryPage, snapshot: AppSnapshot, operation: InventoryOperation): Draft | undefined {
  const catalogVersion = page.catalogVersion;
  switch (operation.type) {
    case 'SHOP_PURCHASE': {
      const offer = page.offers.find(candidate => candidate.offerId === operation.offerId);
      if (!offer || offer.catalogVersion !== catalogVersion) return undefined;
      const item = itemDefinition(page, offer.itemId);
      if (!item) return undefined;
      const total = purchaseTotal(offer, operation.quantity);
      if (total === undefined || total > page.walletCoins) return undefined;
      const held = item.kind === 'EQUIPMENT'
        ? page.instances.filter(instance => instance.definitionId === item.itemId && instance.definitionVersion === catalogVersion).length
        : stockCount(page, item.itemId);
      if (item.kind === 'EQUIPMENT' ? page.instances.length + operation.quantity > inventoryLimits.instances
        : !canReceiveStacks(page, [{ itemId: item.itemId, quantity: operation.quantity }])) return undefined;
      const payload = shopPurchasePayloadSchema.safeParse({ offerId: offer.offerId, quantity: operation.quantity, catalogVersion });
      if (!payload.success) return undefined;
      return {
        title: `购买 ${item.displayName}`, confirmLabel: `确认支付 ${total} 游戏金币`,
        rows: [row('物品', item.displayName), row('单价', offer.priceCoins), row('购买数量', operation.quantity),
          row(item.kind === 'EQUIPMENT' ? '当前持有（本版本）' : '当前持有', held), row('总价', total), row('当前游戏金币', page.walletCoins),
          row('预计余额', page.walletCoins - total)],
        warning: item.kind === 'EQUIPMENT' ? '每件装备将由服务生成独立的 +0 实例。使用游戏金币，不涉及现实货币。'
          : '实际扣款与物品入库由本地服务原子确认。使用游戏金币，不涉及现实货币。',
        command: { type: 'SHOP_PURCHASE', payload: payload.data }, evidence: { offer, item, held, total },
      };
    }
    case 'EQUIPMENT_EQUIP': {
      const instance = page.instances.find(candidate => candidate.instanceId === operation.instanceId);
      const pet = page.pets.find(candidate => candidate.petId === operation.petId);
      const actual = snapshot.pets.find(candidate => candidate.petId === operation.petId);
      if (!instance || !pet || !actual || instance.equipped !== null) return undefined;
      const def = availableEquipmentDefinition(page, instance);
      if (!def || !instance.bonus) return undefined;
      const slot = def.equipment.slot;
      const occupied = pet.equipped.find(candidate => candidate.slot === slot);
      const replacing = occupied ? page.instances.find(candidate => candidate.instanceId === occupied.instanceId) : undefined;
      if (occupied && (!replacing || replacing.equipped?.petId !== pet.petId || replacing.equipped.slot !== slot)) return undefined;
      const payload = equipmentEquipPayloadSchema.safeParse({ petId: pet.petId, instanceId: instance.instanceId, slot, catalogVersion });
      if (!payload.success) return undefined;
      return {
        title: replacing ? '确认更换装备' : '确认穿戴装备', confirmLabel: replacing ? '确认替换' : '确认穿戴',
        rows: [row('角色', pet.nickname), row('角色实例', pet.petId), row('装备槽', slotLabel[slot]), row('新装备', `${def.displayName} +${instance.enhancement}`),
          row('新装备实例', instance.instanceId), row('属性加成', statsText(instance.bonus)),
          row('原装备', replacing ? `${equipmentName(page, replacing)} +${replacing.enhancement}` : '空槽位'),
          ...(replacing ? [row('原装备实例', replacing.instanceId)] : [])],
        warning: [replacing ? '原装备将卸下并保留在共享背包，不会销毁。' : '装备实例将归属此角色；不能被其他角色同时穿戴。', travelNote(actual)].join(' '),
        command: { type: 'EQUIPMENT_EQUIP', payload: payload.data },
        evidence: { pet, actual, instance, def, replacing: replacing ?? null },
      };
    }
    case 'EQUIPMENT_UNEQUIP': {
      const pet = page.pets.find(candidate => candidate.petId === operation.petId);
      const actual = snapshot.pets.find(candidate => candidate.petId === operation.petId);
      if (!pet || !actual || !equipmentSlots.includes(operation.slot)) return undefined;
      const worn = pet.equipped.find(candidate => candidate.slot === operation.slot);
      const instance = worn ? page.instances.find(candidate => candidate.instanceId === worn.instanceId) : undefined;
      if (!instance || instance.equipped?.petId !== pet.petId || instance.equipped.slot !== operation.slot) return undefined;
      const payload = equipmentUnequipPayloadSchema.safeParse({ petId: pet.petId, slot: operation.slot, catalogVersion });
      if (!payload.success) return undefined;
      return {
        title: '确认卸下装备', confirmLabel: '确认卸下',
        rows: [row('角色', pet.nickname), row('角色实例', pet.petId), row('槽位', slotLabel[operation.slot]),
          row('装备', `${equipmentName(page, instance)} +${instance.enhancement}`), row('装备实例', instance.instanceId)],
        warning: `卸下后该实例仍留在共享背包。 ${travelNote(actual)}`,
        command: { type: 'EQUIPMENT_UNEQUIP', payload: payload.data }, evidence: { actual, pet, instance },
      };
    }
    case 'EQUIPMENT_UPGRADE': {
      const instance = page.instances.find(candidate => candidate.instanceId === operation.instanceId);
      const def = instance && availableEquipmentDefinition(page, instance);
      if (!instance || !def || !instance.upgrade.ok || !instance.upgrade.affordable || !instance.bonus) return undefined;
      const upgrade = instance.upgrade;
      if (upgrade.fromEnhancement !== instance.enhancement || upgrade.toEnhancement !== instance.enhancement + 1
        || page.walletCoins < upgrade.cost.coins || upgrade.cost.materials.some(amount => stockCount(page, amount.itemId) < amount.quantity)) return undefined;
      const payload = equipmentUpgradePayloadSchema.safeParse({ instanceId: instance.instanceId,
        expectedEnhancement: instance.enhancement, catalogVersion });
      if (!payload.success) return undefined;
      const owner = instance.equipped ? snapshot.pets.find(pet => pet.petId === instance.equipped?.petId) : undefined;
      return {
        title: `强化 ${def.displayName}`, confirmLabel: `确认强化 +${upgrade.toEnhancement}`,
        rows: [row('装备实例', instance.instanceId), row('当前归属', equippedPetName(page, instance)),
          row('强化变化', `+${instance.enhancement} → +${upgrade.toEnhancement}`),
          row('当前属性', statsText(instance.bonus)), row('强化后属性', statsText(upgrade.newBonus)),
          row('金币费用', upgrade.cost.coins), row('材料费用', materialText(page, upgrade.cost.materials)),
          row('费用后余额', page.walletCoins - upgrade.cost.coins)],
        warning: `强化会消耗以上金币和材料，成本取自本地服务报价。 ${owner ? travelNote(owner) : ''}`,
        command: { type: 'EQUIPMENT_UPGRADE', payload: payload.data }, evidence: {
          def, instance, stocks: upgrade.cost.materials.map(amount => [amount.itemId, stockCount(page, amount.itemId)]), owner: owner ?? null,
        },
      };
    }
    case 'EQUIPMENT_SALVAGE': {
      const instance = page.instances.find(candidate => candidate.instanceId === operation.instanceId);
      const def = instance && availableEquipmentDefinition(page, instance);
      if (!instance || !def || instance.equipped !== null || !instance.salvage.canSalvage
        || !canReceiveStacks(page, instance.salvage.materials)) return undefined;
      const payload = equipmentSalvagePayloadSchema.safeParse({ instanceId: instance.instanceId,
        expectedEnhancement: instance.enhancement, catalogVersion });
      if (!payload.success) return undefined;
      return {
        title: `分解 ${def.displayName}`, confirmLabel: '确认永久分解',
        rows: [row('装备', `${def.displayName} +${instance.enhancement}`), row('装备实例', instance.instanceId),
          row('获得材料', materialText(page, instance.salvage.materials))],
        warning: '此操作会永久删除该装备实例，不可撤销。材料将由本地服务按实际分解报价入库。',
        command: { type: 'EQUIPMENT_SALVAGE', payload: payload.data }, evidence: {
          def, instance, stocks: instance.salvage.materials.map(amount => [amount.itemId, stockCount(page, amount.itemId)]),
        },
      };
    }
    case 'ITEM_USE': {
      const pet = page.pets.find(candidate => candidate.petId === operation.petId);
      const actual = snapshot.pets.find(candidate => candidate.petId === operation.petId);
      const stack = page.stacks.find(candidate => candidate.itemId === operation.itemId && candidate.definitionState === 'AVAILABLE');
      const item = itemDefinition(page, operation.itemId);
      if (!pet || !actual || !stack || (item?.kind !== 'CONSUMABLE' && item?.kind !== 'GIFT')
        || itemUseBlockReason(item, actual, stack.quantity) !== undefined) return undefined;
      const payload = itemUsePayloadSchema.safeParse({ petId: pet.petId, itemId: item.itemId, catalogVersion });
      if (!payload.success) return undefined;
      const currentNeeds = item.kind === 'CONSUMABLE'
        ? item.effect.kind === 'RESTORE_ENERGY' ? [row('当前精力', `${actual.energy} / 100`)] : [row('当前健康', `${actual.healthPoints} / 100`)]
        : [row('当前好感', `${actual.bond} / 100`), row('当前心情', `${actual.moodScore} / 100`)];
      return {
        title: `使用 ${item.displayName}`, confirmLabel: '确认消耗 1 件',
        rows: [row('目标角色', pet.nickname), row('目标角色实例', pet.petId), row('物品', item.displayName), row('声明效果', declaredEffectText(item)), ...currentNeeds,
          row('当前持有', stack.quantity), row('本次消耗', 1), row('预计剩余', stack.quantity - 1)],
        warning: '仅对在家的角色使用，消耗不可撤销。实际状态增量、可使用条件由本地服务按上限确认。',
        command: { type: 'ITEM_USE', payload: payload.data }, evidence: { actual, stack, item },
      };
    }
  }
}

function prepared(stamp: StampedInventoryPage | null, generation: number | null, snapshot: AppSnapshot | null,
  operation: InventoryOperation, allowCommands: boolean): { quote: InventoryConfirmationQuote; command: InventoryCommandIntent } | undefined {
  const page = usableInventoryPage(stamp, generation, snapshot);
  if (!page || generation === null || !snapshot || !allowCommands) return undefined;
  const draft = draftOperation(page, snapshot, operation);
  if (!draft) return undefined;
  const rows = Object.freeze([...draft.rows, row('目录版本', page.catalogVersion), row('游戏状态修订', page.revision)]
    .map(value => Object.freeze({ ...value })));
  const header = Object.freeze({ generation, revision: page.revision, catalogVersion: page.catalogVersion,
    operation: Object.freeze({ ...operation }), title: draft.title, rows, warning: draft.warning, confirmLabel: draft.confirmLabel });
  const fingerprint = JSON.stringify([header, page.walletCoins, draft.command, draft.evidence]);
  return { quote: Object.freeze({ ...header, fingerprint }), command: draft.command };
}

export function createInventoryQuote(stamp: StampedInventoryPage | null, generation: number | null,
  snapshot: AppSnapshot | null, operation: InventoryOperation, allowCommands: boolean): InventoryConfirmationQuote | undefined {
  return prepared(stamp, generation, snapshot, operation, allowCommands)?.quote;
}

/** Rebuild the quote from the current authoritative projection. A changed
 * revision, generation, price, balance, instance, slot or branch requires a
 * new explicit gesture, never a recomputed price sent without confirmation. */
export function confirmInventoryQuote(quote: InventoryConfirmationQuote, stamp: StampedInventoryPage | null,
  generation: number | null, snapshot: AppSnapshot | null, allowCommands: boolean): InventoryCommandIntent | undefined {
  const next = prepared(stamp, generation, snapshot, quote.operation, allowCommands);
  if (!next || next.quote.generation !== quote.generation || next.quote.revision !== quote.revision
    || next.quote.catalogVersion !== quote.catalogVersion || next.quote.fingerprint !== quote.fingerprint) return undefined;
  return next.command;
}
