import { describe, expect, it } from 'vitest';
import { characterCatalogPageSchema, charactersIpcResultSchema, domainCommandSchema, ipcRequestSchema, resultMatchesMethod } from '../src/index.js';

const stats = { hp: 80, atk: 15, def: 20, spd: 10, luk: 10 };
const definition = { characterId: 'nova', displayName: '诺瓦', species: '仿生机械人', profession: 'MECHANICAL_SUPPORT',
  professionLabel: '机械助手', background: '人形少女', personality: { summary: '认真', traits: ['可靠'], likes: ['整理'], speechStyle: '理性' },
  voiceStyleId: 'voice.nova', adventureFocus: ['守护'], basePower: 28, baseStats: stats, growthPerLevel: stats,
  unlock: { kind: 'EXPLORATION_COINS', requiredSettledTrips: 3, coinCost: 16 } };
const page = { revision: 4, catalogVersion: 1, settledTrips: 2, walletCoins: 24,
  rows: [{ ...definition, instances: [], availability: 'UNMET_REQUIREMENT' }] };
const snapshot = { revision: 4, primaryPetId: null, pets: [], walletCoins: 24, doNotDisturb: false, pausedRender: false };

describe('character catalog projection and transport', () => {
  it('uses a closed, bounded template catalog with truthful eligibility', () => {
    expect(characterCatalogPageSchema.parse(page)).toEqual(page);
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [{ ...page.rows[0], availability: 'AVAILABLE' }] }).success).toBe(false);
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [...page.rows, ...page.rows] }).success).toBe(false);
    expect(characterCatalogPageSchema.safeParse({ ...page, settledTrips: 3, walletCoins: 4,
      rows: [{ ...definition, instances: [], availability: 'INSUFFICIENT_COINS' }] }).success).toBe(true);
    expect(characterCatalogPageSchema.safeParse({ ...page, settledTrips: 3, rows: [{ ...definition, instances: [], availability: 'AVAILABLE' }] }).success).toBe(true);
  });

  it('requires explicit unknown dates for legacy instances and matching owned status', () => {
    const row = { ...definition, instances: [{ petId: 'pet-legacy', nickname: '旧角色', origin: 'LEGACY', acquiredAt: null }], availability: 'ALREADY_OWNED' };
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [row] }).success).toBe(true);
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [{ ...row, instances: [{ ...row.instances[0], acquiredAt: 1 }] }] }).success).toBe(false);
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [{ ...row, availability: 'AVAILABLE' }] }).success).toBe(false);
    expect(characterCatalogPageSchema.safeParse({ ...page, rows: [{ ...definition, instances: [], availability: 'ALREADY_OWNED' }] }).success).toBe(false);
  });

  it('binds the catalog to the same authority revision, wallet and instances', () => {
    const result = { schemaVersion: 1, ok: true, requestId: 'characters', snapshot, characters: page };
    const parsed = charactersIpcResultSchema.parse(result);
    expect(resultMatchesMethod('characters/list', parsed)).toBe(true);
    expect(resultMatchesMethod('gallery/list', parsed)).toBe(false);
    expect(resultMatchesMethod('snapshot/get', parsed)).toBe(false);
    expect(charactersIpcResultSchema.safeParse({ ...result, characters: { ...page, walletCoins: 100 } }).success).toBe(false);
    expect(charactersIpcResultSchema.safeParse({ ...result, characters: { ...page, revision: 3 } }).success).toBe(false);
    const fakeOwned = { ...definition, instances: [{ petId: 'fake', nickname: '虚构', origin: 'GAME', acquiredAt: 5 }], availability: 'ALREADY_OWNED' };
    expect(charactersIpcResultSchema.safeParse({ ...result, characters: { ...page, rows: [fakeOwned] } }).success).toBe(false);
  });

  it('restricts acquisition to versioned template intent, and rename to an instance nickname', () => {
    const common = { commandId: 'new-command', issuedAt: 10 };
    expect(ipcRequestSchema.safeParse({ schemaVersion: 1, requestId: 'characters', method: 'characters/list', payload: {} }).success).toBe(true);
    expect(ipcRequestSchema.safeParse({ schemaVersion: 1, requestId: 'characters', method: 'characters/list', payload: { characterId: 'nova' } }).success).toBe(false);
    const acquire = { ...common, type: 'PET_ACQUIRE', payload: { characterId: 'nova', catalogVersion: 1 } };
    expect(domainCommandSchema.safeParse(acquire).success).toBe(true);
    expect(domainCommandSchema.safeParse({ ...acquire, payload: { ...acquire.payload, coinCost: 0 } }).success).toBe(false);
    expect(domainCommandSchema.safeParse({ ...acquire, payload: { characterId: 'nova' } }).success).toBe(false);
    const rename = { ...common, type: 'PET_RENAME', payload: { petId: 'pet-1', nickname: '星夜' } };
    expect(domainCommandSchema.safeParse(rename).success).toBe(true);
    expect(domainCommandSchema.safeParse({ ...rename, payload: { ...rename.payload, nickname: 'a'.repeat(81) } }).success).toBe(false);
    expect(domainCommandSchema.safeParse({ ...rename, payload: { ...rename.payload, characterId: 'nova' } }).success).toBe(false);
  });
});
