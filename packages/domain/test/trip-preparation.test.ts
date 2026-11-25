import { describe, expect, it } from 'vitest';
import { DEMO_ROUTE } from '@pet-desktop/domain';
import { ROUTE_CATALOG_VERSION, findRouteDefinition } from '@pet-desktop/domain/route-catalog';
import type { RouteSupplyAmount } from '@pet-desktop/domain/route-catalog';
import {
  MAX_TRIP_PREPARATION_INVENTORY_ENTRIES, MAX_TRIP_SUPPLY_ENTRIES, MAX_TRIP_SUPPLY_QUANTITY,
  previewTripPreparation,
} from '@pet-desktop/domain/trip-preparation';
import type { TripPreparationInput, TripPreparationPet } from '@pet-desktop/domain/trip-preparation';

const MINUTE = 60_000;
const basePet: TripPreparationPet = Object.freeze({
  presence: 'HOME', hasActiveTrip: false, level: 1, energy10: 150,
  healthStatus: 'NORMAL', healthPoints10: 1000,
});
const base: TripPreparationInput = Object.freeze({
  routeId: 'morning-dew-meadow', routeCatalogVersion: ROUTE_CATALOG_VERSION,
  pet: basePet, selectedSupplies: Object.freeze([]), inventory: Object.freeze([]),
});
const forestSupply = Object.freeze([{ itemId: 'ration', quantity: 1 }]);
const ruinSupplies = Object.freeze([{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }]);
const forest: TripPreparationInput = Object.freeze({
  ...base, routeId: 'mist-forest', pet: Object.freeze({ ...basePet, level: 4, energy10: 300 }),
  selectedSupplies: forestSupply, inventory: forestSupply,
});
const ruins: TripPreparationInput = Object.freeze({
  ...base, routeId: 'starfall-ruins', pet: Object.freeze({ ...basePet, level: 10, energy10: 500 }),
  selectedSupplies: ruinSupplies, inventory: ruinSupplies,
});

describe('pure trip preparation and exact route entry cost', () => {
  it('keeps historic Lv.1 meadow departure at 150 energy tenths and no supply at the exact boundary', () => {
    expect(previewTripPreparation(base)).toMatchObject({
      routeCatalogVersion: 1, eligible: true, reasons: [], energyCost10: 150, durationMs: 15 * MINUTE, supplyConsumption: [],
    });
    expect(previewTripPreparation(base).route?.route).toBe(DEMO_ROUTE);
  });

  it('rejects one tenth less than the required energy, without erasing the cost quote', () => {
    const quote = previewTripPreparation({ ...base, pet: { ...basePet, energy10: 149 } });
    expect(quote.eligible).toBe(false);
    expect(quote.energyCost10).toBe(150);
    expect(quote.reasons).toEqual([{ code: 'ENERGY_TOO_LOW', required10: 150, available10: 149 }]);
  });

  it('rejects an optional supply on the supply-free route instead of charging unused items', () => {
    const quote = previewTripPreparation({ ...base, selectedSupplies: forestSupply, inventory: forestSupply });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'SUPPLY_NOT_ALLOWED', itemId: 'ration', selectedQuantity: 1 }]);
    expect(quote.supplyConsumption).toEqual([]);
  });

  it('quotes exact forest departure at level 4, 30 energy, 1 ration and 60 minutes', () => {
    const quote = previewTripPreparation(forest);
    expect(quote).toMatchObject({ eligible: true, reasons: [], energyCost10: 300, durationMs: 60 * MINUTE,
      supplyConsumption: [{ itemId: 'ration', quantity: 1 }] });
    expect(quote.route?.route).toBe(findRouteDefinition('mist-forest', 1));
  });

  it('quotes exact ruins departure at level 10, 50 energy, 2 rations + 1 potion and 4 hours', () => {
    const quote = previewTripPreparation(ruins);
    expect(quote).toMatchObject({ eligible: true, reasons: [], energyCost10: 500, durationMs: 240 * MINUTE,
      supplyConsumption: ruinSupplies });
    expect(quote.route?.route).toBe(findRouteDefinition('starfall-ruins', 1));
  });

  it('notices both route level and energy shortfalls at their exact fixed-point boundaries', () => {
    const quote = previewTripPreparation({ ...forest, pet: { ...forest.pet, level: 3, energy10: 299 } });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'LEVEL_TOO_LOW', requiredLevel: 4, level: 3 },
      { code: 'ENERGY_TOO_LOW', required10: 300, available10: 299 }]);
    expect(quote.supplyConsumption).toEqual(forestSupply); // planned, never spend authority
  });

  it('recommended maximum level is guidance, not a hard ban on a previous region', () => {
    const quote = previewTripPreparation({ ...base, pet: { ...basePet, level: 20 } });
    expect(quote.eligible).toBe(true);
  });

  it.each(['AWAY', 'RETURNING'] as const)('rejects %s pet despite sufficient supplies, level and energy', (presence) => {
    const quote = previewTripPreparation({ ...ruins, pet: { ...ruins.pet, presence, hasActiveTrip: true } });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'PET_NOT_HOME', presence }, { code: 'ACTIVE_TRIP' }]);
  });

  it('rejects an active trip independently from presence', () => {
    const quote = previewTripPreparation({ ...base, pet: { ...basePet, hasActiveTrip: true } });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'ACTIVE_TRIP' }]);
  });

  it.each(['INJURED', 'RECOVERING'] as const)('rejects %s health status even at high current health', (healthStatus) => {
    const quote = previewTripPreparation({ ...base, pet: { ...basePet, healthStatus } });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'PET_UNHEALTHY', healthStatus, healthPoints10: 1000 }]);
  });

  it('rejects zero health despite NORMAL status', () => {
    const quote = previewTripPreparation({ ...base, pet: { ...basePet, healthPoints10: 0 } });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([{ code: 'PET_UNHEALTHY', healthStatus: 'NORMAL', healthPoints10: 0 }]);
  });

  it('checks explicitly selected required supplies and present inventory independently', () => {
    const notSelected = previewTripPreparation({ ...forest, selectedSupplies: [] });
    expect(notSelected.reasons).toEqual([{ code: 'MISSING_REQUIRED_SUPPLY', itemId: 'ration', requiredQuantity: 1, selectedQuantity: 0 }]);
    expect(notSelected.supplyConsumption).toEqual([]);
    const notAvailable = previewTripPreparation({ ...forest, inventory: [] });
    expect(notAvailable.reasons).toEqual([{ code: 'SUPPLY_OUT_OF_STOCK', itemId: 'ration', requiredQuantity: 1, availableQuantity: 0 }]);
    expect(notAvailable.supplyConsumption).toEqual(forestSupply); // valid selection, not spend permission
    const both = previewTripPreparation({ ...forest, selectedSupplies: [], inventory: [] });
    expect(both.reasons.map((reason) => reason.code)).toEqual(['MISSING_REQUIRED_SUPPLY', 'SUPPLY_OUT_OF_STOCK']);
    expect(both.eligible).toBe(false);
  });

  it('does not silently fill or spend missing fractions of multiple required supplies', () => {
    const quote = previewTripPreparation({ ...ruins, selectedSupplies: [{ itemId: 'ration', quantity: 1 }] });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([
      { code: 'MISSING_REQUIRED_SUPPLY', itemId: 'ration', requiredQuantity: 2, selectedQuantity: 1 },
      { code: 'MISSING_REQUIRED_SUPPLY', itemId: 'healing-potion', requiredQuantity: 1, selectedQuantity: 0 },
    ]);
    expect(quote.supplyConsumption).toEqual([]);
  });

  it('rejects excess required-item quantities and unrelated goods instead of charging either', () => {
    const selection = [{ itemId: 'ration', quantity: 2 }, { itemId: 'herb', quantity: 1 }];
    const quote = previewTripPreparation({ ...forest, selectedSupplies: selection, inventory: selection });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([
      { code: 'SUPPLY_NOT_ALLOWED', itemId: 'herb', selectedQuantity: 1 },
      { code: 'EXCESS_SUPPLY', itemId: 'ration', maxQuantity: 1, selectedQuantity: 2 },
    ]);
    expect(quote.supplyConsumption).toEqual([]);
  });

  it('reports actual stock and necessary quantity for each insufficient supply', () => {
    const quote = previewTripPreparation({ ...ruins, inventory: [{ itemId: 'ration', quantity: 1 }, { itemId: 'healing-potion', quantity: 0 }] });
    expect(quote.eligible).toBe(false);
    expect(quote.reasons).toEqual([
      { code: 'SUPPLY_OUT_OF_STOCK', itemId: 'ration', requiredQuantity: 2, availableQuantity: 1 },
      { code: 'SUPPLY_OUT_OF_STOCK', itemId: 'healing-potion', requiredQuantity: 1, availableQuantity: 0 },
    ]);
  });

  it('canonicalizes equivalent supply order and keeps unrelated existing inventory untouched', () => {
    const input = { ...ruins, selectedSupplies: [...ruinSupplies].reverse(),
      inventory: [{ itemId: 'retired-item', quantity: 0 }, ...[...ruinSupplies].reverse()] };
    const before = JSON.stringify(input);
    const quote = previewTripPreparation(input);
    expect(quote).toEqual(previewTripPreparation(ruins));
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.reasons)).toBe(true);
    expect(Object.isFrozen(quote.supplyConsumption)).toBe(true);
    expect(quote.supplyConsumption.every(Object.isFrozen)).toBe(true);
  });

  it('uses an authoritative route lookup rather than any arbitrary route/power passed as an extra field', () => {
    const hostile: TripPreparationInput & { route: unknown; power: number } = {
      ...base, route: { routeId: base.routeId, nodes: [], durationMs: 0 }, power: 1000,
    };
    const quote = previewTripPreparation(hostile);
    expect(quote).toEqual(previewTripPreparation(base));
    expect(quote.route?.route).toBe(DEMO_ROUTE);
    expect(Object.hasOwn(quote, 'power')).toBe(false);
    expect(Object.hasOwn(quote, 'seed')).toBe(false);
  });
});

describe('stale catalog versions and unavailable route identity', () => {
  it.each([0, 2, 100])('denies stale/mismatched catalog version %d and does not return a spendable quote', (routeCatalogVersion) => {
    const quote = previewTripPreparation({ ...ruins, routeCatalogVersion });
    expect(quote).toEqual({ routeCatalogVersion: 1, route: null, eligible: false,
      reasons: [{ code: 'ROUTE_CATALOG_VERSION_MISMATCH', expectedVersion: 1, receivedVersion: routeCatalogVersion }],
      energyCost10: 0, durationMs: 0, supplyConsumption: [] });
  });

  it('denies unknown route without fabricating a route or charging supply', () => {
    const quote = previewTripPreparation({ ...forest, routeId: 'unknown-route' });
    expect(quote).toEqual({ routeCatalogVersion: 1, route: null, eligible: false,
      reasons: [{ code: 'ROUTE_NOT_FOUND', routeId: 'unknown-route' }],
      energyCost10: 0, durationMs: 0, supplyConsumption: [] });
  });

  it('reports both route and version mismatch if both are wrong', () => {
    const quote = previewTripPreparation({ ...forest, routeId: 'unknown-route', routeCatalogVersion: 2 });
    expect(quote.reasons.map((reason) => reason.code)).toEqual(['ROUTE_CATALOG_VERSION_MISMATCH', 'ROUTE_NOT_FOUND']);
    expect(quote.route).toBeNull();
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects malformed catalog version %s', (routeCatalogVersion) => {
    expect(() => previewTripPreparation({ ...base, routeCatalogVersion })).toThrow(RangeError);
  });
});

describe('closed supply intent and storage-corruption handling', () => {
  const invalidCases: Array<[unknown, string]> = [
    [null, 'NOT_ARRAY'],
    [{ itemId: 'ration', quantity: 1 }, 'NOT_ARRAY'],
    [Array.from({ length: MAX_TRIP_SUPPLY_ENTRIES + 1 }, (_, i) => ({ itemId: `item-${i}`, quantity: 1 })), 'TOO_MANY_ENTRIES'],
    [[null], 'INVALID_ENTRY'],
    [[{ itemId: 'ration', quantity: 1, power: 999 }], 'INVALID_ENTRY'],
    [[{ itemId: '../ration', quantity: 1 }], 'INVALID_ITEM_ID'],
    [[{ itemId: 'ration', quantity: 0 }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: -1 }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: 1.5 }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: NaN }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: MAX_TRIP_SUPPLY_QUANTITY + 1 }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: Number.MAX_SAFE_INTEGER }], 'INVALID_QUANTITY'],
    [[{ itemId: 'ration', quantity: 1 }, { itemId: 'ration', quantity: 1 }], 'DUPLICATE_ITEM'],
  ];
  it.each(invalidCases)('denies malformed or unbounded selection %s with %s', (selected, detail) => {
    const quote = previewTripPreparation({ ...forest, selectedSupplies: selected as readonly RouteSupplyAmount[] });
    expect(quote.eligible).toBe(false);
    expect(quote.supplyConsumption).toEqual([]);
    expect(quote.reasons).toEqual([expect.objectContaining({ code: 'INVALID_SUPPLY_SELECTION', detail })]);
    expect(Object.isFrozen(quote.reasons[0])).toBe(true);
  });

  it.each([0, -1, 21, 1.5, NaN])('fails on corrupt authoritative level %s instead of treating corrupt storage as unlocked', (level) => {
    expect(() => previewTripPreparation({ ...base, pet: { ...basePet, level } })).toThrow(RangeError);
  });

  it.each([-1, 1001, 2.5, NaN])('fails on corrupt authoritative energy %s', (energy10) => {
    expect(() => previewTripPreparation({ ...base, pet: { ...basePet, energy10 } })).toThrow(RangeError);
  });

  const invalidInventories: Array<readonly RouteSupplyAmount[]> = [
    [{ itemId: 'ration', quantity: -1 }],
    [{ itemId: 'ration', quantity: 0.5 }],
    [{ itemId: 'ration', quantity: NaN }],
    [{ itemId: 'ration', quantity: Number.MAX_SAFE_INTEGER + 1 }],
    [{ itemId: 'ration', quantity: 1 }, { itemId: 'ration', quantity: 2 }],
    Array.from({ length: MAX_TRIP_PREPARATION_INVENTORY_ENTRIES + 1 }, (_, i) => ({ itemId: `item-${i}`, quantity: 0 })),
  ];
  it.each(invalidInventories.map((inventory) => ({ inventory, entries: inventory.length })))(
    'fails on corrupt authoritative inventory with $entries rows', ({ inventory }) => {
      expect(() => previewTripPreparation({ ...forest, inventory })).toThrow(RangeError);
    },
  );

  it('accepts valid maximum safe stock counts and does not derive an enlarged consumption from them', () => {
    const quote = previewTripPreparation({ ...forest, inventory: [{ itemId: 'ration', quantity: Number.MAX_SAFE_INTEGER }] });
    expect(quote.eligible).toBe(true);
    expect(quote.supplyConsumption).toEqual(forestSupply);
  });
});
