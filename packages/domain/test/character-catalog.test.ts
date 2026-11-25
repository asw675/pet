import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CATALOG, CHARACTER_CATALOG_VERSION, MAX_CHARACTER_NICKNAME_LENGTH, MAX_INSTANCES_PER_CHARACTER,
  MAX_OWNED_PETS, STARTER_CHARACTER_IDS, evaluateCharacterAcquisition, findCharacterDefinition,
  isValidCharacterNickname, normalizeCharacterNickname, type CharacterAcquisitionContext,
} from '../src/character-catalog.js';
import { DEMO_ROUTE } from '../src/index.js';

const starters = ['star-singer', 'fluffy-ranger'];
const eligible: CharacterAcquisitionContext = { ownedCharacterIds: starters, settledTrips: 3, walletCoins: 16 };
const definition = (id: string) => {
  const result = findCharacterDefinition(id);
  if (result === undefined) throw new Error(`Missing character fixture ${id}`);
  return result;
};

describe('original, immutable heroine character definitions', () => {
  it('retains stable existing template IDs, names and POC starter power, with Nova separately locked', () => {
    expect(CHARACTER_CATALOG_VERSION).toBe(1);
    expect(CHARACTER_CATALOG.map(c => [c.characterId,c.displayName,c.basePower])).toEqual([
      ['star-singer','星咏',30], ['fluffy-ranger','绒绒',25], ['nova','诺瓦',28],
    ]);
    expect(STARTER_CHARACTER_IDS).toEqual(starters);
    expect(definition('star-singer').unlock).toEqual({ kind:'STARTER' });
    expect(definition('fluffy-ranger').unlock).toEqual({ kind:'STARTER' });
    expect(definition('nova').unlock).toEqual({ kind:'EXPLORATION_COINS',requiredSettledTrips:3,coinCost:16 });
  });

  it('uses explicitly humanoid original heroines and distinct profession/personality/voice style metadata', () => {
    const mage = definition('star-singer'), ranger = definition('fluffy-ranger'), nova = definition('nova');
    expect([mage.species,ranger.species,nova.species]).toEqual(['魔族','人类','仿生机械人']);
    expect(mage.background).toContain('绯粉长发');
    expect(ranger.background).toContain('人形少女');
    expect(nova.background).toContain('人形少女');
    expect(new Set(CHARACTER_CATALOG.map(c => c.profession)).size).toBe(3);
    expect(new Set(CHARACTER_CATALOG.map(c => c.voiceStyleId)).size).toBe(3);
    expect(new Set(CHARACTER_CATALOG.map(c => c.personality.summary)).size).toBe(3);
    for (const c of CHARACTER_CATALOG) {
      expect(c.voiceStyleId).toMatch(/^voice\.[a-z0-9.-]+$/u);
      expect(c.personality.speechStyle.length).toBeGreaterThan(0);
      expect(c.personality.traits.length).toBeGreaterThanOrEqual(2);
      expect(c.personality.likes.length).toBeGreaterThanOrEqual(2);
      expect(c.adventureFocus.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('provides real specialization: mage attack, ranger speed/luck, mechanical defense and health', () => {
    const mage = definition('star-singer'), ranger = definition('fluffy-ranger'), nova = definition('nova');
    expect(mage.baseStats.atk).toBeGreaterThan(Math.max(ranger.baseStats.atk,nova.baseStats.atk));
    expect(ranger.baseStats.spd).toBeGreaterThan(Math.max(mage.baseStats.spd,nova.baseStats.spd));
    expect(ranger.baseStats.luk).toBeGreaterThan(Math.max(mage.baseStats.luk,nova.baseStats.luk));
    expect(nova.baseStats.hp).toBeGreaterThan(Math.max(mage.baseStats.hp,ranger.baseStats.hp));
    expect(nova.baseStats.def).toBeGreaterThan(Math.max(mage.baseStats.def,ranger.baseStats.def));
    expect(mage.growthPerLevel.atk).toBeGreaterThan(ranger.growthPerLevel.atk);
    expect(ranger.growthPerLevel.spd).toBeGreaterThan(mage.growthPerLevel.spd);
    expect(nova.growthPerLevel.def).toBeGreaterThan(mage.growthPerLevel.def);
    for (const c of CHARACTER_CATALOG) {
      expect(Object.keys(c.baseStats)).toEqual(['hp','atk','def','spd','luk']);
      expect(Object.keys(c.growthPerLevel)).toEqual(['hp','atk','def','spd','luk']);
      expect([...Object.values(c.baseStats),...Object.values(c.growthPerLevel)].every(v => Number.isSafeInteger(v) && v > 0)).toBe(true);
    }
  });

  it('deep-freezes catalog and nested profile, personality, unlock and trait collections', () => {
    expect(Object.isFrozen(CHARACTER_CATALOG)).toBe(true);
    expect(Object.isFrozen(STARTER_CHARACTER_IDS)).toBe(true);
    for (const c of CHARACTER_CATALOG) {
      expect([c,c.personality,c.personality.traits,c.personality.likes,c.adventureFocus,c.baseStats,c.growthPerLevel,c.unlock].every(Object.isFrozen)).toBe(true);
      expect(findCharacterDefinition(c.characterId)).toBe(c);
    }
    expect(() => Object.assign(definition('star-singer').baseStats,{ atk:999 })).toThrow();
    expect(definition('star-singer').baseStats.atk).toBe(22);
  });

  it('does not confuse instance IDs or prototype keys with templates', () => {
    for (const id of ['pet-1','STAR-SINGER','Star-singer','nova ','constructor','__proto__','toString','unknown']) {
      expect(findCharacterDefinition(id)).toBeUndefined();
    }
  });
});

describe('pure character acquisition gate', () => {
  it('accepts missing starters without a paid/unlock gate', () => {
    const fresh = { ownedCharacterIds:[], settledTrips:0, walletCoins:0 } as const;
    for (const id of starters) expect(evaluateCharacterAcquisition(id,fresh)).toEqual({ ok:true,definition:definition(id),coinCost:0 });
  });

  it('requires Nova exploration first and coin balance second, accepting exact boundaries', () => {
    expect(evaluateCharacterAcquisition('nova',{...eligible,settledTrips:2,walletCoins:1000})).toEqual({
      ok:false,reason:'UNMET_REQUIREMENT',settledTrips:2,requiredSettledTrips:3,
    });
    expect(evaluateCharacterAcquisition('nova',{...eligible,settledTrips:3,walletCoins:15})).toEqual({
      ok:false,reason:'INSUFFICIENT_COINS',walletCoins:15,coinCost:16,
    });
    expect(evaluateCharacterAcquisition('nova',eligible)).toEqual({ ok:true, definition:definition('nova'),coinCost:16 });
    expect(evaluateCharacterAcquisition('nova',{...eligible,settledTrips:20,walletCoins:200})).toEqual({ ok:true,definition:definition('nova'),coinCost:16 });
  });

  it('makes Nova attainable from ordinary completed travel and current in-game coin rewards', () => {
    const winCoins = DEMO_ROUTE.nodes.reduce((sum,node) => sum+(node.kind === 'BATTLE' ? node.winCoins : 0),0);
    expect(winCoins).toBe(8);
    const twoVictoriesAndOneOtherTrip = { ownedCharacterIds:starters, settledTrips:3, walletCoins:2*winCoins };
    expect(evaluateCharacterAcquisition('nova',twoVictoriesAndOneOtherTrip)).toMatchObject({ ok:true, coinCost:16 });
  });

  it('reports unknown templates before all other product restrictions', () => {
    const full = { ownedCharacterIds:Array.from({length:MAX_OWNED_PETS},(_,i)=>`old-${i}`), settledTrips:0,walletCoins:0 };
    expect(evaluateCharacterAcquisition('does-not-exist',full)).toEqual({ok:false,reason:'UNKNOWN_CHARACTER'});
  });

  it('enforces V1 one instance per known template before capacity or prerequisites', () => {
    expect(MAX_INSTANCES_PER_CHARACTER).toBe(1);
    const full = { ownedCharacterIds:['nova','nova',...Array.from({length:98},(_,i)=>`old-${i}`)],settledTrips:0,walletCoins:0 };
    expect(evaluateCharacterAcquisition('nova',full)).toEqual({ok:false,reason:'ALREADY_OWNED',ownedInstances:2,maxInstances:1});
    expect(evaluateCharacterAcquisition('star-singer',eligible)).toEqual({ok:false,reason:'ALREADY_OWNED',ownedInstances:1,maxInstances:1});
  });

  it('counts every stored instance and old/unknown template toward the 100 pet capacity', () => {
    expect(MAX_OWNED_PETS).toBe(100);
    const almost = Array.from({length:99},(_,i)=>`old-${i}`);
    expect(evaluateCharacterAcquisition('nova',{...eligible,ownedCharacterIds:almost})).toMatchObject({ok:true});
    const full = [...almost,'old-99'];
    expect(evaluateCharacterAcquisition('nova',{ownedCharacterIds:full,settledTrips:0,walletCoins:0})).toEqual({
      ok:false,reason:'CAPACITY_REACHED',ownedPets:100,maxPets:100,
    });
    expect(evaluateCharacterAcquisition('star-singer',{...eligible,ownedCharacterIds:[...full,'old-100']})).toEqual({
      ok:false,reason:'CAPACITY_REACHED',ownedPets:101,maxPets:100,
    });
  });

  it('keeps unmet exploration ahead of insufficient currency when both conditions fail', () => {
    expect(evaluateCharacterAcquisition('nova',{...eligible,settledTrips:0,walletCoins:0})).toMatchObject({ ok:false,reason:'UNMET_REQUIREMENT' });
  });

  it('returns deterministic decisions and never debits or rewrites supplied authoritative context', () => {
    const ctx = Object.freeze({ ownedCharacterIds:Object.freeze([...starters]),settledTrips:3,walletCoins:16 });
    const before = JSON.stringify(ctx);
    for (let i=0;i<100;i++) expect(evaluateCharacterAcquisition('nova',ctx)).toEqual(evaluateCharacterAcquisition('nova',ctx));
    expect(JSON.stringify(ctx)).toBe(before);
  });

  it.each([-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('rejects corrupt counters %s instead of treating them as a player action', (n) => {
    expect(() => evaluateCharacterAcquisition('nova',{...eligible,settledTrips:n})).toThrow(RangeError);
    expect(() => evaluateCharacterAcquisition('nova',{...eligible,walletCoins:n})).toThrow(RangeError);
  });

  it('rejects invalid or sparse authoritative instance identities', () => {
    for (const ownedCharacterIds of [[''],['with space'],['星咏'],new Array<string>(1)]) {
      expect(() => evaluateCharacterAcquisition('nova',{...eligible,ownedCharacterIds})).toThrow(RangeError);
    }
  });
});

describe('nickname normalization independently of stable template IDs', () => {
  it('accepts Chinese and ordinary Unicode/emoji, trims whitespace and composes NFC', () => {
    expect(normalizeCharacterNickname('  星咏 ✨  ')).toBe('星咏 ✨');
    expect(normalizeCharacterNickname('\u3000绒绒\u3000')).toBe('绒绒');
    expect(normalizeCharacterNickname('Cafe\u0301')).toBe('Café');
    expect(normalizeCharacterNickname('ノヴァ')).toBe('ノヴァ');
    expect(normalizeCharacterNickname('😊')).toBe('😊');
    expect(isValidCharacterNickname('  星咏  ')).toBe(true);
  });

  it('enforces the existing petSnapshot 80 UTF-16 unit bound without rejecting valid surrogate pairs', () => {
    expect(MAX_CHARACTER_NICKNAME_LENGTH).toBe(80);
    expect(normalizeCharacterNickname('星'.repeat(80))).toBe('星'.repeat(80));
    expect(normalizeCharacterNickname('😊'.repeat(40))).toBe('😊'.repeat(40));
    expect(() => normalizeCharacterNickname('星'.repeat(81))).toThrow(RangeError);
    expect(() => normalizeCharacterNickname('😊'.repeat(41))).toThrow(RangeError);
    expect(() => normalizeCharacterNickname('A'.repeat(1025))).toThrow(RangeError);
  });

  it.each(['', ' ', '\u3000', '\u200b', '星\u0000咏', '星\n咏', '星\t', '\u202efoo', '\u2028foo', '\u2029foo', '\ud800', '\udc00', null, 2])(
    'rejects blank, control, invalid surrogate, formatting or non-string input %j', value => {
      expect(isValidCharacterNickname(value)).toBe(false);
      expect(() => normalizeCharacterNickname(value)).toThrow(RangeError);
    },
  );

  it('does not make a valid nickname into a stable character ID or impose global nickname uniqueness', () => {
    const nickname = normalizeCharacterNickname('星咏');
    expect(nickname).toBe(definition('star-singer').displayName);
    expect(findCharacterDefinition(nickname)).toBeUndefined();
    expect(evaluateCharacterAcquisition('nova',eligible)).toMatchObject({ok:true});
  });
});
