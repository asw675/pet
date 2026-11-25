import { DEMO_ROUTE, getTripDurationMs } from '@pet-desktop/domain';
import type { RouteDefinition, RouteNode } from '@pet-desktop/domain';
import { MAX_LEVEL } from '@pet-desktop/domain/progression';

export const ROUTE_CATALOG_VERSION = 1 as const;
export const MAX_TRIP_SUPPLY_ENTRIES = 8;
export const MAX_TRIP_SUPPLY_QUANTITY = 20;
export type RouteRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RouteSupplyAmount {
  readonly itemId: string;
  readonly quantity: number;
}

/** Trusted departure metadata, independent of an individual pet or save. */
export interface RouteCatalogEntry {
  readonly routeId: string;
  readonly contentVersion: number;
  readonly title: string;
  readonly description: string;
  readonly risk: RouteRisk;
  readonly minLevel: number;
  readonly recommendedMaxLevel: number;
  /** Tenths of an energy point, matching the authoritative pet record. */
  readonly energyCost10: number;
  readonly durationMs: number;
  /** These supplies are entry costs, not a claim of in-combat buff/healing. */
  readonly requiredSupplies: readonly RouteSupplyAmount[];
  readonly rewardItemIds: readonly string[];
  readonly cgIds: readonly string[];
  /** The existing trip-v1 simulator's bounded, immutable route definition. */
  readonly route: RouteDefinition;
}

type RouteMetadata = Pick<RouteCatalogEntry,
  'title' | 'description' | 'risk' | 'minLevel' | 'recommendedMaxLevel' | 'energyCost10' | 'requiredSupplies'>;

const MINUTE = 60_000;

function immutableRoute(routeId: string, contentVersion: number, returnMinutes: number,
  nodes: readonly RouteNode[]): RouteDefinition {
  const frozen = Object.freeze({
    routeId,
    contentVersion,
    returnDurationMs: returnMinutes * MINUTE,
    nodes: Object.freeze(nodes.map((node) => {
      if (node.kind === 'BATTLE') {
        return Object.freeze({ ...node, drop: node.drop === null ? null : Object.freeze({ ...node.drop }) });
      }
      return Object.freeze({ ...node });
    })),
  });
  // Reuse the same validator used at authoritative trip-v1 departure.
  getTripDurationMs(frozen);
  return frozen;
}

/** New content only: 48-minute outbound nodes followed by 12-minute return.
 * Long-form events/CG for the forest remain pending, not fake unlock IDs. */
export const MIST_FOREST_ROUTE: RouteDefinition = immutableRoute('mist-forest', 1, 12, [
  { kind: 'GATHER', nodeId: 'forest-herbs', durationMs: 8 * MINUTE,
    itemId: 'herb', minQuantity: 2, maxQuantity: 5, xp: 8 },
  { kind: 'BATTLE', nodeId: 'forest-slime', durationMs: 10 * MINUTE,
    enemyId: 'forest-slime', enemyPower: 26, winXp: 35, winCoins: 14, lossXp: 8,
    drop: { itemId: 'slime-gel', quantity: 2, chanceBps: 3_000 } },
  { kind: 'GATHER', nodeId: 'forest-timber', durationMs: 10 * MINUTE,
    itemId: 'forest-wood', minQuantity: 2, maxQuantity: 4, xp: 12 },
  { kind: 'BATTLE', nodeId: 'forest-wisp', durationMs: 12 * MINUTE,
    enemyId: 'forest-wisp', enemyPower: 42, winXp: 55, winCoins: 22, lossXp: 14,
    drop: { itemId: 'forest-wood', quantity: 2, chanceBps: 2_800 } },
  { kind: 'GATHER', nodeId: 'forest-clearing', durationMs: 8 * MINUTE,
    itemId: 'herb', minQuantity: 2, maxQuantity: 4, xp: 8 },
]);

/** New content only: 200-minute outbound nodes followed by 40-minute return. */
export const STARFALL_RUINS_ROUTE: RouteDefinition = immutableRoute('starfall-ruins', 1, 40, [
  { kind: 'GATHER', nodeId: 'ruins-outer-shards', durationMs: 20 * MINUTE,
    itemId: 'ruin-shard', minQuantity: 1, maxQuantity: 2, xp: 24 },
  { kind: 'BATTLE', nodeId: 'ruins-sentinel', durationMs: 30 * MINUTE,
    enemyId: 'ruins-sentinel', enemyPower: 70, winXp: 100, winCoins: 50, lossXp: 25,
    drop: { itemId: 'ruin-shard', quantity: 2, chanceBps: 3_000 } },
  { kind: 'GATHER', nodeId: 'ruins-archive', durationMs: 35 * MINUTE,
    itemId: 'ruin-shard', minQuantity: 2, maxQuantity: 4, xp: 55 },
  { kind: 'BATTLE', nodeId: 'ruins-inner-watch', durationMs: 45 * MINUTE,
    enemyId: 'ruins-watch', enemyPower: 95, winXp: 145, winCoins: 80, lossXp: 35,
    drop: { itemId: 'ruin-shard', quantity: 3, chanceBps: 2_500 } },
  { kind: 'GATHER', nodeId: 'ruins-crystal-chamber', durationMs: 30 * MINUTE,
    itemId: 'ruin-shard', minQuantity: 2, maxQuantity: 4, xp: 50 },
  { kind: 'BATTLE', nodeId: 'ruins-core-guardian', durationMs: 40 * MINUTE,
    enemyId: 'ruins-core-guardian', enemyPower: 120, winXp: 200, winCoins: 90, lossXp: 50,
    drop: { itemId: 'ruin-shard', quantity: 4, chanceBps: 3_500 } },
]);

function catalogEntry(route: RouteDefinition, metadata: RouteMetadata): RouteCatalogEntry {
  const bounded = (value: number, min: number, max: number): boolean =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  if (!bounded(metadata.minLevel, 1, MAX_LEVEL)
    || !bounded(metadata.recommendedMaxLevel, metadata.minLevel, MAX_LEVEL)
    || !bounded(metadata.energyCost10, 1, 1000)
    || metadata.requiredSupplies.length > MAX_TRIP_SUPPLY_ENTRIES) {
    throw new RangeError('Invalid route preparation metadata');
  }
  const supplyIds = new Set<string>();
  for (const amount of metadata.requiredSupplies) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(amount.itemId)
      || !bounded(amount.quantity, 1, MAX_TRIP_SUPPLY_QUANTITY) || supplyIds.has(amount.itemId)) {
      throw new RangeError('Invalid route supply requirements');
    }
    supplyIds.add(amount.itemId);
  }
  const rewardItems = new Set<string>();
  const cgIds = new Set<string>();
  for (const node of route.nodes) {
    if (node.kind === 'GATHER') rewardItems.add(node.itemId);
    else if (node.kind === 'BATTLE' && node.drop !== null) rewardItems.add(node.drop.itemId);
    else if (node.kind === 'EVENT') cgIds.add(node.cgId);
  }
  return Object.freeze({
    routeId: route.routeId,
    contentVersion: route.contentVersion,
    ...metadata,
    requiredSupplies: Object.freeze(metadata.requiredSupplies.map((amount) => Object.freeze({ ...amount }))),
    durationMs: getTripDurationMs(route),
    rewardItemIds: Object.freeze([...rewardItems].sort()),
    cgIds: Object.freeze([...cgIds].sort()),
    route,
  });
}

/**
 * Versioned V1 balance fixtures. The meadow references DEMO_ROUTE itself and
 * retains its historic 15-point energy cost and supply-free entry. The source
 * route, RNG, seed goldens, and historical trip snapshots are unchanged.
 * Requirements/costs belong to preparation; trip-v1 needs no new algorithm.
 */
export const ROUTE_CATALOG: readonly RouteCatalogEntry[] = Object.freeze([
  catalogEntry(DEMO_ROUTE, {
    title: '晨露草原',
    description: '在晨露草地采集草药，遭遇基础史莱姆，并有机会获得入门旅行明信片。',
    risk: 'LOW', minLevel: 1, recommendedMaxLevel: 4, energyCost10: 150, requiredSupplies: [],
  }),
  catalogEntry(MIST_FOREST_ROUTE, {
    title: '迷雾森林',
    description: '沿林间小径采集木材和草药，遭遇森林魔物。需要随行口粮。',
    risk: 'MEDIUM', minLevel: 4, recommendedMaxLevel: 9, energyCost10: 300,
    requiredSupplies: [{ itemId: 'ration', quantity: 1 }],
  }),
  catalogEntry(STARFALL_RUINS_ROUTE, {
    title: '星落遗迹',
    description: '探索遗迹并收集遗迹碎片，穿越多处守卫。需要口粮和急救药剂作为入场物资。',
    risk: 'HIGH', minLevel: 10, recommendedMaxLevel: 20, energyCost10: 500,
    requiredSupplies: [{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }],
  }),
]);

/** Exact content revisions are never redirected to latest. */
export function findRouteCatalogEntry(routeId: string, contentVersion?: number): RouteCatalogEntry | undefined {
  let latest: RouteCatalogEntry | undefined;
  for (const entry of ROUTE_CATALOG) {
    if (entry.routeId !== routeId) continue;
    if (contentVersion !== undefined) {
      if (entry.contentVersion === contentVersion) return entry;
    } else if (latest === undefined || entry.contentVersion > latest.contentVersion) {
      latest = entry;
    }
  }
  return latest;
}

export function findRouteDefinition(routeId: string, contentVersion?: number): RouteDefinition | undefined {
  return findRouteCatalogEntry(routeId, contentVersion)?.route;
}
