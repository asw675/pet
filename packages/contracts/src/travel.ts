import { z } from 'zod';
import { battleStatsSchema, equipmentSlotSchema, enhancementSchema } from '@pet-desktop/contracts/inventory';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const level = positive.max(20);
const score10 = integer.max(1000);
const duration = positive.max(7 * 24 * 60 * 60_000);
const supply = z.strictObject({ itemId: id, quantity: positive.max(20) });
export const tripSuppliesSchema = z.array(supply).max(8).refine((items) => new Set(items.map((item) => item.itemId)).size === items.length, 'Duplicate trip supply');
export type TripSupplies = z.infer<typeof tripSuppliesSchema>;
const idList = z.array(id).max(12).refine((values) => new Set(values).size === values.length);

/** A catalog exposes authored metadata, never simulator input/seed. */
export const routeMetadataSchema = z.strictObject({
  routeId: id, contentVersion: positive, title: z.string().min(1).max(80), description: z.string().min(1).max(512),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']), minLevel: level, recommendedMaxLevel: level,
  energyCost10: score10.min(1), durationMs: duration, requiredSupplies: tripSuppliesSchema,
  rewardItemIds: idList, cgIds: idList,
}).refine((route) => route.minLevel <= route.recommendedMaxLevel, 'Invalid route level range');
export type RouteMetadata = z.infer<typeof routeMetadataSchema>;

export const travelCatalogSchema = z.strictObject({
  revision: integer, routeCatalogVersion: positive, routes: z.array(routeMetadataSchema).min(1).max(64),
  supplyStock: z.array(z.strictObject({ itemId: id, quantity: integer })).max(256),
}).superRefine((catalog, ctx) => {
  if (new Set(catalog.routes.map((route) => route.routeId)).size !== catalog.routes.length) ctx.addIssue({ code: 'custom', path: ['routes'], message: 'Duplicate current route' });
  const required = new Set(catalog.routes.flatMap((route) => route.requiredSupplies.map((item) => item.itemId)));
  if (catalog.supplyStock.length !== required.size || new Set(catalog.supplyStock.map((item) => item.itemId)).size !== required.size
    || !catalog.supplyStock.every((entry) => required.has(entry.itemId))) ctx.addIssue({ code: 'custom', path: ['supplyStock'], message: 'Stock must contain the exact catalog supply IDs' });
});
export type TravelCatalog = z.infer<typeof travelCatalogSchema>;

/** Same closed input for read-only preview and committed departure. No user
 * provided costs, power, stats, seeds, route definitions, or timestamps. */
export const tripPreparationPayloadSchema = z.strictObject({ petId: id, routeId: id, routeCatalogVersion: positive, selectedSupplies: tripSuppliesSchema });
export type TripPreparationPayload = z.infer<typeof tripPreparationPayloadSchema>;
const presence = z.enum(['HOME', 'AWAY', 'RETURNING']);
const health = z.enum(['NORMAL', 'INJURED', 'RECOVERING']);
const reason = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('ROUTE_CATALOG_VERSION_MISMATCH'), expectedVersion: positive, receivedVersion: positive }),
  z.strictObject({ code: z.literal('ROUTE_NOT_FOUND'), routeId: id }),
  z.strictObject({ code: z.literal('PET_NOT_HOME'), presence }),
  z.strictObject({ code: z.literal('ACTIVE_TRIP') }),
  z.strictObject({ code: z.literal('PET_UNHEALTHY'), healthStatus: health, healthPoints10: score10 }),
  z.strictObject({ code: z.literal('LEVEL_TOO_LOW'), requiredLevel: level, level }),
  z.strictObject({ code: z.literal('ENERGY_TOO_LOW'), required10: score10, available10: score10 }),
  z.strictObject({ code: z.literal('INVALID_SUPPLY_SELECTION'), detail: z.enum(['NOT_ARRAY', 'TOO_MANY_ENTRIES', 'INVALID_ENTRY', 'INVALID_ITEM_ID', 'INVALID_QUANTITY', 'DUPLICATE_ITEM']), index: integer.nullable(), itemId: id.nullable() }),
  z.strictObject({ code: z.literal('SUPPLY_NOT_ALLOWED'), itemId: id, selectedQuantity: positive.max(20) }),
  z.strictObject({ code: z.literal('MISSING_REQUIRED_SUPPLY'), itemId: id, requiredQuantity: positive.max(20), selectedQuantity: integer.max(20) }),
  z.strictObject({ code: z.literal('EXCESS_SUPPLY'), itemId: id, maxQuantity: positive.max(20), selectedQuantity: positive.max(20) }),
  z.strictObject({ code: z.literal('SUPPLY_OUT_OF_STOCK'), itemId: id, requiredQuantity: positive.max(20), availableQuantity: integer }),
]);
export type TravelPreparationReason = z.infer<typeof reason>;
const sameSupplies = (left: TripSupplies, right: TripSupplies): boolean => left.length === right.length
  && left.every((item) => right.some((other) => other.itemId === item.itemId && other.quantity === item.quantity));

/** Exact authority quote, only actionable at the returned revision. */
export const travelPreviewSchema = z.strictObject({
  revision: integer, petId: id, routeCatalogVersion: positive, requestedRouteId: id, route: routeMetadataSchema.nullable(),
  eligible: z.boolean(), reasons: z.array(reason).max(32), energyCost10: score10, durationMs: integer.max(7 * 24 * 60 * 60_000),
  selectedSupplies: tripSuppliesSchema, supplyConsumption: tripSuppliesSchema,
}).superRefine((quote, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (quote.eligible !== (quote.reasons.length === 0) || (quote.eligible && !quote.route)) reject('Eligibility contradicts reasons or route');
  if (!quote.route) {
    if (quote.energyCost10 !== 0 || quote.durationMs !== 0 || quote.supplyConsumption.length !== 0
      || !quote.reasons.some((entry) => entry.code === 'ROUTE_NOT_FOUND' || entry.code === 'ROUTE_CATALOG_VERSION_MISMATCH')) reject('Absent route must have zero quote and route reason');
    return;
  }
  if (quote.route.routeId !== quote.requestedRouteId || quote.energyCost10 !== quote.route.energyCost10 || quote.durationMs !== quote.route.durationMs) reject('Route identity or costs contradict the catalog');
  const exact = sameSupplies(quote.selectedSupplies, quote.route.requiredSupplies);
  if ((quote.eligible && !exact) || !sameSupplies(quote.supplyConsumption, exact ? quote.route.requiredSupplies : [])) reject('Quoted supply costs contradict the selection');
});
export type TravelPreview = z.infer<typeof travelPreviewSchema>;

/** Historical prepared departure sidecar. Existing trip-v1 saves may have no
 * sidecar: legacy history is rendered as unknown, never today's loadout. */
export const tripDepartureLoadoutSchema = z.strictObject({
  routeCatalogVersion: positive, itemCatalogVersion: positive, level,
  energyCost10: score10.min(1), supplies: tripSuppliesSchema,
  stats: battleStatsSchema.refine((stats) => stats.hp > 0).nullable(), battlePower: positive.max(1000),
  equipment: z.array(z.strictObject({ slot: equipmentSlotSchema, instanceId: id, definitionId: id, definitionVersion: positive,
    enhancement: enhancementSchema, bonus: battleStatsSchema.nullable() })).max(3),
}).superRefine((loadout, ctx) => {
  if (new Set(loadout.equipment.map((entry) => entry.slot)).size !== loadout.equipment.length
    || new Set(loadout.equipment.map((entry) => entry.instanceId)).size !== loadout.equipment.length) ctx.addIssue({ code: 'custom', path: ['equipment'], message: 'Duplicate frozen equipment slot or instance' });
});
export type TripDepartureLoadout = z.infer<typeof tripDepartureLoadoutSchema>;

const returnReason = z.enum(['COMPLETED', 'RECALLED', 'DEFEATED']);
const factFields = { eventId: z.string().min(1).max(140), tripId: id, petId: id, sequence: positive.max(14), scheduledAt: integer };
const itemReward = z.strictObject({ itemId: id, quantity: positive });
export const tripReportFactSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...factFields, type: z.literal('GATHER_RESOLVED'), payload: z.strictObject({ nodeId: id, itemId: id, quantity: positive, xp: integer }) }),
  z.strictObject({ ...factFields, type: z.literal('BATTLE_RESOLVED'), payload: z.strictObject({ nodeId: id, enemyId: id, outcome: z.enum(['WIN', 'LOSS']), winChanceBps: integer.max(10_000), xp: integer, coins: integer, drop: itemReward.nullable() }) }),
  z.strictObject({ ...factFields, type: z.literal('EVENT_RESOLVED'), payload: z.strictObject({ nodeId: id, eventDefId: id, cgId: id.nullable() }) }),
  z.strictObject({ ...factFields, type: z.literal('RETURNING'), payload: z.strictObject({ reason: returnReason, dueAt: integer }) }),
  z.strictObject({ ...factFields, type: z.literal('TRIP_RETURNED'), payload: z.strictObject({ reason: returnReason, actualReturnedAt: integer }) }),
]);
export type TripReportFact = z.infer<typeof tripReportFactSchema>;
const rewardLine = z.strictObject({ kind: z.enum(['XP', 'COIN', 'ITEM', 'CG']), targetId: z.string().min(1).max(256), amount: positive });

/** Read-only settled history. Rewards are committed ledger facts, not
 * speculative drops/checkpoints. The report does not depend on the latest
 * pet equipment/catalog or even the route remaining installed. */
export const tripReportSchema = z.strictObject({
  tripId: id, petId: id, routeId: id, contentVersion: positive, rulesVersion: id,
  startAt: integer, expectedReturnAt: integer, actualReturnedAt: integer, readAt: integer.nullable(),
  returnReason, departurePower: positive.max(1000), loadout: tripDepartureLoadoutSchema.nullable(),
  facts: z.array(tripReportFactSchema).min(2).max(14), rewards: z.array(rewardLine).max(26),
}).superRefine((report, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (report.startAt >= report.expectedReturnAt || report.startAt >= report.actualReturnedAt
    || (report.readAt !== null && report.readAt < report.actualReturnedAt)
    || (report.loadout !== null && report.loadout.battlePower !== report.departurePower)) reject('Inconsistent report times or frozen power');
  let previous = report.startAt;
  const nodes = new Set<string>();
  const expectedRewards = new Map<string, number>();
  const add = (kind: 'XP' | 'COIN' | 'ITEM' | 'CG', target: string, amount: number) => {
    if (amount === 0) return;
    const key = `${kind}:${target}`;
    expectedRewards.set(key, kind === 'CG' ? 1 : (expectedRewards.get(key) ?? 0) + amount);
  };
  for (const [index, fact] of report.facts.entries()) {
    if (fact.tripId !== report.tripId || fact.petId !== report.petId || fact.sequence !== index + 1 || fact.eventId !== `${report.tripId}:${index + 1}`
      || fact.scheduledAt < previous || fact.scheduledAt > report.actualReturnedAt) reject('Fact identity or order contradicts report');
    previous = fact.scheduledAt;
    if (index === report.facts.length - 2) {
      if (fact.type !== 'RETURNING' || fact.payload.reason !== report.returnReason || fact.payload.dueAt !== report.actualReturnedAt) reject('Missing return transition');
    } else if (index === report.facts.length - 1) {
      if (fact.type !== 'TRIP_RETURNED' || fact.payload.reason !== report.returnReason || fact.payload.actualReturnedAt !== report.actualReturnedAt
        || fact.scheduledAt !== report.actualReturnedAt) reject('Missing matching terminal fact');
    } else if (fact.type === 'RETURNING' || fact.type === 'TRIP_RETURNED') reject('Unexpected early return fact');
    if ('nodeId' in fact.payload) {
      if (nodes.has(fact.payload.nodeId)) reject('Duplicate route node fact');
      nodes.add(fact.payload.nodeId);
    }
    if (fact.type === 'GATHER_RESOLVED') { add('ITEM', fact.payload.itemId, fact.payload.quantity); add('XP', 'xp', fact.payload.xp); }
    if (fact.type === 'BATTLE_RESOLVED') {
      if (fact.payload.outcome === 'LOSS' && (fact.payload.coins !== 0 || fact.payload.drop !== null)) reject('Losing battle has win rewards');
      add('XP', 'xp', fact.payload.xp); add('COIN', 'coin', fact.payload.coins);
      if (fact.payload.drop) add('ITEM', fact.payload.drop.itemId, fact.payload.drop.quantity);
    }
    if (fact.type === 'EVENT_RESOLVED' && fact.payload.cgId !== null) add('CG', `${fact.payload.cgId}:default`, 1);
  }
  const keys = new Set(report.rewards.map((entry) => `${entry.kind}:${entry.targetId}`));
  if (report.rewards.length !== expectedRewards.size || keys.size !== report.rewards.length || report.rewards.some((entry) => expectedRewards.get(`${entry.kind}:${entry.targetId}`) !== entry.amount)) reject('Committed rewards contradict historical facts');
});
export type TripReport = z.infer<typeof tripReportSchema>;

export const travelReportsQuerySchema = z.strictObject({ petId: id.optional(), offset: integer.max(1_000_000), limit: positive.max(20) });
export type TravelReportsQuery = z.infer<typeof travelReportsQuerySchema>;
export const travelReportsPageSchema = z.strictObject({ revision: integer, petId: id.nullable(), offset: integer.max(1_000_000), limit: positive.max(20),
  total: integer, rows: z.array(tripReportSchema).max(20) }).superRefine((page, ctx) => {
  if (page.rows.length !== Math.min(page.limit, Math.max(0, page.total - page.offset))
    || new Set(page.rows.map((row) => row.tripId)).size !== page.rows.length
    || (page.petId !== null && page.rows.some((row) => row.petId !== page.petId))) ctx.addIssue({ code: 'custom', message: 'Report page count, scope or identities do not match' });
  for (let i = 1; i < page.rows.length; i++) {
    const previous = page.rows[i - 1]!, current = page.rows[i]!;
    if (previous.actualReturnedAt < current.actualReturnedAt || (previous.actualReturnedAt === current.actualReturnedAt && previous.tripId >= current.tripId)) ctx.addIssue({ code: 'custom', path: ['rows', i], message: 'Report history must sort by return time descending, ID ascending' });
  }
});
export type TravelReportsPage = z.infer<typeof travelReportsPageSchema>;
