import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = nonnegative.min(1);

/** V1 wire limits; changing these/cap semantics requires a coordinated
 * domain + repository + contract revision, not client-side truncation. */
export const inventoryLimits = Object.freeze({
  definitions: 256, stacks: 256, instances: 500, offers: 256, pets: 100,
  purchaseQuantity: 100, equipmentEnhancement: 5, maxLevel: 20,
  battleStat: 1_000_000, battlePower: 1_000, materialAmounts: 16,
});

export const itemCatalogVersionSchema = positive;
export const equipmentSlotSchema = z.enum(['WEAPON', 'ARMOR', 'ACCESSORY']);
export type EquipmentSlot = z.infer<typeof equipmentSlotSchema>;
export const equipmentRaritySchema = z.enum(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']);
export type EquipmentRarity = z.infer<typeof equipmentRaritySchema>;
export const enhancementSchema = nonnegative.max(inventoryLimits.equipmentEnhancement);

const stat = nonnegative.max(inventoryLimits.battleStat);
export const battleStatsSchema = z.strictObject({ hp: stat, atk: stat, def: stat, spd: stat, luk: stat });
export type BattleStats = z.infer<typeof battleStatsSchema>;
const statKeys = ['hp', 'atk', 'def', 'spd', 'luk'] as const;

export const equipmentDefinitionSchema = z.strictObject({
  definitionId: identifier,
  slot: equipmentSlotSchema,
  rarity: equipmentRaritySchema,
  baseBonus: battleStatsSchema,
  enhancementBonus: battleStatsSchema,
  upgradeMaterialId: identifier,
  salvageMaterialId: identifier,
  maxEnhancement: enhancementSchema.optional(),
}).superRefine((def, ctx) => {
  const cap = def.maxEnhancement ?? inventoryLimits.equipmentEnhancement;
  for (const key of statKeys) {
    if (def.baseBonus[key] + def.enhancementBonus[key] * cap > inventoryLimits.battleStat) {
      ctx.addIssue({ code: 'custom', path: ['enhancementBonus', key], message: 'Authored enhancement range exceeds stat limit' });
    }
  }
});
export type EquipmentDefinition = z.infer<typeof equipmentDefinitionSchema>;

/** Amounts are the same fixed-point tenths used by home needs, not battle HP
 * or a renderer-supplied requested stat change. */
const effectAmount = positive.max(1000);
export const consumableEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RESTORE_ENERGY'), amount10: effectAmount }),
  z.strictObject({ kind: z.literal('RESTORE_HEALTH'), amount10: effectAmount }),
]);
export type ConsumableEffect = z.infer<typeof consumableEffectSchema>;
export const giftEffectSchema = z.strictObject({ kind: z.literal('RAISE_BOND_AND_MOOD'),
  bondGain10: effectAmount, moodGain10: effectAmount });
export type GiftEffect = z.infer<typeof giftEffectSchema>;

const itemFields = {
  itemId: identifier,
  displayName: z.string().min(1).max(80).refine(text => text.trim().length > 0),
  description: z.string().min(1).max(512).refine(text => text.trim().length > 0),
  rarity: equipmentRaritySchema,
};
const stackStorage = { storage: z.literal('STACK'), stackable: z.literal(true) };
export const itemDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...itemFields, ...stackStorage, kind: z.literal('MATERIAL') }),
  z.strictObject({ ...itemFields, ...stackStorage, kind: z.literal('CONSUMABLE'), effect: consumableEffectSchema }),
  z.strictObject({ ...itemFields, ...stackStorage, kind: z.literal('GIFT'), effect: giftEffectSchema }),
  z.strictObject({ ...itemFields, kind: z.literal('EQUIPMENT'), storage: z.literal('INSTANCE'),
    stackable: z.literal(false), equipment: equipmentDefinitionSchema }),
]).superRefine((item, ctx) => {
  if (item.kind === 'EQUIPMENT' && (item.itemId !== item.equipment.definitionId || item.rarity !== item.equipment.rarity)) {
    ctx.addIssue({ code: 'custom', path: ['equipment'], message: 'Equipment identity and rarity must match the item definition' });
  }
});
export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;

export const shopOfferSchema = z.strictObject({
  offerId: identifier, itemId: identifier, catalogVersion: itemCatalogVersionSchema,
  priceCoins: positive, minQuantity: positive.max(inventoryLimits.purchaseQuantity), maxQuantity: positive.max(inventoryLimits.purchaseQuantity),
}).refine(offer => offer.minQuantity <= offer.maxQuantity, 'Offer minimum quantity exceeds maximum');
export type ShopOffer = z.infer<typeof shopOfferSchema>;

/** The old save schema already permits retained zero-quantity stack rows. An
 * unknown historical identity remains visible and cannot acquire an effect by
 * silently borrowing another definition. */
export const inventoryStackSchema = z.strictObject({
  itemId: identifier, quantity: nonnegative, definitionState: z.enum(['AVAILABLE', 'LEGACY_UNKNOWN']),
});
export type InventoryStack = z.infer<typeof inventoryStackSchema>;

const materialAmountSchema = z.strictObject({ itemId: identifier, quantity: positive });
export type InventoryMaterialAmount = z.infer<typeof materialAmountSchema>;
const materialAmountsSchema = z.array(materialAmountSchema).min(1).max(inventoryLimits.materialAmounts)
  .refine(rows => new Set(rows.map(row => row.itemId)).size === rows.length, 'Duplicate material quantity');
export const inventoryUpgradeQuoteSchema = z.union([
  z.strictObject({ ok: z.literal(true), fromEnhancement: enhancementSchema, toEnhancement: enhancementSchema,
    cost: z.strictObject({ coins: positive, materials: materialAmountsSchema }), newBonus: battleStatsSchema, affordable: z.boolean() })
    .refine(quote => quote.toEnhancement === quote.fromEnhancement + 1, 'Upgrade quote must advance one enhancement'),
  z.strictObject({ ok: z.literal(false), reason: z.literal('MAX_ENHANCEMENT'), maxEnhancement: enhancementSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('UNAVAILABLE') }),
]);
export type InventoryUpgradeQuote = z.infer<typeof inventoryUpgradeQuoteSchema>;

export const inventorySalvageQuoteSchema = z.union([
  z.strictObject({ materials: materialAmountsSchema, canSalvage: z.literal(true) }),
  z.strictObject({ materials: materialAmountsSchema, canSalvage: z.literal(false), reason: z.literal('EQUIPPED') }),
  z.strictObject({ materials: z.tuple([]), canSalvage: z.literal(false), reason: z.literal('UNAVAILABLE') }),
]);
export type InventorySalvageQuote = z.infer<typeof inventorySalvageQuoteSchema>;

export const inventoryEquippedOwnerSchema = z.strictObject({ petId: identifier, slot: equipmentSlotSchema });
export type InventoryEquippedOwner = z.infer<typeof inventoryEquippedOwnerSchema>;
export const inventoryEquipmentInstanceSchema = z.strictObject({
  instanceId: identifier, definitionId: identifier, definitionVersion: itemCatalogVersionSchema,
  enhancement: enhancementSchema, acquiredAt: nonnegative,
  equipped: inventoryEquippedOwnerSchema.nullable(),
  definitionState: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  bonus: battleStatsSchema.nullable(), upgrade: inventoryUpgradeQuoteSchema, salvage: inventorySalvageQuoteSchema,
}).superRefine((instance, ctx) => {
  if (instance.definitionState === 'UNAVAILABLE') {
    if (instance.bonus !== null || instance.upgrade.ok || instance.upgrade.reason !== 'UNAVAILABLE'
      || instance.salvage.canSalvage || instance.salvage.reason !== 'UNAVAILABLE') {
      ctx.addIssue({ code: 'custom', path: ['definitionState'], message: 'Unavailable history must not expose current bonuses or action quotes' });
    }
    return;
  }
  if (instance.bonus === null || (!instance.upgrade.ok && instance.upgrade.reason === 'UNAVAILABLE')
    || (!instance.salvage.canSalvage && instance.salvage.reason === 'UNAVAILABLE')) {
    ctx.addIssue({ code: 'custom', path: ['definitionState'], message: 'Available equipment must expose compatible bonuses and quotes' });
  }
  if (instance.upgrade.ok && instance.upgrade.fromEnhancement !== instance.enhancement) {
    ctx.addIssue({ code: 'custom', path: ['upgrade'], message: 'Upgrade quote does not match instance enhancement' });
  }
  if (!instance.upgrade.ok && instance.upgrade.reason === 'MAX_ENHANCEMENT' && instance.upgrade.maxEnhancement !== instance.enhancement) {
    ctx.addIssue({ code: 'custom', path: ['upgrade'], message: 'Instance is not at the quoted enhancement cap' });
  }
  if (instance.salvage.canSalvage !== (instance.equipped === null)) {
    ctx.addIssue({ code: 'custom', path: ['salvage'], message: 'Equipped instances cannot be salvaged before unequipping' });
  }
});
export type InventoryEquipmentInstance = z.infer<typeof inventoryEquipmentInstanceSchema>;

export const levelProgressionSchema = z.strictObject({
  level: positive.max(inventoryLimits.maxLevel), cumulativeXp: nonnegative, levelStartXp: nonnegative, xpInLevel: nonnegative,
  xpRequiredForNextLevel: positive.nullable(), xpRemainingToNextLevel: positive.nullable(),
}).superRefine((progression, ctx) => {
  if (progression.cumulativeXp < progression.levelStartXp
    || progression.xpInLevel !== progression.cumulativeXp - progression.levelStartXp
    || (progression.level === 1) !== (progression.levelStartXp === 0)) {
    ctx.addIssue({ code: 'custom', path: ['xpInLevel'], message: 'Contradictory cumulative and level XP' });
  }
  if (progression.level === inventoryLimits.maxLevel) {
    if (progression.xpRequiredForNextLevel !== null || progression.xpRemainingToNextLevel !== null) {
      ctx.addIssue({ code: 'custom', path: ['xpRequiredForNextLevel'], message: 'Capped level must have no next level cost' });
    }
  } else if (progression.xpRequiredForNextLevel === null || progression.xpRemainingToNextLevel === null
    || progression.xpInLevel >= progression.xpRequiredForNextLevel
    || progression.xpRequiredForNextLevel - progression.xpInLevel !== progression.xpRemainingToNextLevel) {
    ctx.addIssue({ code: 'custom', path: ['xpRemainingToNextLevel'], message: 'Next level XP contradicts current XP' });
  }
});
export type LevelProgression = z.infer<typeof levelProgressionSchema>;

export const inventoryLoadoutEntrySchema = z.strictObject({ slot: equipmentSlotSchema, instanceId: identifier });
export type InventoryLoadoutEntry = z.infer<typeof inventoryLoadoutEntrySchema>;
export const inventoryPetSchema = z.strictObject({
  petId: identifier, characterId: identifier, nickname: z.string().min(1).max(80),
  progression: levelProgressionSchema,
  stats: battleStatsSchema.refine(stats => stats.hp > 0, 'Pet battle HP must be positive').nullable(),
  battlePower: positive.max(inventoryLimits.battlePower), bondStage: nonnegative.max(3),
  equipped: z.array(inventoryLoadoutEntrySchema).max(3),
}).superRefine((pet, ctx) => {
  if (new Set(pet.equipped.map(entry => entry.slot)).size !== pet.equipped.length
    || new Set(pet.equipped.map(entry => entry.instanceId)).size !== pet.equipped.length) {
    ctx.addIssue({ code: 'custom', path: ['equipped'], message: 'Duplicate equipped slot or instance' });
  }
});
export type InventoryPet = z.infer<typeof inventoryPetSchema>;

function matchesBonus(actual: BattleStats | null, def: EquipmentDefinition, enhancement: number): boolean {
  return actual !== null && statKeys.every(key => actual[key] === def.baseBonus[key] + def.enhancementBonus[key] * enhancement);
}

/** Read-only coherent projections. The command service still re-evaluates
 * every version, ownership, affordability and gameplay restriction at commit. */
export const inventoryPageSchema = z.strictObject({
  revision: nonnegative, catalogVersion: itemCatalogVersionSchema, walletCoins: nonnegative,
  definitions: z.array(itemDefinitionSchema).max(inventoryLimits.definitions),
  stacks: z.array(inventoryStackSchema).max(inventoryLimits.stacks),
  instances: z.array(inventoryEquipmentInstanceSchema).max(inventoryLimits.instances),
  offers: z.array(shopOfferSchema).max(inventoryLimits.offers),
  pets: z.array(inventoryPetSchema).max(inventoryLimits.pets),
}).superRefine((page, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const definitions = new Map<string, ItemDefinition>();
  for (const [index, item] of page.definitions.entries()) {
    if (definitions.has(item.itemId)) issue(['definitions', index], 'Duplicate item definition');
    definitions.set(item.itemId, item);
  }
  const isMaterial = (id: string) => definitions.get(id)?.kind === 'MATERIAL';
  for (const [index, item] of page.definitions.entries()) {
    if (item.kind === 'EQUIPMENT' && (!isMaterial(item.equipment.upgradeMaterialId) || !isMaterial(item.equipment.salvageMaterialId))) {
      issue(['definitions', index, 'equipment'], 'Equipment must reference declared stack material definitions');
    }
  }
  const stacks = new Map<string, number>();
  for (const [index, stack] of page.stacks.entries()) {
    if (stacks.has(stack.itemId)) issue(['stacks', index], 'Duplicate held stack');
    stacks.set(stack.itemId, stack.quantity);
    const def = definitions.get(stack.itemId);
    if (def?.kind === 'EQUIPMENT' || stack.definitionState !== (def ? 'AVAILABLE' : 'LEGACY_UNKNOWN')) {
      issue(['stacks', index], 'Stack identity contradicts the item definition or legacy state');
    }
  }
  const offerIds = new Set<string>(), offeredItems = new Set<string>();
  for (const [index, offer] of page.offers.entries()) {
    if (offerIds.has(offer.offerId) || offeredItems.has(offer.itemId)) issue(['offers', index], 'Duplicate offer or offered item');
    offerIds.add(offer.offerId); offeredItems.add(offer.itemId);
    if (!definitions.has(offer.itemId) || offer.catalogVersion !== page.catalogVersion) {
      issue(['offers', index], 'Offer must match the current catalog definition and version');
    }
  }
  const pets = new Map<string, InventoryPet>();
  for (const [index, pet] of page.pets.entries()) {
    if (pets.has(pet.petId)) issue(['pets', index], 'Duplicate pet');
    pets.set(pet.petId, pet);
  }
  const instances = new Map<string, InventoryEquipmentInstance>();
  for (const [index, instance] of page.instances.entries()) {
    if (instances.has(instance.instanceId)) issue(['instances', index], 'Duplicate equipment instance');
    instances.set(instance.instanceId, instance);
    const item = definitions.get(instance.definitionId);
    const def = instance.definitionVersion === page.catalogVersion && item?.kind === 'EQUIPMENT' ? item.equipment : undefined;
    if (instance.definitionState !== (def !== undefined ? 'AVAILABLE' : 'UNAVAILABLE')) {
      issue(['instances', index, 'definitionState'], 'Historical equipment definition/version does not match the reported state');
    }
    if (def !== undefined) {
      const cap = def.maxEnhancement ?? inventoryLimits.equipmentEnhancement;
      if (instance.enhancement > cap || !matchesBonus(instance.bonus, def, instance.enhancement)) {
        issue(['instances', index, 'bonus'], 'Equipment bonus or enhancement contradicts its definition');
      }
      if (instance.equipped !== null && instance.equipped.slot !== def.slot) {
        issue(['instances', index, 'equipped'], 'Equipped slot contradicts the equipment definition');
      }
      if (instance.upgrade.ok) {
        if (instance.upgrade.toEnhancement > cap || !matchesBonus(instance.upgrade.newBonus, def, instance.upgrade.toEnhancement)) {
          issue(['instances', index, 'upgrade'], 'Upgrade target exceeds cap or has inconsistent bonus');
        }
        if (instance.upgrade.cost.materials.some(material => !isMaterial(material.itemId))
          || !instance.upgrade.cost.materials.some(material => material.itemId === def.upgradeMaterialId)) {
          issue(['instances', index, 'upgrade', 'cost'], 'Upgrade quote must use declared materials');
        }
        const affordable = page.walletCoins >= instance.upgrade.cost.coins
          && instance.upgrade.cost.materials.every(material => (stacks.get(material.itemId) ?? 0) >= material.quantity);
        if (instance.upgrade.affordable !== affordable) issue(['instances', index, 'upgrade', 'affordable'], 'Affordability contradicts wallet or stack balances');
      } else if (instance.upgrade.reason !== 'MAX_ENHANCEMENT' || instance.upgrade.maxEnhancement !== cap) {
        issue(['instances', index, 'upgrade'], 'Available equipment quote contradicts enhancement cap');
      }
      if (instance.salvage.materials.some(material => !isMaterial(material.itemId))
        || !instance.salvage.materials.some(material => material.itemId === def.salvageMaterialId)) {
        issue(['instances', index, 'salvage'], 'Salvage quote must reference declared materials');
      }
    }
    if (instance.equipped !== null) {
      const owner = pets.get(instance.equipped.petId);
      if (!owner?.equipped.some(entry => entry.instanceId === instance.instanceId && entry.slot === instance.equipped?.slot)) {
        issue(['instances', index, 'equipped'], 'Instance assignment is not present in its pet loadout');
      }
    }
  }
  for (const [index, pet] of page.pets.entries()) {
    for (const entry of pet.equipped) {
      const instance = instances.get(entry.instanceId);
      if (instance?.equipped?.petId !== pet.petId || instance.equipped.slot !== entry.slot) {
        issue(['pets', index, 'equipped'], 'Loadout references an absent or differently assigned instance');
      }
    }
  }
});
export type InventoryPage = z.infer<typeof inventoryPageSchema>;

/** A renderer states only intent + expected catalog/instance version. No
 * prices, generated IDs, grants, material costs, stat bonuses or file paths. */
export const shopPurchasePayloadSchema = z.strictObject({
  offerId: identifier, quantity: positive.max(inventoryLimits.purchaseQuantity), catalogVersion: itemCatalogVersionSchema,
});
export type ShopPurchasePayload = z.infer<typeof shopPurchasePayloadSchema>;
export const equipmentEquipPayloadSchema = z.strictObject({
  petId: identifier, instanceId: identifier, slot: equipmentSlotSchema, catalogVersion: itemCatalogVersionSchema,
});
export type EquipmentEquipPayload = z.infer<typeof equipmentEquipPayloadSchema>;
export const equipmentUnequipPayloadSchema = z.strictObject({ petId: identifier, slot: equipmentSlotSchema, catalogVersion: itemCatalogVersionSchema });
export type EquipmentUnequipPayload = z.infer<typeof equipmentUnequipPayloadSchema>;
export const equipmentUpgradePayloadSchema = z.strictObject({
  instanceId: identifier, expectedEnhancement: enhancementSchema, catalogVersion: itemCatalogVersionSchema,
});
export type EquipmentUpgradePayload = z.infer<typeof equipmentUpgradePayloadSchema>;
export const equipmentSalvagePayloadSchema = z.strictObject({
  instanceId: identifier, expectedEnhancement: enhancementSchema, catalogVersion: itemCatalogVersionSchema,
});
export type EquipmentSalvagePayload = z.infer<typeof equipmentSalvagePayloadSchema>;
export const itemUsePayloadSchema = z.strictObject({ petId: identifier, itemId: identifier, catalogVersion: itemCatalogVersionSchema });
export type ItemUsePayload = z.infer<typeof itemUsePayloadSchema>;
