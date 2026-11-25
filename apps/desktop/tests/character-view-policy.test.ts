import { describe, expect, it } from 'vitest';
import { characterCatalogPageSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, CharacterCatalogPage, CharacterCatalogRow, PetSnapshot } from '@pet-desktop/contracts';
import { CHARACTER_CATALOG, CHARACTER_CATALOG_VERSION } from '@pet-desktop/domain/character-catalog';
import { canOfferAcquisition, catalogMatchesSnapshot, confirmCharacterQuote, createCharacterQuote, prepareNicknameChange, usableCharacterCatalog } from '../src/renderer/shared/character-view-policy';
import type { NicknameDraft, StampedCharacterCatalog } from '../src/renderer/shared/character-view-policy';

const pet = (petId: string, characterId: string, nickname: string): PetSnapshot => ({
  petId, characterId, nickname, presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL',
  visibility: 'HIDDEN', moodScore: 80, healthPoints: 90, energy: 100, bond: 20, level: 1, xp: 0, revision: 2,
});
const first = pet('pet-1', 'star-singer', '星咏');
const second = pet('pet-2', 'fluffy-ranger', '绒绒');
const snapshot: AppSnapshot = { revision: 10, primaryPetId: first.petId, doNotDisturb: false, pausedRender: false,
  walletCoins: 18, pets: [first, second] };
const catalog: CharacterCatalogPage = characterCatalogPageSchema.parse({
  revision: snapshot.revision, catalogVersion: CHARACTER_CATALOG_VERSION, settledTrips: 3, walletCoins: snapshot.walletCoins,
  rows: CHARACTER_CATALOG.map(definition => ({ ...definition, availability: definition.characterId === 'nova' ? 'AVAILABLE' : 'ALREADY_OWNED',
    instances: snapshot.pets.filter(pet => pet.characterId === definition.characterId).map(pet => ({ petId: pet.petId, nickname: pet.nickname, origin: 'STARTER', acquiredAt: 1 })) })),
});
const stamp: StampedCharacterCatalog = { generation: 4, catalog };
const nova = catalog.rows.find(row => row.characterId === 'nova')!;
const withNova = (changes: Partial<CharacterCatalogRow>, page: CharacterCatalogPage = catalog): CharacterCatalogPage => ({
  ...page, rows: page.rows.map(row => row.characterId === 'nova' ? { ...row, ...changes } : row),
});

describe('Character catalog authority and explicit acquisition quotes', () => {
  it('uses the real catalog projection only when revision, wallet and actual owned instance IDs/nicknames agree', () => {
    expect(catalogMatchesSnapshot(catalog, snapshot)).toBe(true);
    expect(usableCharacterCatalog(stamp, 4, snapshot)).toBe(catalog);
    expect(usableCharacterCatalog(stamp, 3, snapshot)).toBeNull();
    expect(usableCharacterCatalog(stamp, null, snapshot)).toBeNull();
    expect(usableCharacterCatalog(stamp, 4, null)).toBeNull();
    expect(usableCharacterCatalog(stamp, 4, { ...snapshot, revision: 11 })).toBeNull();
    expect(usableCharacterCatalog(stamp, 4, { ...snapshot, walletCoins: 17 })).toBeNull();
    expect(usableCharacterCatalog(stamp, 4, { ...snapshot, pets: [first, { ...second, nickname: '改过的昵称' }] })).toBeNull();
    expect(usableCharacterCatalog(stamp, 4, { ...snapshot, pets: [first, { ...second, petId: 'other' }] })).toBeNull();
    // Historical unknown template remains an independent owned pet card.
    expect(usableCharacterCatalog(stamp, 4, { ...snapshot, pets: [...snapshot.pets, pet('legacy', 'retired-template', '旧伙伴')] })).toBe(catalog);
  });

  it('respects backend availability and refuses contradictory projected requirements or ownership', () => {
    expect(canOfferAcquisition(nova, catalog)).toBe(true);
    for (const availability of ['ALREADY_OWNED', 'CAPACITY_REACHED', 'UNMET_REQUIREMENT', 'INSUFFICIENT_COINS'] as const) {
      expect(canOfferAcquisition({ ...nova, availability }, catalog)).toBe(false);
    }
    expect(canOfferAcquisition(nova, { ...catalog, walletCoins: 15 })).toBe(false);
    expect(canOfferAcquisition(nova, { ...catalog, settledTrips: 2 })).toBe(false);
    expect(canOfferAcquisition({ ...nova, instances: [{ petId: 'pet-nova', nickname: '诺瓦', origin: 'GAME', acquiredAt: 5 }] }, catalog)).toBe(false);
    expect(createCharacterQuote(stamp, 4, snapshot, 'star-singer', true)).toBeUndefined();
    expect(createCharacterQuote(stamp, 4, snapshot, 'invented', true)).toBeUndefined();
    expect(createCharacterQuote(stamp, 4, snapshot, 'nova', false)).toBeUndefined();
  });

  it('quotes the actual Nova cost and exploration condition, then creates only a closed service command payload', () => {
    const quote = createCharacterQuote(stamp, 4, snapshot, 'nova', true);
    expect(quote).toMatchObject({ generation: 4, revision: 10, catalogVersion: CHARACTER_CATALOG_VERSION,
      characterId: 'nova', displayName: nova.displayName, coinCost: 16, walletCoins: 18, settledTrips: 3, requiredSettledTrips: 3, unlockKind: 'EXPLORATION_COINS' });
    expect(confirmCharacterQuote(quote!, stamp, 4, snapshot, true)).toEqual({ characterId: 'nova', catalogVersion: CHARACTER_CATALOG_VERSION });
    expect(snapshot.walletCoins).toBe(18); // no optimistic debit
    expect(snapshot.pets).toEqual([first, second]); // no fabricated instance
  });

  it('invalidates a previously confirmed price if generation, authority, version, cost, eligibility or data changed', () => {
    const quote = createCharacterQuote(stamp, 4, snapshot, 'nova', true)!;
    expect(confirmCharacterQuote(quote, stamp, 5, snapshot, true)).toBeUndefined();
    expect(confirmCharacterQuote(quote, stamp, 4, snapshot, false)).toBeUndefined();
    expect(confirmCharacterQuote(quote, { ...stamp, catalog: { ...catalog, catalogVersion: 2 } }, 4, snapshot, true)).toBeUndefined();
    expect(confirmCharacterQuote(quote, { ...stamp, catalog: withNova({ unlock: { kind: 'EXPLORATION_COINS', requiredSettledTrips: 3, coinCost: 17 } }) }, 4, snapshot, true)).toBeUndefined();
    expect(confirmCharacterQuote(quote, { ...stamp, catalog: withNova({ availability: 'CAPACITY_REACHED' }) }, 4, snapshot, true)).toBeUndefined();
    expect(confirmCharacterQuote(quote, { ...stamp, catalog: { ...catalog, settledTrips: 4 } }, 4, snapshot, true)).toBeUndefined();
    const refreshed = { ...snapshot, revision: 11, walletCoins: 19 };
    expect(confirmCharacterQuote(quote, { ...stamp, catalog: { ...catalog, revision: 11, walletCoins: 19 } }, 4, refreshed, true)).toBeUndefined();
  });
});

describe('Per-instance nickname draft confirmation', () => {
  const draft: NicknameDraft = { generation: 4, petId: first.petId, originalNickname: first.nickname, input: '  星辰  ' };
  it('normalizes the draft and targets exactly one stable pet ID without changing displayed data', () => {
    expect(prepareNicknameChange(draft, 4, snapshot, true)).toEqual({ ok: true, payload: { petId: first.petId, nickname: '星辰' } });
    expect(snapshot.pets[0]?.nickname).toBe('星咏');
    expect(snapshot.pets[1]?.nickname).toBe('绒绒');
    expect(prepareNicknameChange({ ...draft, input: ' e\u0301 ' }, 4, snapshot, true)).toEqual({ ok: true, payload: { petId: first.petId, nickname: 'é' } });
  });

  it('rejects whitespace, invalid format/control characters, overlength and unchanged names', () => {
    for (const input of ['  ', '星\n辰', '星\u202e辰', '字'.repeat(81)]) {
      expect(prepareNicknameChange({ ...draft, input }, 4, snapshot, true)).toEqual({ ok: false, reason: 'INVALID' });
    }
    expect(prepareNicknameChange({ ...draft, input: ' 星咏 ' }, 4, snapshot, true)).toEqual({ ok: false, reason: 'UNCHANGED' });
  });

  it('does not submit edited nicknames if the original instance changed, disappeared or service restarted', () => {
    expect(prepareNicknameChange(draft, 5, snapshot, true)).toEqual({ ok: false, reason: 'STALE' });
    expect(prepareNicknameChange(draft, 4, { ...snapshot, pets: [second] }, true)).toEqual({ ok: false, reason: 'STALE' });
    expect(prepareNicknameChange(draft, 4, { ...snapshot, pets: [{ ...first, nickname: '已重命名' }, second] }, true)).toEqual({ ok: false, reason: 'STALE' });
    expect(prepareNicknameChange(draft, 4, snapshot, false)).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });
});
