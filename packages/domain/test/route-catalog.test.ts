import { describe, expect, it } from 'vitest';
import {
  advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE, getTripDurationMs,
  MAX_TRIP_NODES, recallTrip, TRIP_RULES_VERSION,
} from '@pet-desktop/domain';
import { findItemDefinition } from '@pet-desktop/domain/item-catalog';
import {
  findRouteCatalogEntry, findRouteDefinition, MIST_FOREST_ROUTE, ROUTE_CATALOG,
  ROUTE_CATALOG_VERSION, STARFALL_RUINS_ROUTE,
} from '@pet-desktop/domain/route-catalog';
import type { RouteDefinition } from '@pet-desktop/domain';

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 25, 23, 58);
const end = START + 72 * 60 * MINUTE;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const legacyJson = '{"routeId":"morning-dew-meadow","contentVersion":1,"returnDurationMs":180000,"nodes":[{"kind":"GATHER","nodeId":"meadow-herbs","durationMs":180000,"itemId":"herb","minQuantity":1,"maxQuantity":3,"xp":4},{"kind":"BATTLE","nodeId":"meadow-slime","durationMs":300000,"enemyId":"slime","enemyPower":12,"winXp":20,"winCoins":8,"lossXp":5,"drop":{"itemId":"slime-gel","quantity":1,"chanceBps":2000}},{"kind":"EVENT","nodeId":"dewdrop-view","durationMs":240000,"eventDefId":"dew-postcard","cgId":"morning-dew","chanceBps":6500}]}';

describe('versioned V1 route catalog', () => {
  it('exposes the three intended regions, metadata and exact entry costs', () => {
    expect(ROUTE_CATALOG_VERSION).toBe(1);
    expect(ROUTE_CATALOG.map((entry) => ({
      id: entry.routeId, version: entry.contentVersion, title: entry.title,
      min: entry.minLevel, recommendedMax: entry.recommendedMaxLevel,
      cost10: entry.energyCost10, risk: entry.risk, minutes: entry.durationMs / MINUTE,
      supplies: entry.requiredSupplies,
    }))).toEqual([
      { id: 'morning-dew-meadow', version: 1, title: '晨露草原', min: 1, recommendedMax: 4, cost10: 150,
        risk: 'LOW', minutes: 15, supplies: [] },
      { id: 'mist-forest', version: 1, title: '迷雾森林', min: 4, recommendedMax: 9, cost10: 300,
        risk: 'MEDIUM', minutes: 60, supplies: [{ itemId: 'ration', quantity: 1 }] },
      { id: 'starfall-ruins', version: 1, title: '星落遗迹', min: 10, recommendedMax: 20, cost10: 500,
        risk: 'HIGH', minutes: 240, supplies: [{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }] },
    ]);
  });

  it('references the exact existing meadow object and source JSON, not a modified duplicate', () => {
    expect(findRouteDefinition('morning-dew-meadow')).toBe(DEMO_ROUTE);
    expect(findRouteCatalogEntry('morning-dew-meadow', 1)?.route).toBe(DEMO_ROUTE);
    expect(JSON.stringify(DEMO_ROUTE)).toBe(legacyJson);
    expect(JSON.stringify(findRouteDefinition('morning-dew-meadow', 1))).toBe(legacyJson);
  });

  it('preserves the historic trip-v1 meadow content hash and fixed seed reward goldens', () => {
    const input = { tripId: 'trip-1', petId: 'pet-a', startAt: START, seed: 8, power: 20 };
    const original = createTripSnapshot({ ...input, route: DEMO_ROUTE });
    const fromCatalog = createTripSnapshot({ ...input, route: findRouteDefinition('morning-dew-meadow', 1)! });
    expect(fromCatalog).toEqual(original);
    expect(fromCatalog.rulesVersion).toBe(TRIP_RULES_VERSION);
    expect(fromCatalog.contentHash).toBe('fnv1a32:34308744');
    const result = advanceTrip(fromCatalog, createTripCheckpoint(fromCatalog), end);
    expect(result.checkpoint.rngState).toBe(2397225082);
    expect(result.checkpoint.drawCount).toBe(4);
    expect(result.checkpoint.actualReturnedAt).toBe(START + 15 * MINUTE);
    expect(result.rewardDraft).toEqual({ xp: 24, coins: 8, items: [{ itemId: 'herb', quantity: 1 },
      { itemId: 'slime-gel', quantity: 1 }], cgIds: ['morning-dew'] });
  });

  it.each(['morning-dew-meadow', 'mist-forest', 'starfall-ruins'])('resolves %s latest and exact v1 without fallback to another revision', (id) => {
    expect(findRouteCatalogEntry(id)).toBe(findRouteCatalogEntry(id, 1));
    expect(findRouteDefinition(id)).toBe(findRouteCatalogEntry(id)?.route);
    for (const version of [0, 2, 100, NaN]) {
      expect(findRouteCatalogEntry(id, version)).toBeUndefined();
      expect(findRouteDefinition(id, version)).toBeUndefined();
    }
  });

  it('rejects unknown routes and neither synthesizes nor accepts a caller route definition', () => {
    for (const id of ['', 'missing', '../starfall-ruins', 'constructor', '__proto__']) {
      expect(findRouteCatalogEntry(id)).toBeUndefined();
      expect(findRouteDefinition(id)).toBeUndefined();
    }
  });

  it('freezes the catalog, nested metadata, route nodes and nested battle drops', () => {
    expect(Object.isFrozen(ROUTE_CATALOG)).toBe(true);
    for (const entry of ROUTE_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.route)).toBe(true);
      expect(Object.isFrozen(entry.route.nodes)).toBe(true);
      expect(Object.isFrozen(entry.requiredSupplies)).toBe(true);
      expect(Object.isFrozen(entry.rewardItemIds)).toBe(true);
      expect(Object.isFrozen(entry.cgIds)).toBe(true);
      entry.requiredSupplies.forEach((amount) => expect(Object.isFrozen(amount)).toBe(true));
      for (const node of entry.route.nodes) {
        expect(Object.isFrozen(node)).toBe(true);
        if (node.kind === 'BATTLE' && node.drop !== null) expect(Object.isFrozen(node.drop)).toBe(true);
      }
    }
  });

  it.each([15, 60, 240])('validates the %d-minute route with the unchanged simulator bounds', (minutes) => {
    const entry = ROUTE_CATALOG.find((route) => route.durationMs === minutes * MINUTE)!;
    expect(getTripDurationMs(entry.route)).toBe(minutes * MINUTE);
    expect(entry.route.nodes.length).toBeGreaterThanOrEqual(2);
    expect(entry.route.nodes.length).toBeLessThanOrEqual(MAX_TRIP_NODES);
    expect(new Set(entry.route.nodes.map((node) => node.nodeId)).size).toBe(entry.route.nodes.length);
    const snapshot = createTripSnapshot({ tripId: 'duration', petId: 'pet', seed: 8, power: 50, startAt: START, route: entry.route });
    expect(snapshot.expectedReturnAt).toBe(START + minutes * MINUTE);
  });

  it('uses actual item-catalog IDs for materials and entry supply costs only', () => {
    expect(findRouteCatalogEntry('morning-dew-meadow')?.rewardItemIds).toEqual(['herb', 'slime-gel']);
    expect(findRouteCatalogEntry('mist-forest')?.rewardItemIds).toEqual(['forest-wood', 'herb', 'slime-gel']);
    expect(findRouteCatalogEntry('starfall-ruins')?.rewardItemIds).toEqual(['ruin-shard']);
    for (const entry of ROUTE_CATALOG) {
      for (const itemId of entry.rewardItemIds) expect(findItemDefinition(itemId)?.kind).toBe('MATERIAL');
      for (const supply of entry.requiredSupplies) expect(findItemDefinition(supply.itemId)?.kind).toBe('CONSUMABLE');
    }
  });

  it('does not invent unimplemented forest/ruins events, CG assets, or drops', () => {
    expect(findRouteCatalogEntry('morning-dew-meadow')?.cgIds).toEqual(['morning-dew']);
    for (const route of [MIST_FOREST_ROUTE, STARFALL_RUINS_ROUTE]) {
      expect(route.nodes.every((node) => node.kind === 'GATHER' || node.kind === 'BATTLE')).toBe(true);
      expect(findRouteCatalogEntry(route.routeId)?.cgIds).toEqual([]);
    }
  });
});

describe('new routes execute with existing deterministic trip-v1', () => {
  it.each([MIST_FOREST_ROUTE, STARFALL_RUINS_ROUTE])('$routeId is reproducible one-shot vs persisted segmented simulation for 64 seed/power cases', (route) => {
    for (const power of [2, 220]) for (let seed = 1; seed <= 32; seed++) {
      const snapshot = createTripSnapshot({ tripId: 'trip', petId: 'pet', startAt: START, seed, power, route });
      const single = advanceTrip(snapshot, createTripCheckpoint(snapshot), end);
      let checkpoint = createTripCheckpoint(snapshot);
      const facts = [];
      let at = START;
      for (const node of route.nodes) {
        at += node.durationMs;
        const step = advanceTrip(clone(snapshot), clone(checkpoint), at);
        checkpoint = step.checkpoint;
        facts.push(...step.facts);
      }
      const final = advanceTrip(clone(snapshot), clone(checkpoint), end);
      facts.push(...final.facts);
      expect(final.checkpoint).toEqual(single.checkpoint);
      expect(facts).toEqual(single.facts);
      expect(final.rewardDraft.cgIds).toEqual([]);
      expect(final.rewardDraft.items.every((item) => findRouteCatalogEntry(route.routeId)!.rewardItemIds.includes(item.itemId))).toBe(true);
    }
  });

  it.each([MIST_FOREST_ROUTE, STARFALL_RUINS_ROUTE])('$routeId recall cannot award unresolved nodes', (route: RouteDefinition) => {
    const snapshot = createTripSnapshot({ tripId: 'recall', petId: 'pet', startAt: START, seed: 8, power: 220, route });
    const at = START + route.nodes[0]!.durationMs;
    const recalled = recallTrip(snapshot, createTripCheckpoint(snapshot), at);
    expect(recalled.facts.map((fact) => fact.type)).toEqual(['GATHER_RESOLVED', 'RETURNING']);
    expect(recalled.checkpoint.nextDueAt).toBe(at + route.returnDurationMs);
    const final = advanceTrip(snapshot, clone(recalled.checkpoint), end);
    expect(final.checkpoint.returnReason).toBe('RECALLED');
    expect(final.rewardDraft).toEqual(recalled.rewardDraft);
    expect(final.rewardDraft.coins).toBe(0);
    expect(final.rewardDraft.items).toHaveLength(1);
    expect(final.rewardDraft.cgIds).toEqual([]);
  });
});
