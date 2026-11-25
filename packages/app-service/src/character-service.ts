import { characterCatalogPageSchema } from '@pet-desktop/contracts';
import type { CharacterCatalogPage, OwnedCharacterInstance } from '@pet-desktop/contracts';
import {
  CHARACTER_CATALOG, CHARACTER_CATALOG_VERSION, evaluateCharacterAcquisition, findCharacterDefinition,
  normalizeCharacterNickname,
} from '@pet-desktop/domain/character-catalog';
import type { CharacterAcquisitionContext, CharacterDefinition } from '@pet-desktop/domain/character-catalog';
import type { AppTransaction, PetRecord } from './ports.js';

/** Turn a trusted character definition into a fresh independent instance. The
 * template is never mutated, and existing instances are never reset. */
export function createCharacterPet(definition: CharacterDefinition, petId: string, visibility: PetRecord['visibility']): PetRecord {
  return {
    petId, characterId: definition.characterId, nickname: normalizeCharacterNickname(definition.displayName),
    power: definition.basePower, presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL',
    visibility, moodScore10: 500, healthPoints10: 1000, energy10: 1000, bond10: 0, xp: 0, revision: 0,
  };
}

/** Fixed original starter instance IDs and defaults, only for an empty save. */
export function createStarterPets(): PetRecord[] {
  const star = findCharacterDefinition('star-singer');
  const fluffy = findCharacterDefinition('fluffy-ranger');
  if (!star || !fluffy || star.unlock.kind !== 'STARTER' || fluffy.unlock.kind !== 'STARTER') {
    throw new Error('Starter catalog definitions are missing');
  }
  return [createCharacterPet(star, 'pet-1', 'VISIBLE'), createCharacterPet(fluffy, 'pet-2', 'HIDDEN')];
}

/** Eligibility is derived from the current authoritative transaction, not from
 * the renderer's stale catalog projection or client-supplied currency. */
export function characterAcquisitionContext(tx: AppTransaction, pets: readonly PetRecord[] = tx.listPets()): CharacterAcquisitionContext {
  return {
    ownedCharacterIds: pets.map(pet => pet.characterId),
    settledTrips: tx.listTrips().filter(trip => trip.status === 'SETTLED').length,
    walletCoins: tx.getWalletCoins(),
  };
}

function ownedInstance(tx: AppTransaction, pet: PetRecord): OwnedCharacterInstance {
  const acquisition = tx.getPetAcquisition(pet.petId);
  if (acquisition === null) return { petId: pet.petId, nickname: pet.nickname, origin: 'LEGACY', acquiredAt: null };
  if (acquisition.petId !== pet.petId) throw new Error('Acquisition record belongs to another pet');
  const shared = { petId: pet.petId, nickname: pet.nickname, acquiredAt: acquisition.acquiredAt };
  return acquisition.origin === 'STARTER' ? { ...shared, origin: 'STARTER' } : { ...shared, origin: 'GAME' };
}

/** Catalog page and snapshot are projected inside the same transaction. Old
 * unknown templates continue to exist as normal pets in the snapshot; they
 * count toward acquisition capacity but cannot fabricate a catalog definition. */
export function projectCharacterCatalog(tx: AppTransaction, revision: number): CharacterCatalogPage {
  const pets = tx.listPets().sort((a, b) => a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0);
  const context = characterAcquisitionContext(tx, pets);
  const rows = CHARACTER_CATALOG.map(definition => {
    const decision = evaluateCharacterAcquisition(definition.characterId, context);
    if (!decision.ok && decision.reason === 'UNKNOWN_CHARACTER') throw new Error('Catalog definition cannot be evaluated');
    return {
      ...definition,
      instances: pets.filter(pet => pet.characterId === definition.characterId).map(pet => ownedInstance(tx, pet)),
      availability: decision.ok ? 'AVAILABLE' : decision.reason,
    };
  });
  return characterCatalogPageSchema.parse({ revision, catalogVersion: CHARACTER_CATALOG_VERSION,
    settledTrips: context.settledTrips, walletCoins: context.walletCoins, rows });
}
