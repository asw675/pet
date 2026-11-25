import type { AppSnapshot } from '@pet-desktop/contracts';
import { tripPreparationPayloadSchema, travelReportsQuerySchema } from '@pet-desktop/contracts/travel';
import type {
  RouteMetadata, TravelCatalog, TravelPreparationReason, TravelPreview, TravelReportsPage, TravelReportsQuery,
  TripPreparationPayload, TripReport, TripReportFact, TripSupplies,
} from '@pet-desktop/contracts/travel';

export const travelRiskLabel: Readonly<Record<RouteMetadata['risk'], string>> = Object.freeze({
  LOW: '低风险', MEDIUM: '中等风险', HIGH: '高风险',
});
export const returnReasonLabel: Readonly<Record<TripReport['returnReason'], string>> = Object.freeze({
  COMPLETED: '正常归来', RECALLED: '主动召回', DEFEATED: '战斗失败撤退',
});

/** Labels are only readable aliases for known stable IDs; the actual
 * historical identity is always shown. No current catalog grant is inferred. */
export function travelItemLabel(itemId: string): string {
  switch (itemId) {
    case 'herb': return '草药（herb）';
    case 'slime-gel': return '史莱姆凝胶（slime-gel）';
    case 'forest-wood': return '林地木材（forest-wood）';
    case 'ruin-shard': return '遗迹碎片（ruin-shard）';
    case 'ration': return '旅行口粮（ration）';
    case 'healing-potion': return '恢复药水（healing-potion）';
    default: return itemId;
  }
}
export function travelDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 1) return '—';
  const seconds = Math.floor(ms / 1000);
  const pieces: string[] = [];
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  if (hours) pieces.push(`${hours} 小时`);
  if (minutes) pieces.push(`${minutes} 分钟`);
  if (rest) pieces.push(`${rest} 秒`);
  if (ms % 1000) pieces.push(`${ms % 1000} 毫秒`);
  return pieces.join(' ');
}
export const suppliesText = (supplies: TripSupplies): string => supplies.length
  ? supplies.map(supply => `${travelItemLabel(supply.itemId)} × ${supply.quantity}`).join('、') : '不消耗补给';

/** Supplemental query results require the same authoritative snapshot,
 * including actual chosen pet, not just an equal generation/revision number. */
export function travelSnapshotsMatch(left: AppSnapshot, right: AppSnapshot): boolean {
  if (left.revision !== right.revision || left.walletCoins !== right.walletCoins || left.primaryPetId !== right.primaryPetId
    || left.doNotDisturb !== right.doNotDisturb || left.pausedRender !== right.pausedRender || left.pets.length !== right.pets.length) return false;
  const map = new Map(left.pets.map(pet => [pet.petId, pet]));
  return map.size === left.pets.length && new Set(right.pets.map(pet => pet.petId)).size === right.pets.length
    && right.pets.every(pet => JSON.stringify(map.get(pet.petId)) === JSON.stringify(pet));
}

export function travelQueryCanAccept(revision: number, returnedSnapshot: AppSnapshot, current: AppSnapshot | null, baseRevision: number): boolean {
  return current !== null && revision === returnedSnapshot.revision && revision >= baseRevision && revision >= current.revision
    && (revision > current.revision || travelSnapshotsMatch(returnedSnapshot, current));
}

interface StampedQuery<Projection> {
  readonly generation: number;
  readonly snapshot: AppSnapshot;
  readonly projection: Projection;
}
export type StampedTravelCatalog = StampedQuery<TravelCatalog>;
export type StampedTravelPreview = StampedQuery<TravelPreview> & { readonly requested: TripPreparationPayload };
export type StampedTravelReports = StampedQuery<TravelReportsPage> & { readonly query: TravelReportsQuery };

function stampUsable<T extends { revision: number }>(stamp: StampedQuery<T> | null, generation: number | null, snapshot: AppSnapshot | null): stamp is StampedQuery<T> {
  return stamp !== null && generation !== null && stamp.generation === generation && snapshot !== null
    && stamp.projection.revision === snapshot.revision && travelSnapshotsMatch(stamp.snapshot, snapshot);
}
export function usableTravelCatalog(stamp: StampedTravelCatalog | null, generation: number | null, snapshot: AppSnapshot | null): TravelCatalog | null {
  return stampUsable(stamp, generation, snapshot) ? stamp.projection : null;
}

export function travelSupplyCount(catalog: TravelCatalog, itemId: string): number {
  return catalog.supplyStock.find(item => item.itemId === itemId)?.quantity ?? 0;
}
export interface SupplyDraft { readonly itemId: string; readonly value: string }
/** Closed chosen input only. A zero is an intentionally omitted supply,
 * not a zero-quantity entry. No costs, stats, seeds, routes or timing fields. */
export function createTripPreparationPayload(catalog: TravelCatalog | null, snapshot: AppSnapshot | null,
  petId: string, routeId: string, drafts: readonly SupplyDraft[]): TripPreparationPayload | undefined {
  if (!catalog || !snapshot || catalog.revision !== snapshot.revision || !snapshot.pets.some(pet => pet.petId === petId)) return undefined;
  const route = catalog.routes.find(candidate => candidate.routeId === routeId);
  if (!route || new Set(drafts.map(draft => draft.itemId)).size !== drafts.length
    || drafts.some(draft => !route.requiredSupplies.some(required => required.itemId === draft.itemId))) return undefined;
  const selectedSupplies: TripSupplies = [];
  for (const required of route.requiredSupplies) {
    const value = drafts.find(draft => draft.itemId === required.itemId)?.value ?? '0';
    if (!/^(0|[1-9]\d?)$/u.test(value)) return undefined;
    const quantity = Number(value);
    if (quantity > required.quantity || quantity > 20) return undefined;
    if (quantity > 0) selectedSupplies.push({ itemId: required.itemId, quantity });
  }
  const result = tripPreparationPayloadSchema.safeParse({ petId, routeId, routeCatalogVersion: catalog.routeCatalogVersion, selectedSupplies });
  return result.success ? result.data : undefined;
}
function sameSupplies(left: TripSupplies, right: TripSupplies): boolean {
  return left.length === right.length && left.every(item => right.some(other => item.itemId === other.itemId && item.quantity === other.quantity));
}
export function preparationKey(payload: TripPreparationPayload): string {
  return JSON.stringify([payload.petId, payload.routeId, payload.routeCatalogVersion, [...payload.selectedSupplies]
    .sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0)]);
}
export function previewMatchesPreparation(preview: TravelPreview, requested: TripPreparationPayload): boolean {
  return preview.petId === requested.petId && preview.requestedRouteId === requested.routeId
    && sameSupplies(preview.selectedSupplies, requested.selectedSupplies)
    && (preview.routeCatalogVersion === requested.routeCatalogVersion
      || (!preview.eligible && preview.route === null && preview.reasons.some(reason => reason.code === 'ROUTE_CATALOG_VERSION_MISMATCH')));
}

export function usableTravelPreview(stamp: StampedTravelPreview | null, generation: number | null,
  snapshot: AppSnapshot | null, catalog: TravelCatalog | null, requested: TripPreparationPayload | undefined): TravelPreview | null {
  if (!stamp || !stampUsable(stamp, generation, snapshot) || !catalog || catalog.revision !== snapshot?.revision || !requested
    || preparationKey(stamp.requested) !== preparationKey(requested) || !previewMatchesPreparation(stamp.projection, requested)
    || stamp.projection.routeCatalogVersion !== catalog.routeCatalogVersion || requested.routeCatalogVersion !== catalog.routeCatalogVersion) return null;
  const currentRoute = catalog.routes.find(route => route.routeId === requested.routeId);
  if (!currentRoute || stamp.projection.route === null || JSON.stringify(stamp.projection.route) !== JSON.stringify(currentRoute)) return null;
  return stamp.projection;
}

export interface DepartureConfirmation {
  readonly generation: number;
  readonly revision: number;
  readonly catalogVersion: number;
  readonly payload: TripPreparationPayload;
  readonly title: string;
  readonly petName: string;
  readonly routeContentVersion: number;
  readonly energyNow: number;
  readonly energyCost10: number;
  readonly durationMs: number;
  readonly supplies: TripSupplies;
  readonly fingerprint: string;
}

export function createDepartureConfirmation(stamp: StampedTravelPreview | null, generation: number | null,
  snapshot: AppSnapshot | null, catalog: TravelCatalog | null, requested: TripPreparationPayload | undefined,
  allow: boolean): DepartureConfirmation | undefined {
  const preview = usableTravelPreview(stamp, generation, snapshot, catalog, requested);
  const pet = snapshot?.pets.find(candidate => candidate.petId === requested?.petId);
  if (!allow || !catalog || !preview?.eligible || !preview.route || !requested || generation === null || !pet
    || preview.reasons.length !== 0 || pet.presence !== 'HOME' || pet.trip?.status === 'TRAVELING'
    || pet.activity === 'CHAT' || pet.activity === 'DRAG'
    || pet.healthStatus !== 'NORMAL' || pet.healthPoints <= 0 || pet.level < preview.route.minLevel
    || preview.energyCost10 !== preview.route.energyCost10 || preview.durationMs !== preview.route.durationMs
    || !sameSupplies(preview.route.requiredSupplies, requested.selectedSupplies)
    || pet.energy < preview.energyCost10 / 10 || !sameSupplies(preview.supplyConsumption, requested.selectedSupplies)
    || preview.supplyConsumption.some(amount => travelSupplyCount(catalog, amount.itemId) < amount.quantity)) return undefined;
  const immutablePayload: TripPreparationPayload = { ...requested, selectedSupplies: requested.selectedSupplies.map(supply => Object.freeze({ ...supply })) };
  Object.freeze(immutablePayload.selectedSupplies); Object.freeze(immutablePayload);
  const supplies = preview.supplyConsumption.map(supply => Object.freeze({ ...supply }));
  Object.freeze(supplies);
  const display = {
    generation, revision: preview.revision, catalogVersion: preview.routeCatalogVersion, payload: immutablePayload,
    title: preview.route.title, petName: pet.nickname, routeContentVersion: preview.route.contentVersion,
    energyNow: pet.energy, energyCost10: preview.energyCost10, durationMs: preview.durationMs, supplies,
  };
  const fingerprint = JSON.stringify([display, preview, pet, catalog.supplyStock]);
  return Object.freeze({ ...display, fingerprint });
}

export function confirmDeparture(confirmation: DepartureConfirmation, stamp: StampedTravelPreview | null, generation: number | null,
  snapshot: AppSnapshot | null, catalog: TravelCatalog | null, requested: TripPreparationPayload | undefined,
  allow: boolean): TripPreparationPayload | undefined {
  const current = createDepartureConfirmation(stamp, generation, snapshot, catalog, requested, allow);
  if (!current || current.fingerprint !== confirmation.fingerprint || current.revision !== confirmation.revision
    || current.generation !== confirmation.generation || current.catalogVersion !== confirmation.catalogVersion) return undefined;
  return current.payload;
}

export function travelReasonText(reason: TravelPreparationReason): string {
  switch (reason.code) {
    case 'ROUTE_CATALOG_VERSION_MISMATCH': return `路线目录已更新（当前 v${reason.expectedVersion}），请重新查询。`;
    case 'ROUTE_NOT_FOUND': return `路线不存在：${reason.routeId}`;
    case 'PET_NOT_HOME': return reason.presence === 'RETURNING' ? '角色正在返程，需等待归来。' : '角色暂未在家。';
    case 'ACTIVE_TRIP': return '角色已有尚未结算的旅行。';
    case 'PET_BUSY': return reason.activity === 'CHAT' ? '角色正在对话，请先结束对话。' : '角色正在被拖动，请先结束当前交互。';
    case 'PET_UNHEALTHY': return `角色健康状态不允许出发（健康 ${reason.healthPoints10 / 10} / 100）。`;
    case 'LEVEL_TOO_LOW': return `等级不足：当前 Lv.${reason.level}，需要 Lv.${reason.requiredLevel}。`;
    case 'ENERGY_TOO_LOW': return `精力不足：当前 ${reason.available10 / 10}，需要 ${reason.required10 / 10}。`;
    case 'INVALID_SUPPLY_SELECTION': return '补给选择无效，请重新填写。';
    case 'SUPPLY_NOT_ALLOWED': return `该路线不接受额外补给：${travelItemLabel(reason.itemId)}。`;
    case 'MISSING_REQUIRED_SUPPLY': return `缺少选择：${travelItemLabel(reason.itemId)} 需要 ${reason.requiredQuantity}，已选 ${reason.selectedQuantity}。`;
    case 'EXCESS_SUPPLY': return `补给超额：${travelItemLabel(reason.itemId)} 最多 ${reason.maxQuantity}，已选 ${reason.selectedQuantity}。`;
    case 'SUPPLY_OUT_OF_STOCK': return `共享库存不足：${travelItemLabel(reason.itemId)} 需要 ${reason.requiredQuantity}，实际持有 ${reason.availableQuantity}。`;
  }
}

export function reportsQueryKey(query: TravelReportsQuery): string { return JSON.stringify([query.petId ?? null, query.offset, query.limit]); }
export function reportsMatchQuery(page: TravelReportsPage, query: TravelReportsQuery): boolean {
  return page.petId === (query.petId ?? null) && page.offset === query.offset && page.limit === query.limit;
}
export function usableTravelReports(stamp: StampedTravelReports | null, generation: number | null, snapshot: AppSnapshot | null,
  query: TravelReportsQuery): TravelReportsPage | null {
  return stamp && stampUsable(stamp, generation, snapshot) && reportsQueryKey(stamp.query) === reportsQueryKey(query)
    && reportsMatchQuery(stamp.projection, query) ? stamp.projection : null;
}
export function reportPageOffset(page: TravelReportsPage, direction: -1 | 1): number | undefined {
  const offset = page.offset + direction * page.limit;
  return offset >= 0 && offset < page.total && travelReportsQuerySchema.safeParse({ offset, limit: page.limit, ...(page.petId ? { petId: page.petId } : {}) }).success
    ? offset : undefined;
}
/** A read receipt can only target the actual settled unread row of this
 * exact page. It does not mutate the report or award rewards in the view. */
export function reportReadPayload(page: TravelReportsPage | null, snapshot: AppSnapshot | null, candidate: TripReport,
  allow: boolean): { petId: string; tripId: string } | undefined {
  if (!allow || !page || !snapshot || page.revision !== snapshot.revision || !snapshot.pets.some(pet => pet.petId === candidate.petId)) return undefined;
  const row = page.rows.find(report => report.tripId === candidate.tripId && report.petId === candidate.petId);
  return row && row.readAt === null && JSON.stringify(row) === JSON.stringify(candidate) ? { petId: row.petId, tripId: row.tripId } : undefined;
}

export function reportFactText(fact: TripReportFact): { title: string; text: string } {
  switch (fact.type) {
    case 'GATHER_RESOLVED': return { title: '完成采集', text: `节点 ${fact.payload.nodeId} · ${travelItemLabel(fact.payload.itemId)} × ${fact.payload.quantity} · 经验 +${fact.payload.xp}` };
    case 'BATTLE_RESOLVED': return {
      title: fact.payload.outcome === 'WIN' ? '战斗胜利' : '战斗失败',
      text: `敌人 ${fact.payload.enemyId} · 记录胜率 ${fact.payload.winChanceBps / 100}% · 经验 +${fact.payload.xp} · 金币 +${fact.payload.coins}`
        + (fact.payload.drop ? ` · 掉落 ${travelItemLabel(fact.payload.drop.itemId)} × ${fact.payload.drop.quantity}` : ' · 无掉落'),
    };
    case 'EVENT_RESOLVED': return { title: '旅行事件', text: `事件 ${fact.payload.eventDefId} · ${fact.payload.cgId ? `记录 CG ${fact.payload.cgId}` : '未获得 CG'}` };
    case 'RETURNING': return { title: '进入返程', text: returnReasonLabel[fact.payload.reason] };
    case 'TRIP_RETURNED': return { title: '已归家结算', text: returnReasonLabel[fact.payload.reason] };
  }
}
export function rewardLabel(reward: TripReport['rewards'][number]): string {
  switch (reward.kind) {
    case 'XP': return '经验';
    case 'COIN': return '游戏金币';
    case 'ITEM': return travelItemLabel(reward.targetId);
    case 'CG': return `CG 记录 · ${reward.targetId}`;
  }
}
