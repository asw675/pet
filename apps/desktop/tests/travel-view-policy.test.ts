import { describe, expect, it } from 'vitest';
import { appSnapshotSchema, domainCommandSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import { travelCatalogSchema, travelPreviewSchema, travelReportsPageSchema, tripReportSchema } from '@pet-desktop/contracts/travel';
import type { TravelCatalog, TravelPreview, TravelReportsQuery, TravelReportsPage, TripPreparationPayload, TripReport } from '@pet-desktop/contracts/travel';
import { advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE } from '@pet-desktop/domain';
import { ROUTE_CATALOG, ROUTE_CATALOG_VERSION } from '@pet-desktop/domain/route-catalog';
import { previewTripPreparation } from '@pet-desktop/domain/trip-preparation';
import {
  confirmDeparture, createDepartureConfirmation, createTripPreparationPayload, preparationKey, previewMatchesPreparation,
  reportFactText, reportPageOffset, reportReadPayload, reportsMatchQuery, reportsQueryKey, rewardLabel, suppliesText,
  travelDuration, travelQueryCanAccept, travelReasonText, travelSnapshotsMatch, travelSupplyCount, usableTravelCatalog, usableTravelPreview, usableTravelReports,
} from '../src/renderer/shared/travel-view-policy';
import type { StampedTravelCatalog, StampedTravelPreview, StampedTravelReports } from '../src/renderer/shared/travel-view-policy';

const MINUTE = 60_000;
const GEN = 7;
const pet = (petId: string, characterId: string, nickname: string, edit: Partial<PetSnapshot> = {}): PetSnapshot => ({
  petId, characterId, nickname, presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL',
  visibility: petId === 'star' ? 'VISIBLE' : 'HIDDEN', moodScore: 70, healthPoints: 100, energy: 80,
  bond: 20, level: 10, xp: 1800, revision: 5, ...edit,
});
const star = pet('star', 'star-singer', '星咏');
const ranger = pet('ranger', 'fluffy-ranger', '绒绒', { level: 1, xp: 30, energy: 15 });
const snapshot = appSnapshotSchema.parse({ revision: 9, walletCoins: 5, primaryPetId: star.petId,
  doNotDisturb: false, pausedRender: false, pets: [star, ranger] });
const routes = ROUTE_CATALOG.map(({ route: _route, ...metadata }) => metadata);
const catalog = travelCatalogSchema.parse({ revision: snapshot.revision, routeCatalogVersion: ROUTE_CATALOG_VERSION, routes,
  supplyStock: [{ itemId: 'ration', quantity: 3 }, { itemId: 'healing-potion', quantity: 2 }] });
const catalogStamp: StampedTravelCatalog = { generation: GEN, snapshot, projection: catalog };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const forestPayload = createTripPreparationPayload(catalog, snapshot, star.petId, 'mist-forest', [{ itemId: 'ration', value: '1' }])!;
const ruinsPayload = createTripPreparationPayload(catalog, snapshot, star.petId, 'starfall-ruins',
  [{ itemId: 'healing-potion', value: '1' }, { itemId: 'ration', value: '2' }])!;

function projectAuthorityQuote(payload: TripPreparationPayload, source: AppSnapshot = snapshot, data: TravelCatalog = catalog): TravelPreview {
  const selected = source.pets.find(pet => pet.petId === payload.petId)!;
  const quote = previewTripPreparation({ routeId: payload.routeId, routeCatalogVersion: payload.routeCatalogVersion,
    pet: { presence: selected.presence, level: selected.level, hasActiveTrip: selected.trip?.status === 'TRAVELING',
      energy10: Math.round(selected.energy * 10), healthStatus: selected.healthStatus, healthPoints10: Math.round(selected.healthPoints * 10) },
    selectedSupplies: payload.selectedSupplies, inventory: data.supplyStock });
  const route = quote.route ? data.routes.find(candidate => candidate.routeId === quote.route?.routeId) : null;
  return travelPreviewSchema.parse({ revision: source.revision, petId: payload.petId, requestedRouteId: payload.routeId,
    routeCatalogVersion: quote.routeCatalogVersion, route, eligible: quote.eligible, reasons: quote.reasons,
    energyCost10: quote.energyCost10, durationMs: quote.durationMs, selectedSupplies: payload.selectedSupplies, supplyConsumption: quote.supplyConsumption });
}
function previewStamp(payload: TripPreparationPayload, source: AppSnapshot = snapshot, data: TravelCatalog = catalog): StampedTravelPreview {
  return { generation: GEN, snapshot: source, requested: payload, projection: projectAuthorityQuote(payload, source, data) };
}
const forestPreview = previewStamp(forestPayload);
const ruinsPreview = previewStamp(ruinsPayload);
const confirmation = (stamp: StampedTravelPreview, payload: TripPreparationPayload, source = snapshot, data = catalog, generation: number | null = GEN,
  allow = true) => createDepartureConfirmation(stamp, generation, source, data, payload, allow);

describe('travel catalog and query coherence', () => {
  it('uses actual three route definitions projected without simulator nodes and their actual time/cost/supplies', () => {
    expect(catalog.routes.map(route => [route.routeId, travelDuration(route.durationMs), route.energyCost10])).toEqual([
      ['morning-dew-meadow', '15 分钟', 150], ['mist-forest', '1 小时', 300], ['starfall-ruins', '4 小时', 500],
    ]);
    expect(catalog.routes.every(route => !Object.hasOwn(route, 'nodes'))).toBe(true);
    expect(suppliesText(catalog.routes[0]!.requiredSupplies)).toBe('不消耗补给');
    expect(travelSupplyCount(catalog, 'ration')).toBe(3);
    expect(travelSupplyCount(catalog, 'not-in-catalog')).toBe(0);
  });
  it('requires correct generation, revision and exact actual source snapshot even if pet array order changes', () => {
    expect(usableTravelCatalog(catalogStamp, GEN, snapshot)).toBe(catalog);
    expect(usableTravelCatalog(catalogStamp, GEN - 1, snapshot)).toBeNull();
    expect(usableTravelCatalog(catalogStamp, null, snapshot)).toBeNull();
    expect(usableTravelCatalog(catalogStamp, GEN, null)).toBeNull();
    expect(travelSnapshotsMatch(snapshot, { ...snapshot, pets: [...snapshot.pets].reverse() })).toBe(true);
    for (const change of [{ revision: 10 }, { walletCoins: 6 }, { primaryPetId: ranger.petId },
      { pets: [{ ...star, energy: 79 }, ranger] }, { pets: [ranger, ranger] }]) {
      expect(usableTravelCatalog(catalogStamp, GEN, { ...snapshot, ...change })).toBeNull();
    }
  });
  it('never stamps an older or contradictory late result, awaits exact source snapshot for an ahead response', () => {
    expect(travelQueryCanAccept(9, snapshot, snapshot, 9)).toBe(true);
    expect(travelQueryCanAccept(9, snapshot, snapshot, 10)).toBe(false);
    expect(travelQueryCanAccept(9, snapshot, { ...snapshot, revision: 10 }, 9)).toBe(false);
    expect(travelQueryCanAccept(9, { ...snapshot, walletCoins: 99 }, snapshot, 9)).toBe(false);
    const ahead = { ...snapshot, revision: 12 };
    const next = { ...catalog, revision: 12 };
    expect(travelQueryCanAccept(12, ahead, snapshot, 9)).toBe(true);
    expect(usableTravelCatalog({ generation: GEN, snapshot: ahead, projection: next }, GEN, snapshot)).toBeNull();
    expect(usableTravelCatalog({ generation: GEN, snapshot: ahead, projection: next }, GEN, ahead)).toBe(next);
  });
});

describe('closed supply intent and exact authority preview', () => {
  it('offers supply-free meadow and explicit unfilled forest without inventing costs or consuming stock', () => {
    const meadow = createTripPreparationPayload(catalog, snapshot, ranger.petId, 'morning-dew-meadow', []);
    expect(meadow).toEqual({ petId: 'ranger', routeId: 'morning-dew-meadow', routeCatalogVersion: 1, selectedSupplies: [] });
    const unfilled = createTripPreparationPayload(catalog, snapshot, star.petId, 'mist-forest', [{ itemId: 'ration', value: '0' }])!;
    expect(unfilled.selectedSupplies).toEqual([]);
    const before = JSON.stringify([catalog, snapshot]);
    const quote = projectAuthorityQuote(unfilled);
    expect(quote.eligible).toBe(false);
    expect(quote.reasons.map(reason => reason.code)).toContain('MISSING_REQUIRED_SUPPLY');
    expect(quote.supplyConsumption).toEqual([]);
    expect(JSON.stringify([catalog, snapshot])).toBe(before);
  });
  it('records explicit exact ruins supply in configured route order, independent of UI input order', () => {
    expect(ruinsPayload).toEqual({ petId: 'star', routeId: 'starfall-ruins', routeCatalogVersion: 1,
      selectedSupplies: [{ itemId: 'ration', quantity: 2 }, { itemId: 'healing-potion', quantity: 1 }] });
    expect(preparationKey(ruinsPayload)).toBe(preparationKey({ ...ruinsPayload, selectedSupplies: [...ruinsPayload.selectedSupplies].reverse() }));
  });
  it.each(['', '-1', '1.5', '01', '1e1', ' 1', '3', '21'])('rejects malformed/over-selected supply quantity %s', (value) => {
    expect(createTripPreparationPayload(catalog, snapshot, star.petId, 'starfall-ruins', [{ itemId: 'ration', value }])).toBeUndefined();
  });
  it('rejects unavailable pet/route, duplicate or unoffered supplies and an old catalog revision', () => {
    expect(createTripPreparationPayload(catalog, snapshot, 'unknown', 'mist-forest', [])).toBeUndefined();
    expect(createTripPreparationPayload(catalog, snapshot, star.petId, 'unknown', [])).toBeUndefined();
    expect(createTripPreparationPayload(catalog, snapshot, star.petId, 'mist-forest', [{ itemId: 'herb', value: '1' }])).toBeUndefined();
    expect(createTripPreparationPayload(catalog, snapshot, star.petId, 'mist-forest', [{ itemId: 'ration', value: '1' }, { itemId: 'ration', value: '0' }])).toBeUndefined();
    expect(createTripPreparationPayload({ ...catalog, revision: 8 }, snapshot, star.petId, 'mist-forest', [])).toBeUndefined();
  });
  it('uses exact requested pet, route, selected quantity, catalog metadata and same-generation preview', () => {
    expect(previewMatchesPreparation(ruinsPreview.projection, ruinsPayload)).toBe(true);
    expect(usableTravelPreview(ruinsPreview, GEN, snapshot, catalog, ruinsPayload)).toBe(ruinsPreview.projection);
    expect(usableTravelPreview(ruinsPreview, GEN, snapshot, catalog, forestPayload)).toBeNull();
    expect(usableTravelPreview(ruinsPreview, GEN - 1, snapshot, catalog, ruinsPayload)).toBeNull();
    expect(usableTravelPreview(ruinsPreview, GEN, { ...snapshot, revision: 10 }, { ...catalog, revision: 10 }, ruinsPayload)).toBeNull();
    expect(usableTravelPreview({ ...ruinsPreview, projection: { ...ruinsPreview.projection, petId: 'ranger' } }, GEN, snapshot, catalog, ruinsPayload)).toBeNull();
    const changedCatalog = { ...catalog, routes: catalog.routes.map(route => route.routeId === 'starfall-ruins' ? { ...route, durationMs: route.durationMs + 1 } : route) };
    expect(usableTravelPreview(ruinsPreview, GEN, snapshot, changedCatalog, ruinsPayload)).toBeNull();
    expect(previewMatchesPreparation(ruinsPreview.projection, { ...ruinsPayload, selectedSupplies: [] })).toBe(false);
  });
  it('displays an actual authority ineligible quote and reasons for low level, energy and incomplete supplies without confirmation', () => {
    const requested = createTripPreparationPayload(catalog, snapshot, ranger.petId, 'starfall-ruins', [])!;
    const stamp = previewStamp(requested);
    const preview = usableTravelPreview(stamp, GEN, snapshot, catalog, requested)!;
    expect(preview.eligible).toBe(false);
    expect(preview.energyCost10).toBe(500);
    expect(preview.durationMs).toBe(240 * MINUTE);
    expect(preview.reasons.map(travelReasonText)).toEqual([
      '等级不足：当前 Lv.1，需要 Lv.10。', '精力不足：当前 15，需要 50。',
      '缺少选择：旅行口粮（ration） 需要 2，已选 0。', '缺少选择：恢复药水（healing-potion） 需要 1，已选 0。',
    ]);
    expect(confirmation(stamp, requested)).toBeUndefined();
  });
  it('records actual stock shortage or PET_BUSY instead of treating an exact selection as automatic eligibility', () => {
    const low = { ...catalog, supplyStock: [{ itemId: 'ration', quantity: 0 }, { itemId: 'healing-potion', quantity: 2 }] };
    const stamp = previewStamp(forestPayload, snapshot, low);
    expect(stamp.projection.reasons.map(travelReasonText).join(' ')).toContain('实际持有 0');
    expect(confirmation(stamp, forestPayload, snapshot, low)).toBeUndefined();
    expect(travelReasonText({ code: 'PET_BUSY', activity: 'CHAT' })).toContain('结束对话');
  });
});

describe('explicit prepared-departure confirmation guard', () => {
  it.each([[forestPreview, forestPayload, 300, 60 * MINUTE], [ruinsPreview, ruinsPayload, 500, 240 * MINUTE]] as const)(
    'quotes complete actual authority cost/time and sends only sanctioned chosen input', (stamp, payload, cost, duration) => {
      const before = JSON.stringify([catalog, snapshot, stamp]);
      const quote = confirmation(stamp, payload)!;
      expect(quote).toMatchObject({ generation: GEN, revision: snapshot.revision, catalogVersion: catalog.routeCatalogVersion,
        energyCost10: cost, durationMs: duration, petName: '星咏', energyNow: star.energy });
      expect(quote.supplies).toEqual(payload.selectedSupplies);
      expect(Object.isFrozen(quote)).toBe(true);
      expect(Object.isFrozen(quote.payload.selectedSupplies)).toBe(true);
      const intent = confirmDeparture(quote, stamp, GEN, snapshot, catalog, payload, true);
      expect(intent).toEqual(payload);
      expect(domainCommandSchema.safeParse({ type: 'TRIP_START_PREPARED', payload: intent, commandId: 'ui-gesture', issuedAt: 1,
        expectedRevision: quote.revision }).success).toBe(true);
      expect(Object.keys(intent!).sort()).toEqual(['petId', 'routeCatalogVersion', 'routeId', 'selectedSupplies']);
      expect(JSON.stringify([catalog, snapshot, stamp])).toBe(before);
    },
  );
  it('invalidates an old confirmation when generation, revision, chosen intent, supplied price evidence or action readiness changes', () => {
    const quote = confirmation(ruinsPreview, ruinsPayload)!;
    expect(confirmDeparture(quote, ruinsPreview, GEN + 1, snapshot, catalog, ruinsPayload, true)).toBeUndefined();
    expect(confirmDeparture(quote, ruinsPreview, GEN, snapshot, catalog, ruinsPayload, false)).toBeUndefined();
    expect(confirmDeparture(quote, ruinsPreview, GEN, snapshot, catalog, forestPayload, true)).toBeUndefined();
    const later = { ...snapshot, revision: 10 };
    const nextCatalog = { ...catalog, revision: 10 };
    const next = previewStamp(ruinsPayload, later, nextCatalog);
    expect(confirmDeparture(quote, next, GEN, later, nextCatalog, ruinsPayload, true)).toBeUndefined();
    const changedStock = { ...catalog, supplyStock: [{ itemId: 'ration', quantity: 4 }, { itemId: 'healing-potion', quantity: 2 }] };
    expect(confirmDeparture(quote, ruinsPreview, GEN, snapshot, changedStock, ruinsPayload, true)).toBeUndefined();
  });
  it('fails closed if a retained eligible quote contradicts actual energy, busy activity, travel, health or inventory', () => {
    const changed = (edit: Partial<PetSnapshot>) => ({ ...snapshot, pets: [{ ...star, ...edit }, ranger] });
    for (const edit of [{ energy: 0 }, { activity: 'DRAG' as const }, { activity: 'CHAT' as const }, { healthStatus: 'INJURED' as const },
      { level: 1 }, { presence: 'AWAY' as const, activity: null }]) {
      const revised = changed(edit);
      expect(confirmation({ ...forestPreview, snapshot: revised }, forestPayload, revised)).toBeUndefined();
    }
    const noStock = { ...catalog, supplyStock: [{ itemId: 'ration', quantity: 0 }, { itemId: 'healing-potion', quantity: 2 }] };
    expect(confirmation(forestPreview, forestPayload, snapshot, noStock)).toBeUndefined();
  });
  it('also fails closed on a malformed same-revision cost or missing required supply despite a claimed eligible flag', () => {
    expect(confirmation({ ...forestPreview, projection: { ...forestPreview.projection, energyCost10: 1 } }, forestPayload)).toBeUndefined();
    expect(confirmation({ ...forestPreview, projection: { ...forestPreview.projection, durationMs: 1 } }, forestPayload)).toBeUndefined();
    const absent = { ...forestPayload, selectedSupplies: [] };
    expect(confirmation({ ...forestPreview, requested: absent, projection: { ...forestPreview.projection, selectedSupplies: [], supplyConsumption: [] } }, absent)).toBeUndefined();
  });
});

function settledReport(tripId: string, petId: string, startAt: number, loadout: TripReport['loadout'] = null): TripReport {
  const history = createTripSnapshot({ tripId, petId, startAt, seed: 8, power: 20, route: DEMO_ROUTE });
  const completed = advanceTrip(history, createTripCheckpoint(history), startAt + 15 * MINUTE);
  return tripReportSchema.parse({
    tripId, petId, routeId: history.routeId, contentVersion: history.contentVersion, rulesVersion: history.rulesVersion,
    startAt, expectedReturnAt: history.expectedReturnAt, actualReturnedAt: completed.checkpoint.actualReturnedAt,
    readAt: null, returnReason: completed.checkpoint.returnReason, departurePower: 20, loadout, facts: completed.facts,
    rewards: [
      { kind: 'XP', targetId: 'xp', amount: completed.rewardDraft.xp },
      { kind: 'COIN', targetId: 'coin', amount: completed.rewardDraft.coins },
      ...completed.rewardDraft.items.map(item => ({ kind: 'ITEM', targetId: item.itemId, amount: item.quantity })),
      ...completed.rewardDraft.cgIds.map(cgId => ({ kind: 'CG', targetId: `${cgId}:default`, amount: 1 })),
    ],
  });
}
const oldReport = settledReport('old-trip', star.petId, 1000);
const frozenReport = settledReport('new-trip', star.petId, 1000 + 20 * MINUTE, {
  routeCatalogVersion: 1, itemCatalogVersion: 1, level: 1, energyCost10: 150, supplies: [], battlePower: 20,
  stats: { hp: 75, atk: 20, def: 12, spd: 14, luk: 16 },
  equipment: [{ slot: 'WEAPON', instanceId: 'historical-weapon', definitionId: 'old-definition', definitionVersion: 1, enhancement: 2,
    bonus: null }],
});
const historyQuery: TravelReportsQuery = { petId: star.petId, offset: 0, limit: 1 };
const historyPage = travelReportsPageSchema.parse({ revision: snapshot.revision, petId: star.petId, offset: 0, limit: 1, total: 2, rows: [frozenReport] });
const historyStamp: StampedTravelReports = { generation: GEN, snapshot, query: historyQuery, projection: historyPage };

describe('real settled history, exact pagination and mark-read commands', () => {
  it('holds a report page only for the identical filter/offset/limit/generation/revision', () => {
    expect(reportsMatchQuery(historyPage, historyQuery)).toBe(true);
    expect(usableTravelReports(historyStamp, GEN, snapshot, historyQuery)).toBe(historyPage);
    expect(usableTravelReports(historyStamp, GEN + 1, snapshot, historyQuery)).toBeNull();
    expect(usableTravelReports(historyStamp, GEN, { ...snapshot, revision: 10 }, historyQuery)).toBeNull();
    for (const changed of [{ ...historyQuery, offset: 1 }, { ...historyQuery, petId: ranger.petId }, { ...historyQuery, limit: 2 }]) {
      expect(reportsQueryKey(changed)).not.toBe(reportsQueryKey(historyQuery));
      expect(usableTravelReports(historyStamp, GEN, snapshot, changed)).toBeNull();
    }
  });
  it('permits all actual historical pages and never creates results outside the query bound', () => {
    expect(reportPageOffset(historyPage, -1)).toBeUndefined();
    expect(reportPageOffset(historyPage, 1)).toBe(1);
    const second: TravelReportsPage = { ...historyPage, offset: 1, rows: [oldReport] };
    expect(reportPageOffset(second, -1)).toBe(0);
    expect(reportPageOffset(second, 1)).toBeUndefined();
    expect(reportPageOffset({ ...second, offset: 1_000_000, total: 1_100_000 }, 1)).toBeUndefined();
  });
  it('requires exact current unread report identity; old read state, wrong pet and stale revision are not actionable', () => {
    const before = JSON.stringify(historyPage);
    expect(reportReadPayload(historyPage, snapshot, frozenReport, true)).toEqual({ petId: star.petId, tripId: frozenReport.tripId });
    expect(reportReadPayload(historyPage, snapshot, oldReport, true)).toBeUndefined();
    expect(reportReadPayload(historyPage, snapshot, { ...frozenReport, petId: ranger.petId }, true)).toBeUndefined();
    expect(reportReadPayload(historyPage, snapshot, { ...frozenReport, readAt: 9999 }, true)).toBeUndefined();
    expect(reportReadPayload(historyPage, { ...snapshot, revision: 10 }, frozenReport, true)).toBeUndefined();
    expect(reportReadPayload(historyPage, snapshot, frozenReport, false)).toBeUndefined();
    expect(reportReadPayload(historyPage, { ...snapshot, pets: [ranger] }, frozenReport, true)).toBeUndefined();
    expect(JSON.stringify(historyPage)).toBe(before);
  });
  it('uses actual trip-v1 ledger/fact values and preserves null legacy departure instead of today\'s equipment', () => {
    expect(oldReport.loadout).toBeNull();
    expect(frozenReport.loadout?.equipment[0]?.instanceId).toBe('historical-weapon');
    expect(frozenReport.loadout?.equipment[0]?.bonus).toBeNull();
    expect(oldReport.departurePower).toBe(20);
    expect(oldReport.facts.map(reportFactText).map(item => item.title)).toEqual(['完成采集', '战斗胜利', '旅行事件', '进入返程', '已归家结算']);
    expect(oldReport.facts.map(reportFactText)[1]?.text).toContain('史莱姆凝胶');
    expect(oldReport.facts.map(reportFactText)[2]?.text).toContain('morning-dew');
    expect(oldReport.rewards.map(rewardLabel)).toEqual(['经验', '游戏金币', '草药（herb）', '史莱姆凝胶（slime-gel）', 'CG 记录 · morning-dew:default']);
    expect(oldReport.rewards.map(reward => reward.amount)).toEqual([24, 8, 1, 1, 1]);
    expect(clone(oldReport).loadout).toBeNull();
  });
});
