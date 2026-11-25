import { petAcquirePayloadSchema, petRenamePayloadSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, CharacterCatalogPage, CharacterCatalogRow, PetAcquirePayload, PetRenamePayload } from '@pet-desktop/contracts';
import { normalizeCharacterNickname } from '@pet-desktop/domain/character-catalog';

export interface StampedCharacterCatalog {
  readonly generation: number;
  readonly catalog: CharacterCatalogPage;
}

/** A character DTO is not a second ownership authority. Check its displayed
 * instances against the same-revision snapshot, including canonical names.
 * Legacy pets with no current template remain valid owned instances. */
export function catalogMatchesSnapshot(catalog: CharacterCatalogPage, snapshot: AppSnapshot): boolean {
  if (catalog.revision !== snapshot.revision || catalog.walletCoins !== snapshot.walletCoins) return false;
  return catalog.rows.every(row => {
    const matching = snapshot.pets.filter(pet => pet.characterId === row.characterId);
    return matching.length === row.instances.length && row.instances.every(instance =>
      matching.some(pet => pet.petId === instance.petId && pet.nickname === instance.nickname));
  });
}

export function usableCharacterCatalog(stamp: StampedCharacterCatalog | null, generation: number | null, snapshot: AppSnapshot | null): CharacterCatalogPage | null {
  return stamp && generation !== null && stamp.generation === generation && snapshot
    && catalogMatchesSnapshot(stamp.catalog, snapshot) ? stamp.catalog : null;
}

export function characterCoinCost(row: CharacterCatalogRow): number {
  return row.unlock.kind === 'EXPLORATION_COINS' ? row.unlock.coinCost : 0;
}

/** Availability comes from the authoritative acquisition projection. These
 * extra coherence checks only disable an inconsistent confirmation, never
 * grant eligibility or execute a purchase in the renderer. */
export function canOfferAcquisition(row: CharacterCatalogRow, catalog: CharacterCatalogPage): boolean {
  return row.availability === 'AVAILABLE' && row.instances.length === 0 && catalog.walletCoins >= characterCoinCost(row)
    && (row.unlock.kind !== 'EXPLORATION_COINS' || catalog.settledTrips >= row.unlock.requiredSettledTrips);
}

export type CharacterAcquisitionQuote = Readonly<{
  generation: number;
  revision: number;
  catalogVersion: number;
  characterId: string;
  displayName: string;
  coinCost: number;
  walletCoins: number;
  settledTrips: number;
  requiredSettledTrips: number;
  unlockKind: CharacterCatalogRow['unlock']['kind'];
}>;

export function createCharacterQuote(stamp: StampedCharacterCatalog | null, generation: number | null, snapshot: AppSnapshot | null,
  characterId: string, allowCommands: boolean): CharacterAcquisitionQuote | undefined {
  const catalog = usableCharacterCatalog(stamp, generation, snapshot);
  if (generation === null || !catalog || !allowCommands) return undefined;
  const row = catalog.rows.find(candidate => candidate.characterId === characterId);
  if (!row || !canOfferAcquisition(row, catalog)) return undefined;
  return Object.freeze({ generation, revision: catalog.revision, catalogVersion: catalog.catalogVersion,
    characterId: row.characterId, displayName: row.displayName, coinCost: characterCoinCost(row), walletCoins: catalog.walletCoins,
    settledTrips: catalog.settledTrips, requiredSettledTrips: row.unlock.kind === 'EXPLORATION_COINS' ? row.unlock.requiredSettledTrips : 0,
    unlockKind: row.unlock.kind });
}

export function confirmCharacterQuote(quote: CharacterAcquisitionQuote, stamp: StampedCharacterCatalog | null, generation: number | null,
  snapshot: AppSnapshot | null, allowCommands: boolean): PetAcquirePayload | undefined {
  const current = createCharacterQuote(stamp, generation, snapshot, quote.characterId, allowCommands);
  if (!current || current.generation !== quote.generation || current.revision !== quote.revision
    || current.catalogVersion !== quote.catalogVersion || current.characterId !== quote.characterId
    || current.displayName !== quote.displayName || current.coinCost !== quote.coinCost || current.walletCoins !== quote.walletCoins
    || current.settledTrips !== quote.settledTrips || current.requiredSettledTrips !== quote.requiredSettledTrips
    || current.unlockKind !== quote.unlockKind) return undefined;
  // Actual debit, capacity, catalog version and expectedRevision are checked
  // transactionally by the app service; no local wallet changes.
  return petAcquirePayloadSchema.parse({ characterId: quote.characterId, catalogVersion: quote.catalogVersion });
}

export interface NicknameDraft {
  readonly generation: number;
  readonly petId: string;
  readonly originalNickname: string;
  readonly input: string;
}
export type NicknameDecision = { readonly ok: true; readonly payload: PetRenamePayload }
  | { readonly ok: false; readonly reason: 'STALE' | 'INVALID' | 'UNCHANGED' | 'UNAVAILABLE' };

/** Validate the draft against its exact original instance and authority
 * generation. Use the same pure nickname normalizer as the service for UX. */
export function prepareNicknameChange(draft: NicknameDraft, generation: number | null, snapshot: AppSnapshot | null,
  allowCommands: boolean): NicknameDecision {
  if (!allowCommands || generation === null || !snapshot) return { ok: false, reason: 'UNAVAILABLE' };
  const pet = snapshot.pets.find(candidate => candidate.petId === draft.petId);
  if (draft.generation !== generation || !pet || pet.nickname !== draft.originalNickname) return { ok: false, reason: 'STALE' };
  try {
    const nickname = normalizeCharacterNickname(draft.input);
    if (nickname === pet.nickname) return { ok: false, reason: 'UNCHANGED' };
    return { ok: true, payload: petRenamePayloadSchema.parse({ petId: pet.petId, nickname }) };
  } catch {
    return { ok: false, reason: 'INVALID' };
  }
}
