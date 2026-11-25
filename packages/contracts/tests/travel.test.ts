import { describe, expect, it } from 'vitest';
import { routeMetadataSchema, travelCatalogSchema, travelPreviewSchema, tripPreparationPayloadSchema,
  tripReportSchema, travelReportsPageSchema, travelReportsQuerySchema, tripDepartureLoadoutSchema } from '../src/travel.js';
import type { RouteMetadata, TravelPreview, TravelCatalog, TripReport, TripDepartureLoadout } from '../src/travel.js';

const route = { routeId: 'mist-forest', contentVersion: 1, title: '迷雾森林', description: '林间旅行', risk: 'MEDIUM',
  minLevel: 4, recommendedMaxLevel: 9, energyCost10: 300, durationMs: 3_600_000,
  requiredSupplies: [{ itemId: 'ration', quantity: 1 }], rewardItemIds: ['herb', 'forest-wood'], cgIds: [] } satisfies RouteMetadata;
const catalog = { revision: 7, routeCatalogVersion: 1, routes: [route], supplyStock: [{ itemId: 'ration', quantity: 4 }] } satisfies TravelCatalog;
const intent = { petId: 'pet-1', routeId: route.routeId, routeCatalogVersion: 1, selectedSupplies: route.requiredSupplies };
const preview = { revision: 7, petId: intent.petId, routeCatalogVersion: 1, requestedRouteId: intent.routeId,
  route, eligible: true, reasons: [], energyCost10: route.energyCost10, durationMs: route.durationMs,
  selectedSupplies: intent.selectedSupplies, supplyConsumption: route.requiredSupplies } satisfies TravelPreview;
const stats = { hp: 100, atk: 24, def: 20, spd: 12, luk: 16 };
const loadout = { routeCatalogVersion: 1, itemCatalogVersion: 1, level: 4, energyCost10: 300,
  supplies: [{ itemId: 'ration', quantity: 1 }], stats, battlePower: 52,
  equipment: [{ slot: 'WEAPON', instanceId: 'staff-1', definitionId: 'starter-staff', definitionVersion: 1, enhancement: 1, bonus: { hp: 0, atk: 4, def: 0, spd: 0, luk: 1 } }],
} satisfies TripDepartureLoadout;
const fact = (sequence: number, scheduledAt: number) => ({ eventId: `trip-1:${sequence}`, tripId: 'trip-1', petId: 'pet-1', sequence, scheduledAt });
const report = { tripId: 'trip-1', petId: 'pet-1', routeId: 'mist-forest', contentVersion: 1, rulesVersion: 'trip-v1',
  startAt: 100, expectedReturnAt: 1000, actualReturnedAt: 1000, readAt: null, returnReason: 'COMPLETED', departurePower: 52, loadout,
  facts: [
    { ...fact(1, 200), type: 'GATHER_RESOLVED', payload: { nodeId: 'gather-1', itemId: 'herb', quantity: 2, xp: 8 } },
    { ...fact(2, 400), type: 'BATTLE_RESOLVED', payload: { nodeId: 'fight-1', enemyId: 'slime', outcome: 'WIN', winChanceBps: 7500, xp: 10, coins: 12, drop: { itemId: 'herb', quantity: 1 } } },
    { ...fact(3, 600), type: 'EVENT_RESOLVED', payload: { nodeId: 'event-1', eventDefId: 'visit', cgId: 'meadow' } },
    { ...fact(4, 700), type: 'RETURNING', payload: { reason: 'COMPLETED', dueAt: 1000 } },
    { ...fact(5, 1000), type: 'TRIP_RETURNED', payload: { reason: 'COMPLETED', actualReturnedAt: 1000 } },
  ], rewards: [{ kind: 'XP', targetId: 'xp', amount: 18 }, { kind: 'COIN', targetId: 'coin', amount: 12 },
    { kind: 'ITEM', targetId: 'herb', amount: 3 }, { kind: 'CG', targetId: 'meadow:default', amount: 1 }],
} satisfies TripReport;

describe('travel metadata and prepared departure wire contract', () => {
  it('accepts truthful catalog and quote; a renderer cannot supply authored inputs', () => {
    expect(travelCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(travelPreviewSchema.parse(preview)).toEqual(preview);
    expect(tripPreparationPayloadSchema.parse(intent)).toEqual(intent);
    for (const addition of [{ power: 1000 }, { seed: 1 }, { energyCost10: 0 }, { route }, { expectedReturnAt: 100 }]) expect(tripPreparationPayloadSchema.safeParse({ ...intent, ...addition }).success).toBe(false);
  });
  it('bounds metadata and requires exact current supply stock IDs', () => {
    for (const change of [{ minLevel: 10 }, { durationMs: 0 }, { energyCost10: 1001 }, { requiredSupplies: [{ itemId: 'ration', quantity: 21 }] },
      { cgIds: ['duplicate', 'duplicate'] }]) expect(routeMetadataSchema.safeParse({ ...route, ...change }).success).toBe(false);
    for (const change of [{ routes: [route, route] }, { supplyStock: [] }, { supplyStock: [{ itemId: 'other', quantity: 4 }] },
      { supplyStock: [{ itemId: 'ration', quantity: -1 }] }]) expect(travelCatalogSchema.safeParse({ ...catalog, ...change }).success).toBe(false);
  });
  it('requires positive bounded unique selected quantities', () => {
    for (const selectedSupplies of [[{ itemId: 'ration', quantity: 0 }], [{ itemId: 'ration', quantity: 1 }, { itemId: 'ration', quantity: 2 }],
      Array.from({ length: 9 }, (_, i) => ({ itemId: `item${i}`, quantity: 1 })), [{ itemId: '../../somewhere', quantity: 1 }]]) {
      expect(tripPreparationPayloadSchema.safeParse({ ...intent, selectedSupplies }).success).toBe(false);
    }
  });
  it('supports explicit blocked reasons and a stale catalog with zero quote', () => {
    expect(travelPreviewSchema.safeParse({ ...preview, eligible: false, reasons: [{ code: 'ENERGY_TOO_LOW', required10: 300, available10: 20 }] }).success).toBe(true);
    expect(travelPreviewSchema.safeParse({ ...preview, eligible: false, route: null, reasons: [{ code: 'ROUTE_CATALOG_VERSION_MISMATCH', expectedVersion: 1, receivedVersion: 2 }],
      energyCost10: 0, durationMs: 0, supplyConsumption: [] }).success).toBe(true);
    expect(travelPreviewSchema.safeParse({ ...preview, selectedSupplies: [], supplyConsumption: [], eligible: false,
      reasons: [{ code: 'MISSING_REQUIRED_SUPPLY', itemId: 'ration', selectedQuantity: 0, requiredQuantity: 1 }] }).success).toBe(true);
  });
  it('rejects fake eligibility, route metadata and costs, including plausible but unselected consumption', () => {
    for (const change of [{ eligible: false }, { requestedRouteId: 'other' }, { eligible: true, reasons: [{ code: 'ACTIVE_TRIP' }] },
      { energyCost10: 0 }, { durationMs: 1 }, { selectedSupplies: [], supplyConsumption: [] }, { supplyConsumption: [] },
      { route: null }, { eligible: false, reasons: [{ code: 'PET_NOT_HOME', presence: 'AWAY' }], supplyConsumption: [] }]) expect(travelPreviewSchema.safeParse({ ...preview, ...change }).success).toBe(false);
  });
});

describe('immutable historical departure and report projection', () => {
  it('accepts exact frozen loadout and complete fact/ledger history, also legacy unavailable loadout', () => {
    expect(tripDepartureLoadoutSchema.parse(loadout)).toEqual(loadout);
    expect(tripReportSchema.parse(report)).toEqual(report);
    expect(tripReportSchema.safeParse({ ...report, loadout: null }).success).toBe(true);
    expect(tripReportSchema.safeParse({ ...report, loadout: { ...loadout, stats: null, equipment: [{ ...loadout.equipment[0], bonus: null }] } }).success).toBe(true);
  });
  it('rejects duplicate frozen gear slot/instance and impossible power/levels', () => {
    for (const change of [{ level: 21 }, { battlePower: 1001 }, { equipment: [...loadout.equipment, ...loadout.equipment] },
      { equipment: [...loadout.equipment, { ...loadout.equipment[0], instanceId: 'another' }] },
      { equipment: [...loadout.equipment, { ...loadout.equipment[0], slot: 'ARMOR' }] }]) expect(tripDepartureLoadoutSchema.safeParse({ ...loadout, ...change }).success).toBe(false);
  });
  it('accepts an immediate recall, with no fabricated rewards or outbound facts', () => {
    const recalled = { ...report, actualReturnedAt: 300, returnReason: 'RECALLED', facts: [
      { ...fact(1, 100), type: 'RETURNING', payload: { reason: 'RECALLED', dueAt: 300 } },
      { ...fact(2, 300), type: 'TRIP_RETURNED', payload: { reason: 'RECALLED', actualReturnedAt: 300 } },
    ], rewards: [] };
    expect(tripReportSchema.safeParse(recalled).success).toBe(true);
  });
  it('rejects mixed pet/trip, duplicated nodes, unordered facts and fabricated terminal times', () => {
    const changeFact = (index: number, addition: Record<string, unknown>) => report.facts.map((entry, i) => i === index ? { ...entry, ...addition } : entry);
    for (const facts of [changeFact(0, { petId: 'pet-2' }), changeFact(0, { tripId: 'trip-2' }), changeFact(1, { sequence: 1 }),
      changeFact(1, { scheduledAt: 150 }), changeFact(0, { eventId: 'fake' }), changeFact(1, { payload: { ...report.facts[1]!.payload, nodeId: 'gather-1' } }),
      changeFact(4, { payload: { reason: 'RECALLED', actualReturnedAt: 1000 } }), report.facts.slice(0, -1)]) expect(tripReportSchema.safeParse({ ...report, facts }).success).toBe(false);
    for (const change of [{ readAt: 999 }, { departurePower: 55 }, { startAt: 2000 }, { actualReturnedAt: 999 }]) expect(tripReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
  });
  it('rejects extra, missing, doubled or altered committed rewards and losses claiming loot', () => {
    for (const rewards of [report.rewards.slice(0, -1), [...report.rewards, report.rewards[0]], [...report.rewards.slice(0, 3), { kind: 'CG', targetId: 'meadow:default', amount: 2 }],
      [...report.rewards.slice(0, 2), { kind: 'ITEM', targetId: 'herb', amount: 4 }, report.rewards[3]]]) expect(tripReportSchema.safeParse({ ...report, rewards }).success).toBe(false);
    expect(tripReportSchema.safeParse({ ...report, facts: report.facts.map((entry) => entry.type === 'BATTLE_RESOLVED' ? { ...entry, payload: { ...entry.payload, outcome: 'LOSS' } } : entry) }).success).toBe(false);
  });
  it('accepts a bounded round report only with matching rules, frozen stats, HP and turn order', () => {
    const { winChanceBps: _legacyProbability, ...payload } = report.facts[1]!.payload as Extract<TripReport['facts'][number], { type: 'BATTLE_RESOLVED' }>['payload'] & { winChanceBps: number };
    const battle = { rulesVersion: 'battle-v2', petStats: stats, petStartHp: stats.hp, petEndHp: stats.hp,
      enemy: { enemyId: 'slime', definitionVersion: 1, displayName: '史莱姆', stats: { hp: 12, atk: 9, def: 5, spd: 7, luk: 4 } },
      enemyEndHp: 0, outcome: 'WIN', termination: 'ENEMY_KO', rounds: [{ round: 1, first: 'PET', petHp: stats.hp, enemyHp: 0,
        actions: [{ actor: 'PET', hit: true, critical: false, damage: 12, targetHpBefore: 12, targetHpAfter: 0 }] }] };
    const asReport = (candidate: unknown) => ({ ...report, rulesVersion: 'trip-v2', facts: report.facts.map(entry =>
      entry.type === 'BATTLE_RESOLVED' ? { ...entry, payload: { ...payload, battle: candidate } } : entry) });
    const current = asReport(battle);
    expect(tripReportSchema.safeParse(current).success).toBe(true);
    expect(tripReportSchema.safeParse({ ...current, rulesVersion: 'trip-v1' }).success).toBe(false);
    expect(tripReportSchema.safeParse({ ...current, loadout: null }).success).toBe(false);
    expect(tripReportSchema.safeParse({ ...report, rulesVersion: 'trip-v2' }).success).toBe(false);
    expect(tripReportSchema.safeParse(asReport({ ...battle, petStats: { ...stats, atk: 99 } })).success).toBe(false);
    expect(tripReportSchema.safeParse(asReport({ ...battle, rounds: [{ ...battle.rounds[0], first: 'ENEMY' }] })).success).toBe(false);
    expect(tripReportSchema.safeParse(asReport({ ...battle, rounds: [battle.rounds[0], { ...battle.rounds[0], round: 2 }] })).success).toBe(false);

    const first = battle.rounds[0]!;
    const firstAction = first.actions[0]!;
    const withSkills = (skills: string[]) => ({ ...battle, rulesVersion: 'battle-v3', petSkill: 'KEEN_SHOT', boss: null,
      rounds: [{ ...first, actions: [{ ...firstAction, skills }] }] });
    const skilledHistory = (candidate: unknown) => ({ ...asReport(candidate), rulesVersion: 'trip-v3' });
    expect(tripReportSchema.safeParse(skilledHistory(withSkills(['KEEN_SHOT']))).success).toBe(true);
    expect(tripReportSchema.safeParse(skilledHistory(withSkills([]))).success).toBe(false);
    expect(tripReportSchema.safeParse(skilledHistory(withSkills(['GUARDIAN_FRENZY']))).success).toBe(false);
    expect(tripReportSchema.safeParse(skilledHistory({ ...withSkills(['KEEN_SHOT']), boss: 'RUINS_GUARDIAN' })).success).toBe(false);
    expect(tripReportSchema.safeParse(skilledHistory(battle)).success).toBe(false);
  });
  it('requires bounded pagination, exact count, stable ordering and pet scope', () => {
    const page = { revision: 7, petId: 'pet-1', offset: 0, limit: 10, total: 1, rows: [report] };
    expect(travelReportsPageSchema.parse(page)).toEqual(page);
    expect(travelReportsPageSchema.safeParse({ ...page, offset: 10, rows: [] }).success).toBe(true);
    for (const changes of [{ petId: 'pet-2' }, { total: 0 }, { total: 2 }, { limit: 21 }, { total: 2, rows: [report, report] }]) expect(travelReportsPageSchema.safeParse({ ...page, ...changes }).success).toBe(false);
    expect(travelReportsQuerySchema.safeParse({ offset: 0, limit: 20 }).success).toBe(true);
    expect(travelReportsQuerySchema.safeParse({ offset: 0, limit: 21 }).success).toBe(false);
  });
});
