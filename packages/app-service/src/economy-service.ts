import { idSchema } from '@pet-desktop/contracts';
import type { DomainEvent, IpcErrorCode } from '@pet-desktop/contracts';
import { inventoryLimits, inventoryPageSchema } from '@pet-desktop/contracts/inventory';
import type {
  EquipmentEquipPayload, EquipmentSalvagePayload, EquipmentUnequipPayload, EquipmentUpgradePayload,
  InventoryEquipmentInstance, InventoryPage, InventoryPet, ItemUsePayload, ShopPurchasePayload,
} from '@pet-desktop/contracts/inventory';
import { findCharacterDefinition } from '@pet-desktop/domain/character-catalog';
import { quotePurchase } from '@pet-desktop/domain/commerce-rules';
import { computeEquipmentBonuses, equipmentBonus, EQUIPMENT_SLOTS, evaluateSalvage, evaluateUpgrade } from '@pet-desktop/domain/equipment-rules';
import type { EquippedInstance, EquipmentDefinition, MaterialAmount } from '@pet-desktop/domain/equipment-rules';
import { advanceHomeState, HOME_RULES } from '@pet-desktop/domain/home-simulation';
import { findItemDefinition, ITEM_CATALOG, ITEM_CATALOG_VERSION } from '@pet-desktop/domain/item-catalog';
import { bondStageForScore10, computeBattlePower, computeBattleStats, progressionForXp } from '@pet-desktop/domain/progression';
import type { AppTransaction, CommerceOperationRecord, ItemInstanceRecord, PetEquipmentRecord, PetRecord } from './ports.js';
import { applyHomeState, readHomeState, scheduleFromHome } from '#home-state-service';

type EconomyCommandBase = { readonly commandId: string };
export type EconomyCommand = EconomyCommandBase & (
  | { readonly type: 'SHOP_PURCHASE'; readonly payload: ShopPurchasePayload }
  | { readonly type: 'EQUIPMENT_EQUIP'; readonly payload: EquipmentEquipPayload }
  | { readonly type: 'EQUIPMENT_UNEQUIP'; readonly payload: EquipmentUnequipPayload }
  | { readonly type: 'EQUIPMENT_UPGRADE'; readonly payload: EquipmentUpgradePayload }
  | { readonly type: 'EQUIPMENT_SALVAGE'; readonly payload: EquipmentSalvagePayload }
  | { readonly type: 'ITEM_USE'; readonly payload: ItemUsePayload }
);

export type EconomyExecution =
  | { ok: false; error: { code: IpcErrorCode; message: string; retryable: boolean } }
  | { ok: true; affectedPetIds: readonly string[]; eventType: string; aggregateId: string; payload: DomainEvent['payload'] };

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function failure(code: IpcErrorCode, message: string, retryable = false): Extract<EconomyExecution, { ok: false }> {
  return { ok: false, error: { code, message, retryable } };
}

function matchingDefinition(instance: ItemInstanceRecord): EquipmentDefinition | undefined {
  if (instance.definitionVersion !== ITEM_CATALOG_VERSION) return undefined;
  const item = findItemDefinition(instance.definitionId);
  return item?.kind === 'EQUIPMENT' ? item.equipment : undefined;
}

function orderedBindings(bindings: readonly PetEquipmentRecord[]): PetEquipmentRecord[] {
  return [...bindings].sort((a, b) => EQUIPMENT_SLOTS.indexOf(a.slot) - EQUIPMENT_SLOTS.indexOf(b.slot) || compareIds(a.instanceId, b.instanceId));
}

/** Compute a new departure's actual power from current progression and
 * compatible equipped instances. Unsupported historical definitions never
 * borrow the current definition's bonus; an unknown character retains its
 * original persisted fallback power and exposes no fabricated battle stats. */
export function battleProjection(tx: AppTransaction, pet: PetRecord): InventoryPet {
  const progression = progressionForXp(pet.xp);
  const bindings = orderedBindings(tx.listPetEquipment(pet.petId));
  const loadout: EquippedInstance[] = [];
  for (const binding of bindings) {
    if (binding.petId !== pet.petId) throw new Error('Equipment binding belongs to another pet');
    const instance = tx.getItemInstance(binding.instanceId);
    if (!instance) throw new Error('Missing equipped instance');
    const definition = matchingDefinition(instance);
    if (definition) loadout.push({ instanceId: instance.instanceId, slot: binding.slot, definition, enhancement: instance.enhancement });
  }
  const bonus = computeEquipmentBonuses(loadout);
  const profile = findCharacterDefinition(pet.characterId);
  return { petId: pet.petId, characterId: pet.characterId, nickname: pet.nickname, progression,
    stats: profile ? computeBattleStats(profile, progression.level, bonus) : null,
    battlePower: profile ? computeBattlePower(profile, progression.level, bonus) : pet.power,
    bondStage: bondStageForScore10(pet.bond10), equipped: bindings.map(({ slot, instanceId }) => ({ slot, instanceId })) };
}

function materialRows(materials: readonly MaterialAmount[]): { itemId: string; quantity: number }[] {
  return materials.map(({ itemId, quantity }) => ({ itemId, quantity })).sort((a, b) => compareIds(a.itemId, b.itemId));
}

function hasMaterials(stacks: ReadonlyMap<string, number>, materials: readonly MaterialAmount[]): boolean {
  return materials.every(({ itemId, quantity }) => (stacks.get(itemId) ?? 0) >= quantity);
}

function projectInstance(tx: AppTransaction, instance: ItemInstanceRecord, stacks: ReadonlyMap<string, number>, wallet: number): InventoryEquipmentInstance {
  const owner = tx.getInstanceEquipment(instance.instanceId);
  const equipped = owner === null ? null : { petId: owner.petId, slot: owner.slot };
  const definition = matchingDefinition(instance);
  if (!definition) return { ...instance, equipped, definitionState: 'UNAVAILABLE', bonus: null,
    upgrade: { ok: false, reason: 'UNAVAILABLE' }, salvage: { materials: [], canSalvage: false, reason: 'UNAVAILABLE' } };
  const upgrade = evaluateUpgrade(definition, instance.enhancement);
  const salvage = materialRows(evaluateSalvage(definition, instance.enhancement).materials);
  return { ...instance, equipped, definitionState: 'AVAILABLE', bonus: equipmentBonus(definition, instance.enhancement),
    upgrade: upgrade.ok ? { ...upgrade, cost: { coins: upgrade.cost.coins, materials: materialRows(upgrade.cost.materials) },
      affordable: wallet >= upgrade.cost.coins && hasMaterials(stacks, upgrade.cost.materials) } : upgrade,
    salvage: equipped === null ? { materials: salvage, canSalvage: true } : { materials: salvage, canSalvage: false, reason: 'EQUIPPED' } };
}

/** Coherent, bounded authority projection. Historical unknown stack IDs are
 * retained as such, including a former stack whose stable ID now refers to
 * unique equipment. Every page keeps all current compatible stacks; only
 * the independently ordered historical archive is paginated. */
function isCompatibleStack(itemId: string): boolean {
  const item = findItemDefinition(itemId);
  return item !== undefined && item.kind !== 'EQUIPMENT';
}

export function projectInventory(tx: AppTransaction, revision: number, legacyOffset = 0): InventoryPage {
  const walletCoins = tx.getWalletCoins();
  const items = tx.listInventory().sort((a, b) => compareIds(a.itemId, b.itemId));
  const current = items.filter(item => isCompatibleStack(item.itemId));
  const legacy = items.filter(item => !isCompatibleStack(item.itemId));
  const stacks = new Map(current.map(({ itemId, quantity }) => [itemId, quantity]));
  return inventoryPageSchema.parse({ revision, catalogVersion: ITEM_CATALOG_VERSION, walletCoins,
    legacyStackOffset: legacyOffset, legacyStackTotal: legacy.length,
    definitions: [...ITEM_CATALOG.items], offers: [...ITEM_CATALOG.shopOffers],
    stacks: [...current.map(item => ({ ...item, definitionState: 'AVAILABLE' })),
      ...legacy.slice(legacyOffset, legacyOffset + inventoryLimits.legacyStackPage).map(item => ({ ...item, definitionState: 'LEGACY_UNKNOWN' }))],
    instances: tx.listItemInstances().sort((a, b) => compareIds(a.instanceId, b.instanceId)).map(instance => projectInstance(tx, instance, stacks, walletCoins)),
    pets: tx.listPets().sort((a, b) => compareIds(a.petId, b.petId)).map(pet => battleProjection(tx, pet)),
  });
}

/** All costs/output caps are checked before the first mutation. Business
 * rejections are persisted as failed command receipts, so they cannot leave
 * a half-applied debit. Unexpected write failures propagate and roll back. */
function canGrantStacks(stacks: ReadonlyMap<string, number>, additions: readonly MaterialAmount[]): boolean {
  let distinct = [...stacks.keys()].filter(isCompatibleStack).length;
  for (const { itemId, quantity } of additions) {
    if (!isCompatibleStack(itemId)) throw new Error('Cannot grant a historical/non-stack item using current commerce');
    const old = stacks.get(itemId);
    if (old === undefined) distinct++;
    if (quantity > Number.MAX_SAFE_INTEGER - (old ?? 0)) return false;
  }
  return distinct <= inventoryLimits.stackCapacity;
}

export function executeEconomyCommand(tx: AppTransaction, command: EconomyCommand, at: number, createItemId: () => string): EconomyExecution {
  const { catalogVersion } = command.payload;
  if (catalogVersion !== ITEM_CATALOG_VERSION) return failure('REVISION_CONFLICT', 'The item catalog has changed. Refresh it before continuing.', true);
  const base = { commandId: command.commandId, occurredAt: at, catalogVersion };
  const ownedStacks = () => new Map(tx.listInventory().map(({ itemId, quantity }) => [itemId, quantity]));
  const finish = (operation: CommerceOperationRecord, eventType: string, aggregateId: string,
    payload: DomainEvent['payload'], affectedPetIds: readonly string[] = []): EconomyExecution => {
    tx.insertCommerceOperation(operation);
    return { ok: true, eventType, aggregateId, payload, affectedPetIds };
  };

  switch (command.type) {
    case 'SHOP_PURCHASE': {
      const { offerId, quantity } = command.payload;
      const quote = quotePurchase(offerId, quantity, catalogVersion, tx.getWalletCoins());
      if (!quote.ok) {
        if (quote.reason === 'UNKNOWN_OFFER') return failure('NOT_FOUND', 'The shop offer does not exist.');
        if (quote.reason === 'STALE_CATALOG') return failure('REVISION_CONFLICT', 'The item catalog has changed.', true);
        if (quote.reason === 'INSUFFICIENT_COINS') return failure('BUSINESS_RULE', 'There are not enough in-game coins.');
        if (quote.reason === 'QUANTITY_LIMIT' || quote.reason === 'COST_OVERFLOW') return failure('BUSINESS_RULE', 'The quantity exceeds this offer or wallet limit.');
        throw new Error('Invalid authoritative shop quote');
      }
      const instances: ItemInstanceRecord[] = [];
      if (quote.output.kind === 'STACK') {
        if (!canGrantStacks(ownedStacks(), [quote.output])) return failure('BUSINESS_RULE', 'The inventory stack capacity has been reached.');
      } else {
        if (tx.listItemInstances().length + quantity > inventoryLimits.instances) return failure('BUSINESS_RULE', 'The equipment capacity has been reached.');
        const allocated = new Set<string>();
        for (let i = 0; i < quantity; i++) {
          const instanceId = idSchema.parse(createItemId());
          if (allocated.has(instanceId) || tx.getItemInstance(instanceId) !== null) throw new Error('Generated equipment instance ID already exists');
          allocated.add(instanceId);
          instances.push({ instanceId, definitionId: quote.output.definitionId, definitionVersion: catalogVersion, enhancement: 0, acquiredAt: at });
        }
      }
      tx.setWalletCoins(quote.remainingWalletCoins);
      if (quote.output.kind === 'STACK') tx.addInventory(quote.output.itemId, quote.output.quantity);
      else for (const instance of instances) tx.insertItemInstance(instance);
      return finish({ ...base, type: command.type, offerId, itemId: quote.itemId, quantity, coinCost: quote.totalCoins,
        outputKind: quote.output.kind, instanceIds: instances.map(instance => instance.instanceId).sort(compareIds) },
      'ShopPurchased', 'inventory', { offerId, itemId: quote.itemId, quantity, coinCost: quote.totalCoins, outputKind: quote.output.kind });
    }
    case 'EQUIPMENT_EQUIP': {
      const { petId, slot, instanceId } = command.payload;
      if (tx.getPet(petId) === null) return failure('NOT_FOUND', 'The pet does not exist.');
      const instance = tx.getItemInstance(instanceId);
      if (instance === null) return failure('NOT_FOUND', 'The equipment instance does not exist.');
      const definition = matchingDefinition(instance);
      if (!definition) return failure('BUSINESS_RULE', 'The historical equipment definition is unavailable.');
      if (definition.slot !== slot) return failure('BUSINESS_RULE', 'The equipment does not match this slot.');
      const existingOwner = tx.getInstanceEquipment(instanceId);
      if (existingOwner !== null) return failure('BUSINESS_RULE', existingOwner.petId === petId && existingOwner.slot === slot
        ? 'This equipment is already in the selected slot.' : 'Unequip the equipment from its current owner before transferring it.');
      const previous = tx.getPetEquipment(petId, slot);
      if (previous !== null) tx.unequipItem(petId, slot, previous.instanceId);
      tx.equipItem({ petId, slot, instanceId });
      return finish({ ...base, type: command.type, petId, slot, instanceId, previousInstanceId: previous?.instanceId ?? null },
        'EquipmentEquipped', petId, { petId, slot, instanceId, previousInstanceId: previous?.instanceId ?? null }, [petId]);
    }
    case 'EQUIPMENT_UNEQUIP': {
      const { petId, slot } = command.payload;
      if (tx.getPet(petId) === null) return failure('NOT_FOUND', 'The pet does not exist.');
      const equipped = tx.getPetEquipment(petId, slot);
      if (equipped === null) return failure('BUSINESS_RULE', 'This equipment slot is already empty.');
      // Unequip does not need to interpret a possibly unavailable old definition.
      tx.unequipItem(petId, slot, equipped.instanceId);
      return finish({ ...base, type: command.type, petId, slot, instanceId: equipped.instanceId },
        'EquipmentUnequipped', petId, { petId, slot, instanceId: equipped.instanceId }, [petId]);
    }
    case 'EQUIPMENT_UPGRADE': {
      const { instanceId, expectedEnhancement } = command.payload;
      const instance = tx.getItemInstance(instanceId);
      if (instance === null) return failure('NOT_FOUND', 'The equipment instance does not exist.');
      if (instance.enhancement !== expectedEnhancement) return failure('REVISION_CONFLICT', 'The equipment enhancement has changed.', true);
      const definition = matchingDefinition(instance);
      if (!definition) return failure('BUSINESS_RULE', 'The historical equipment definition is unavailable.');
      const quote = evaluateUpgrade(definition, instance.enhancement);
      if (!quote.ok) return failure('BUSINESS_RULE', 'The equipment enhancement limit has been reached.');
      const wallet = tx.getWalletCoins();
      const materials = materialRows(quote.cost.materials);
      if (wallet < quote.cost.coins || !hasMaterials(ownedStacks(), materials)) return failure('BUSINESS_RULE', 'There are not enough coins or upgrade materials.');
      const owner = tx.getInstanceEquipment(instanceId);
      tx.setWalletCoins(wallet - quote.cost.coins);
      for (const material of materials) tx.addInventory(material.itemId, -material.quantity);
      const upgraded = tx.upgradeItemInstance(instanceId, expectedEnhancement);
      if (upgraded.enhancement !== quote.toEnhancement) throw new Error('Equipment upgrade disagrees with authoritative quote');
      return finish({ ...base, type: command.type, instanceId, fromEnhancement: expectedEnhancement, toEnhancement: upgraded.enhancement,
        coinCost: quote.cost.coins, materials }, 'EquipmentUpgraded', instanceId,
        { instanceId, fromEnhancement: expectedEnhancement, toEnhancement: upgraded.enhancement, coinCost: quote.cost.coins }, owner ? [owner.petId] : []);
    }
    case 'EQUIPMENT_SALVAGE': {
      const { instanceId, expectedEnhancement } = command.payload;
      const instance = tx.getItemInstance(instanceId);
      if (instance === null) return failure('NOT_FOUND', 'The equipment instance does not exist.');
      if (instance.enhancement !== expectedEnhancement) return failure('REVISION_CONFLICT', 'The equipment enhancement has changed.', true);
      const definition = matchingDefinition(instance);
      if (!definition) return failure('BUSINESS_RULE', 'The historical equipment definition is unavailable.');
      if (tx.getInstanceEquipment(instanceId) !== null) return failure('BUSINESS_RULE', 'Unequip the equipment before salvaging it.');
      const materials = materialRows(evaluateSalvage(definition, instance.enhancement).materials);
      if (!canGrantStacks(ownedStacks(), materials)) return failure('BUSINESS_RULE', 'The inventory stack capacity has been reached.');
      tx.deleteItemInstance(instanceId);
      for (const material of materials) tx.addInventory(material.itemId, material.quantity);
      return finish({ ...base, type: command.type, instanceId, enhancement: instance.enhancement, materials },
        'EquipmentSalvaged', instanceId, { instanceId, enhancement: instance.enhancement });
    }
    case 'ITEM_USE': {
      const { petId, itemId } = command.payload;
      const pet = tx.getPet(petId);
      if (pet === null) return failure('NOT_FOUND', 'The pet does not exist.');
      if (pet.presence !== 'HOME') return failure('BUSINESS_RULE', 'The pet must be home to receive this item.');
      const definition = findItemDefinition(itemId);
      if (!definition || (definition.kind !== 'CONSUMABLE' && definition.kind !== 'GIFT')) return failure('BUSINESS_RULE', 'This item cannot be used by a pet.');
      if ((ownedStacks().get(itemId) ?? 0) < 1) return failure('BUSINESS_RULE', 'The item is not in the inventory.');
      const home = advanceHomeState(readHomeState(tx, pet, at), at);
      if (home.activity === 'CHAT' || home.activity === 'DRAG') return failure('BUSINESS_RULE', 'Finish the current activity before using an item.');
      let { energy10, healthPoints10, bond10, moodScore10 } = home;
      if (definition.kind === 'GIFT') {
        bond10 = Math.min(1000, bond10 + definition.effect.bondGain10);
        moodScore10 = Math.min(1000, moodScore10 + definition.effect.moodGain10);
      } else if (definition.effect.kind === 'RESTORE_ENERGY') {
        energy10 = Math.min(1000, energy10 + definition.effect.amount10);
      } else {
        healthPoints10 = Math.min(1000, healthPoints10 + definition.effect.amount10);
      }
      if (home.energy10 === energy10 && home.healthPoints10 === healthPoints10 && home.bond10 === bond10 && home.moodScore10 === moodScore10) {
        return failure('BUSINESS_RULE', 'The item would not change the pet’s current needs.');
      }
      const activityDueAt = at + Math.min(HOME_RULES.eatDurationMs, Number.MAX_SAFE_INTEGER - at);
      const next = advanceHomeState({ ...home, energy10, healthPoints10, bond10, moodScore10,
        energyRemainder: energy10 === 1000 ? 0 : home.energyRemainder,
        healthRemainder: healthPoints10 === 1000 ? 0 : home.healthRemainder,
        moodRemainder: moodScore10 === home.moodScore10 ? home.moodRemainder : 0,
        activity: 'EAT', activityDueAt,
      }, at);
      tx.addInventory(itemId, -1);
      tx.savePet(applyHomeState(pet, next));
      tx.saveHomeSchedule(scheduleFromHome(next));
      return finish({ ...base, type: command.type, petId, itemId }, 'ItemUsed', petId, { petId, itemId }, [petId]);
    }
  }
}
