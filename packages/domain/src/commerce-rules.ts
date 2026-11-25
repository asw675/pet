import { findItemDefinition, findShopOffer, ITEM_CATALOG, validateItemCatalog } from '#item-catalog';
import type { ItemCatalog } from '#item-catalog';

export type PurchaseOutput =
  | { readonly kind: 'STACK'; readonly itemId: string; readonly quantity: number }
  | { readonly kind: 'EQUIPMENT'; readonly definitionId: string; readonly quantity: number; readonly enhancement: 0 };

export type PurchaseFailureReason =
  | 'INVALID_OFFER_ID'
  | 'INVALID_QUANTITY'
  | 'INVALID_CATALOG_VERSION'
  | 'INVALID_WALLET'
  | 'INVALID_CATALOG'
  | 'STALE_CATALOG'
  | 'UNKNOWN_OFFER'
  | 'QUANTITY_LIMIT'
  | 'COST_OVERFLOW'
  | 'INSUFFICIENT_COINS';

export type PurchaseQuote =
  | {
    readonly ok: true;
    readonly catalogVersion: number;
    readonly offerId: string;
    readonly itemId: string;
    readonly quantity: number;
    readonly unitPriceCoins: number;
    readonly totalCoins: number;
    readonly remainingWalletCoins: number;
    /** For equipment, quantity means that many new distinct +0 instances. */
    readonly output: PurchaseOutput;
  }
  | { readonly ok: false; readonly reason: PurchaseFailureReason };

const fail = (reason: PurchaseFailureReason): PurchaseQuote => Object.freeze({ ok: false, reason });

/** Pure game-coin purchase quote, not a purchase, stock reservation, entitlement
 * or wallet mutation. The authority must supply CURRENT wallet, catalog version,
 * available inventory capacity, instance IDs and execute the quote in the same
 * transaction as debit/output/ledger. No OS, network or real payment action. */
export function quotePurchase(offerId: string, quantity: number, catalogVersion: number,
  walletCoins: number, catalog: ItemCatalog = ITEM_CATALOG): PurchaseQuote {
  if (typeof offerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(offerId)) return fail('INVALID_OFFER_ID');
  if (!Number.isSafeInteger(quantity) || quantity < 1) return fail('INVALID_QUANTITY');
  if (!Number.isSafeInteger(catalogVersion) || catalogVersion < 1) return fail('INVALID_CATALOG_VERSION');
  if (!Number.isSafeInteger(walletCoins) || walletCoins < 0) return fail('INVALID_WALLET');
  if (catalog !== ITEM_CATALOG) {
    try { validateItemCatalog(catalog); } catch { return fail('INVALID_CATALOG'); }
  }
  if (catalogVersion !== catalog.version) return fail('STALE_CATALOG');
  const offer = findShopOffer(offerId, catalog);
  if (offer === undefined) return fail('UNKNOWN_OFFER');
  if (quantity < offer.minQuantity || quantity > offer.maxQuantity) return fail('QUANTITY_LIMIT');
  const item = findItemDefinition(offer.itemId, catalog);
  if (item === undefined) return fail('INVALID_CATALOG');

  // Every operand is a safe integer. Calculate the exact product before any
  // number multiplication/rounding could disguise a wallet-range overflow.
  const exactCost = BigInt(offer.priceCoins) * BigInt(quantity);
  if (exactCost > BigInt(Number.MAX_SAFE_INTEGER)) return fail('COST_OVERFLOW');
  const totalCoins = Number(exactCost);
  if (totalCoins > walletCoins) return fail('INSUFFICIENT_COINS');
  const output: PurchaseOutput = item.kind === 'EQUIPMENT'
    ? Object.freeze({ kind: 'EQUIPMENT', definitionId: item.equipment.definitionId, quantity, enhancement: 0 })
    : Object.freeze({ kind: 'STACK', itemId: item.itemId, quantity });
  return Object.freeze({ ok: true, catalogVersion, offerId: offer.offerId, itemId: item.itemId, quantity,
    unitPriceCoins: offer.priceCoins, totalCoins, remainingWalletCoins: walletCoins - totalCoins, output });
}
