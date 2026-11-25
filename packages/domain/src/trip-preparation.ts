import type { TripPresence } from '@pet-desktop/domain';
import { MAX_LEVEL } from '@pet-desktop/domain/progression';
import {
  findRouteCatalogEntry, MAX_TRIP_SUPPLY_ENTRIES, MAX_TRIP_SUPPLY_QUANTITY, ROUTE_CATALOG_VERSION,
} from '@pet-desktop/domain/route-catalog';
import type { RouteCatalogEntry, RouteSupplyAmount } from '@pet-desktop/domain/route-catalog';

export { MAX_TRIP_SUPPLY_ENTRIES, MAX_TRIP_SUPPLY_QUANTITY } from '@pet-desktop/domain/route-catalog';
export const MAX_TRIP_PREPARATION_INVENTORY_ENTRIES = 4096;
export type TripPreparationHealthStatus = 'NORMAL' | 'INJURED' | 'RECOVERING';

/**
 * Projection supplied by trusted app-service state, never user-selected
 * stats. Authority computes the level and checks the actual open-trip index.
 */
export interface TripPreparationPet {
  readonly presence: TripPresence;
  readonly hasActiveTrip: boolean;
  readonly level: number;
  readonly energy10: number;
  readonly healthStatus: TripPreparationHealthStatus;
  readonly healthPoints10: number;
}

export interface TripPreparationInput {
  readonly routeId: string;
  readonly routeCatalogVersion: number;
  readonly pet: TripPreparationPet;
  /** Intent only: the caller chooses supply IDs/quantities, not route or power. */
  readonly selectedSupplies: readonly RouteSupplyAmount[];
  /** Snapshot of current shared, authoritative stack counts. */
  readonly inventory: readonly RouteSupplyAmount[];
}

export type InvalidSupplySelectionDetail =
  | 'NOT_ARRAY' | 'TOO_MANY_ENTRIES' | 'INVALID_ENTRY' | 'INVALID_ITEM_ID' | 'INVALID_QUANTITY' | 'DUPLICATE_ITEM';

export type TripPreparationReason =
  | { readonly code: 'ROUTE_CATALOG_VERSION_MISMATCH'; readonly expectedVersion: number; readonly receivedVersion: number }
  | { readonly code: 'ROUTE_NOT_FOUND'; readonly routeId: string }
  | { readonly code: 'PET_NOT_HOME'; readonly presence: TripPresence }
  | { readonly code: 'ACTIVE_TRIP' }
  | { readonly code: 'PET_UNHEALTHY'; readonly healthStatus: TripPreparationHealthStatus; readonly healthPoints10: number }
  | { readonly code: 'LEVEL_TOO_LOW'; readonly requiredLevel: number; readonly level: number }
  | { readonly code: 'ENERGY_TOO_LOW'; readonly required10: number; readonly available10: number }
  | { readonly code: 'INVALID_SUPPLY_SELECTION'; readonly detail: InvalidSupplySelectionDetail;
      readonly index: number | null; readonly itemId: string | null }
  | { readonly code: 'SUPPLY_NOT_ALLOWED'; readonly itemId: string; readonly selectedQuantity: number }
  | { readonly code: 'MISSING_REQUIRED_SUPPLY'; readonly itemId: string;
      readonly requiredQuantity: number; readonly selectedQuantity: number }
  | { readonly code: 'EXCESS_SUPPLY'; readonly itemId: string; readonly maxQuantity: number; readonly selectedQuantity: number }
  | { readonly code: 'SUPPLY_OUT_OF_STOCK'; readonly itemId: string;
      readonly requiredQuantity: number; readonly availableQuantity: number };

export interface TripPreparationQuote {
  readonly routeCatalogVersion: number;
  readonly route: RouteCatalogEntry | null;
  readonly eligible: boolean;
  readonly reasons: readonly TripPreparationReason[];
  /** Quoted cost in tenths; zero only if no valid/versioned route resolved. */
  readonly energyCost10: number;
  readonly durationMs: number;
  /**
   * Exact planned entry supply costs only when the selection matches the
   * route requirements. May be quoted even while another condition is
   * ineligible (e.g. energy or inventory); this is NOT spending authority.
   */
  readonly supplyConsumption: readonly RouteSupplyAmount[];
}

const NO_SUPPLIES: readonly RouteSupplyAmount[] = Object.freeze([]);
const isStableId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id);
const bounded = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

function authorityInventory(inventory: readonly RouteSupplyAmount[]): ReadonlyMap<string, number> {
  // A malformed storage snapshot is a service/DB error, not a player-facing
  // "out of stock". Duplicate, negative or non-integral counts cannot be used.
  if (!Array.isArray(inventory) || inventory.length > MAX_TRIP_PREPARATION_INVENTORY_ENTRIES) {
    throw new RangeError('Invalid authoritative inventory projection');
  }
  const counts = new Map<string, number>();
  for (const entry of inventory as readonly RouteSupplyAmount[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || !isStableId(entry.itemId) || !bounded(entry.quantity, 0, Number.MAX_SAFE_INTEGER) || counts.has(entry.itemId)) {
      throw new RangeError('Invalid authoritative inventory counts');
    }
    counts.set(entry.itemId, entry.quantity);
  }
  return counts;
}

function requireAuthorityPet(pet: TripPreparationPet): void {
  if (pet === null || typeof pet !== 'object' || Array.isArray(pet)
    || !(['HOME', 'AWAY', 'RETURNING'] as const).includes(pet.presence)
    || typeof pet.hasActiveTrip !== 'boolean' || !bounded(pet.level, 1, MAX_LEVEL)
    || !bounded(pet.energy10, 0, 1000) || !bounded(pet.healthPoints10, 0, 1000)
    || !(['NORMAL', 'INJURED', 'RECOVERING'] as const).includes(pet.healthStatus)) {
    throw new RangeError('Invalid authoritative pet projection');
  }
}

function invalidSelection(
  detail: InvalidSupplySelectionDetail, index: number | null = null, itemId: string | null = null,
): TripPreparationReason {
  return { code: 'INVALID_SUPPLY_SELECTION', detail, index, itemId };
}

type ParsedSelection =
  | { readonly ok: true; readonly selected: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly reason: TripPreparationReason };

function parseSelection(input: unknown): ParsedSelection {
  // Treat selections as closed, bounded intent even when a caller bypasses
  // the wire schema in a unit test. Never normalize duplicates, invalid
  // counts, extra fields or arbitrary item/route definitions into a spend.
  if (!Array.isArray(input)) return { ok: false, reason: invalidSelection('NOT_ARRAY') };
  if (input.length > MAX_TRIP_SUPPLY_ENTRIES) return { ok: false, reason: invalidSelection('TOO_MANY_ENTRIES') };
  const selected = new Map<string, number>();
  for (let index = 0; index < input.length; index += 1) {
    const entry: unknown = input[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'itemId') || !Object.hasOwn(entry, 'quantity')) {
      return { ok: false, reason: invalidSelection('INVALID_ENTRY', index) };
    }
    const item = entry as { itemId: unknown; quantity: unknown };
    if (!isStableId(item.itemId)) return { ok: false, reason: invalidSelection('INVALID_ITEM_ID', index) };
    if (!bounded(item.quantity, 1, MAX_TRIP_SUPPLY_QUANTITY)) {
      return { ok: false, reason: invalidSelection('INVALID_QUANTITY', index, item.itemId) };
    }
    if (selected.has(item.itemId)) {
      return { ok: false, reason: invalidSelection('DUPLICATE_ITEM', index, item.itemId) };
    }
    selected.set(item.itemId, item.quantity);
  }
  return { ok: true, selected };
}

function quote(
  route: RouteCatalogEntry | null, reasons: readonly TripPreparationReason[],
  supplyConsumption: readonly RouteSupplyAmount[] = NO_SUPPLIES,
): TripPreparationQuote {
  return Object.freeze({
    routeCatalogVersion: ROUTE_CATALOG_VERSION,
    route,
    eligible: route !== null && reasons.length === 0,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason }))),
    energyCost10: route?.energyCost10 ?? 0,
    durationMs: route?.durationMs ?? 0,
    supplyConsumption,
  });
}

/**
 * Pure preflight/price quote. No seed generation, trip snapshot, equipment
 * power, clock, inventory mutation, or authority to spend. At actual departure
 * the service must recompute this with current trusted state in the same
 * transaction as consuming resources and building the frozen trip snapshot.
 *
 * V1 supply items on these routes are exact entry costs. A route without a
 * requirement is supply-free; optional extras are rejected rather than
 * consumed without a real simulation benefit.
 */
export function previewTripPreparation(input: TripPreparationInput): TripPreparationQuote {
  if (input === null || typeof input !== 'object' || !isStableId(input.routeId)
    || !bounded(input.routeCatalogVersion, 0, Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Invalid trip preparation identity');
  }
  const reasons: TripPreparationReason[] = [];
  const route = findRouteCatalogEntry(input.routeId);
  if (input.routeCatalogVersion !== ROUTE_CATALOG_VERSION) {
    reasons.push({ code: 'ROUTE_CATALOG_VERSION_MISMATCH', expectedVersion: ROUTE_CATALOG_VERSION,
      receivedVersion: input.routeCatalogVersion });
  }
  if (!route) reasons.push({ code: 'ROUTE_NOT_FOUND', routeId: input.routeId });
  if (!route || reasons.length > 0) return quote(null, reasons);

  const { pet } = input;
  requireAuthorityPet(pet);
  const counts = authorityInventory(input.inventory);
  if (pet.presence !== 'HOME') reasons.push({ code: 'PET_NOT_HOME', presence: pet.presence });
  if (pet.hasActiveTrip) reasons.push({ code: 'ACTIVE_TRIP' });
  if (pet.healthStatus !== 'NORMAL' || pet.healthPoints10 === 0) {
    reasons.push({ code: 'PET_UNHEALTHY', healthStatus: pet.healthStatus, healthPoints10: pet.healthPoints10 });
  }
  if (pet.level < route.minLevel) {
    reasons.push({ code: 'LEVEL_TOO_LOW', requiredLevel: route.minLevel, level: pet.level });
  }
  if (pet.energy10 < route.energyCost10) {
    reasons.push({ code: 'ENERGY_TOO_LOW', required10: route.energyCost10, available10: pet.energy10 });
  }

  const selection = parseSelection(input.selectedSupplies);
  if (!selection.ok) {
    reasons.push(selection.reason);
    return quote(route, reasons);
  }
  const required = new Map(route.requiredSupplies.map(({ itemId, quantity }) => [itemId, quantity]));
  let selectionExact = true;
  const sortedSelection = [...selection.selected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [itemId, quantity] of sortedSelection) {
    const max = required.get(itemId);
    if (max === undefined) {
      selectionExact = false;
      reasons.push({ code: 'SUPPLY_NOT_ALLOWED', itemId, selectedQuantity: quantity });
    } else if (quantity > max) {
      selectionExact = false;
      reasons.push({ code: 'EXCESS_SUPPLY', itemId, maxQuantity: max, selectedQuantity: quantity });
    }
  }
  // Configuration order determines the quote and requirement diagnostics,
  // never inventory order or the order of an equivalent user selection.
  for (const { itemId, quantity } of route.requiredSupplies) {
    const selectedQuantity = selection.selected.get(itemId) ?? 0;
    if (selectedQuantity < quantity) {
      selectionExact = false;
      reasons.push({ code: 'MISSING_REQUIRED_SUPPLY', itemId, requiredQuantity: quantity, selectedQuantity });
    }
    const availableQuantity = counts.get(itemId) ?? 0;
    if (availableQuantity < quantity) {
      reasons.push({ code: 'SUPPLY_OUT_OF_STOCK', itemId, requiredQuantity: quantity, availableQuantity });
    }
  }
  return quote(route, reasons, selectionExact ? route.requiredSupplies : NO_SUPPLIES);
}
