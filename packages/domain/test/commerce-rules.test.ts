import { describe, expect, it } from 'vitest';
import { quotePurchase } from '../src/commerce-rules.js';
import { defineItemCatalog, findItemDefinition, ITEM_CATALOG, ITEM_CATALOG_VERSION, SHOP_OFFERS } from '../src/item-catalog.js';
import type { ItemCatalog } from '../src/item-catalog.js';

const quote = (offerId: string, quantity: number, wallet: number) => quotePurchase(offerId, quantity, ITEM_CATALOG_VERSION, wallet);

describe('pure game-coin purchasing quotes', () => {
  it('quotes an exact wallet-bound supply stack, including zero coins left', () => {
    expect(quote('shop-ration', 3, 6)).toEqual({ ok: true, catalogVersion: 1, offerId: 'shop-ration',
      itemId: 'ration', quantity: 3, unitPriceCoins: 2, totalCoins: 6, remainingWalletCoins: 0,
      output: { kind: 'STACK', itemId: 'ration', quantity: 3 } });
  });

  it.each([
    ['shop-healing-potion', 'healing-potion', 4],
    ['shop-sweet-biscuit', 'sweet-biscuit', 3],
    ['shop-iron-ore', 'iron-ore', 3],
  ] as const)('quotes %s as stack quantity and not equipment or automatic use', (offerId, itemId, price) => {
    expect(quote(offerId, 2, 20)).toMatchObject({ ok: true, itemId, totalCoins: price * 2,
      remainingWalletCoins: 20 - price * 2, output: { kind: 'STACK', itemId, quantity: 2 } });
  });

  it.each([
    ['apprentice-staff', 12], ['forest-bow', 12], ['mechanical-tool', 14],
    ['traveler-coat', 10], ['glimmer-ring', 16],
  ] as const)('quotes %s as separate +0 equipment instances, not a stack', (itemId, price) => {
    expect(quote(`shop-${itemId}`, 2, 100)).toEqual({ ok: true, catalogVersion: 1, offerId: `shop-${itemId}`,
      itemId, quantity: 2, unitPriceCoins: price, totalCoins: price * 2, remainingWalletCoins: 100 - price * 2,
      output: { kind: 'EQUIPMENT', definitionId: itemId, quantity: 2, enhancement: 0 } });
  });

  it('uses authored per-offer inclusive limits, without allocating large collections', () => {
    expect(quote('shop-ration', 1, 2).ok).toBe(true);
    expect(quote('shop-ration', 20, 40).ok).toBe(true);
    expect(quote('shop-ration', 21, 100_000)).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
    expect(quote('shop-ration', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
    expect(quote('shop-apprentice-staff', 3, 36).ok).toBe(true);
    expect(quote('shop-apprentice-staff', 4, 100)).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
  });

  it('quotes only at the exact current catalog version and rejects unlisted offers', () => {
    expect(quotePurchase('shop-ration', 1, ITEM_CATALOG_VERSION + 1, 100)).toEqual({ ok: false, reason: 'STALE_CATALOG' });
    expect(quote('shop-herb', 1, 100)).toEqual({ ok: false, reason: 'UNKNOWN_OFFER' }); // a real material need not be sold
    expect(quote('shop-missing', 1, 100)).toEqual({ ok: false, reason: 'UNKNOWN_OFFER' });
  });

  it('rejects insufficient game coins, including a one-coin deficit', () => {
    expect(quote('shop-ration', 3, 5)).toEqual({ ok: false, reason: 'INSUFFICIENT_COINS' });
    expect(quote('shop-ration', 1, 0)).toEqual({ ok: false, reason: 'INSUFFICIENT_COINS' });
    expect(quote('shop-ration', 2, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: true,
      totalCoins: 4, remainingWalletCoins: Number.MAX_SAFE_INTEGER - 4 });
  });

  it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid quantity %s', quantity => {
    expect(quote('shop-ration', quantity, 100)).toEqual({ ok: false, reason: 'INVALID_QUANTITY' });
  });

  it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid catalog version %s', version => {
    expect(quotePurchase('shop-ration', 1, version, 100)).toEqual({ ok: false, reason: 'INVALID_CATALOG_VERSION' });
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100' as unknown as number])('rejects invalid wallet %s', wallet => {
    expect(quote('shop-ration', 1, wallet)).toEqual({ ok: false, reason: 'INVALID_WALLET' });
  });

  it.each(['', '../offer', 'https://store.invalid/', 'a'.repeat(129), null as unknown as string])('rejects invalid offer ID %s', offerId => {
    expect(quote(offerId, 1, 100)).toEqual({ ok: false, reason: 'INVALID_OFFER_ID' });
  });

  it('prices a custom version using exact integer arithmetic and rejects unsafe multiplication', () => {
    const catalog = defineItemCatalog({ version: 2, items: [findItemDefinition('ration')!], shopOffers: [{
      offerId: 'price-test', itemId: 'ration', catalogVersion: 2, priceCoins: Number.MAX_SAFE_INTEGER,
      minQuantity: 1, maxQuantity: 2,
    }] });
    expect(quotePurchase('price-test', 1, 1, Number.MAX_SAFE_INTEGER, catalog)).toEqual({ ok: false, reason: 'STALE_CATALOG' });
    expect(quotePurchase('price-test', 1, 2, Number.MAX_SAFE_INTEGER, catalog)).toMatchObject({ ok: true,
      totalCoins: Number.MAX_SAFE_INTEGER, remainingWalletCoins: 0 });
    expect(quotePurchase('price-test', 2, 2, Number.MAX_SAFE_INTEGER, catalog)).toEqual({ ok: false, reason: 'COST_OVERFLOW' });
  });

  it('also honors a custom minimum quantity, and rejects a malformed duplicate storefront', () => {
    const minimumThree = defineItemCatalog({ version: 2, items: [findItemDefinition('ration')!], shopOffers: [{
      offerId: 'bulk-ration', itemId: 'ration', catalogVersion: 2, priceCoins: 1, minQuantity: 3, maxQuantity: 10,
    }] });
    expect(quotePurchase('bulk-ration', 2, 2, 100, minimumThree)).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
    expect(quotePurchase('bulk-ration', 3, 2, 100, minimumThree)).toMatchObject({ ok: true, totalCoins: 3 });
    const invalid: ItemCatalog = { ...ITEM_CATALOG, shopOffers: [...SHOP_OFFERS, SHOP_OFFERS[0]!] };
    expect(quotePurchase('shop-ration', 1, 1, 100, invalid)).toEqual({ ok: false, reason: 'INVALID_CATALOG' });
    expect(quotePurchase('shop-ration', 1, 1, 100, null as unknown as ItemCatalog)).toEqual({ ok: false, reason: 'INVALID_CATALOG' });
  });

  it('repeating quotes neither consumes stock nor changes the catalog, wallet or item identity', () => {
    const before = JSON.stringify(ITEM_CATALOG);
    const balance = 12;
    const first = quote('shop-ration', 2, balance);
    for (let i = 0; i < 10; i++) expect(quote('shop-ration', 2, balance)).toEqual(first);
    expect(first.ok && Object.isFrozen(first.output)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(balance).toBe(12);
    expect(JSON.stringify(ITEM_CATALOG)).toBe(before);
  });
});
