import { activeTravelPageSchema, travelCatalogSchema, travelPreviewSchema, travelReportsPageSchema, tripDepartureLoadoutSchema, tripReportSchema } from '@pet-desktop/contracts/travel';
import type {
  RouteMetadata, TravelCatalog, TravelPreview, TravelReportsPage, TravelReportsQuery, TripDepartureLoadout, TripPreparationPayload,
  TravelPreparationReason, ActiveTravelPage,
} from '@pet-desktop/contracts/travel';
import { EQUIPMENT_SLOTS, equipmentBonus } from '@pet-desktop/domain/equipment-rules';
import { findItemDefinition, ITEM_CATALOG_VERSION } from '@pet-desktop/domain/item-catalog';
import { progressionForXp } from '@pet-desktop/domain/progression';
import { ROUTE_CATALOG, ROUTE_CATALOG_VERSION } from '@pet-desktop/domain/route-catalog';
import type { RouteCatalogEntry } from '@pet-desktop/domain/route-catalog';
import { previewTripPreparation } from '@pet-desktop/domain/trip-preparation';
import type { AppTransaction, PetRecord, TripRecord } from './ports.js';
import { battleProjection } from '#economy-service';

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Read only after AppService.advanceAll has audited/replayed persisted active
 * checkpoints and applied all due facts in this transaction. The renderer
 * receives the frozen authored plan and committed traversal facts, never its
 * seed/RNG cursor or the latest route in place of the historic plan. */
export function projectActiveTravel(tx: AppTransaction, revision: number): ActiveTravelPage {
  const rows = tx.listTrips().filter(trip => trip.status === 'TRAVELING')
    .sort((a,b) => compareIds(a.snapshot.petId,b.snapshot.petId) || compareIds(a.snapshot.tripId,b.snapshot.tripId))
    .map(trip => {
      const { snapshot, checkpoint } = trip;
      if (checkpoint.phase === 'COMPLETE' || checkpoint.nextDueAt === null) throw new Error('Active trip has terminal checkpoint');
      return { tripId: snapshot.tripId, petId: snapshot.petId, routeId: snapshot.routeId, contentVersion: snapshot.contentVersion,
        rulesVersion: snapshot.rulesVersion, departurePower: snapshot.power, startAt: snapshot.startAt, expectedReturnAt: snapshot.expectedReturnAt,
        phase: checkpoint.phase, nextDueAt: checkpoint.nextDueAt, returnReason: checkpoint.returnReason, nodeIndex: checkpoint.nodeIndex,
        returnDurationMs: snapshot.returnDurationMs, nodes: snapshot.nodes, facts: tx.listTripFacts(snapshot.tripId) };
    });
  return activeTravelPageSchema.parse({ revision, rows });
}

function metadata(entry: RouteCatalogEntry): RouteMetadata {
  // The simulator's route definition, power, seed and checkpoint never leave
  // this catalog projection. Only authored presentation and entry requirements.
  const { routeId, contentVersion, title, description, risk, minLevel, recommendedMaxLevel, energyCost10, durationMs } = entry;
  return { routeId, contentVersion, title, description, risk, minLevel, recommendedMaxLevel, energyCost10, durationMs,
    requiredSupplies: entry.requiredSupplies.map(item => ({ ...item })), rewardItemIds: [...entry.rewardItemIds], cgIds: [...entry.cgIds] };
}

function supplyStock(tx: AppTransaction): TravelCatalog['supplyStock'] {
  const supplyIds = [...new Set(ROUTE_CATALOG.flatMap(route => route.requiredSupplies.map(({ itemId }) => itemId)))].sort(compareIds);
  const stacks = new Map(tx.listInventory().map(({ itemId, quantity }) => [itemId, quantity]));
  return supplyIds.map(itemId => {
    const definition = findItemDefinition(itemId);
    if (definition?.kind !== 'CONSUMABLE') throw new Error('Travel supply is not a current stack consumable');
    return { itemId, quantity: stacks.get(itemId) ?? 0 };
  });
}

export function projectTravelCatalog(tx: AppTransaction, revision: number): TravelCatalog {
  return travelCatalogSchema.parse({ revision, routeCatalogVersion: ROUTE_CATALOG_VERSION,
    routes: ROUTE_CATALOG.map(metadata), supplyStock: supplyStock(tx) });
}

/** A query and committed departure share this exact authority quote. Only
 * relevant current supply IDs enter the bounded pure preflight: arbitrary
 * legacy inventory pages have no bearing on route eligibility. */
export function prepareTravel(tx: AppTransaction, pet: PetRecord, input: TripPreparationPayload, revision: number): {
  preview: TravelPreview; route: RouteCatalogEntry | null;
} {
  if (pet.petId !== input.petId) throw new Error('Travel preparation belongs to another pet');
  const quote = previewTripPreparation({ routeId: input.routeId, routeCatalogVersion: input.routeCatalogVersion,
    pet: { presence: pet.presence,
      hasActiveTrip: tx.listTrips().some(trip => trip.snapshot.petId === pet.petId && trip.status === 'TRAVELING'),
      level: progressionForXp(pet.xp).level, energy10: pet.energy10, healthStatus: pet.healthStatus, healthPoints10: pet.healthPoints10 },
    selectedSupplies: input.selectedSupplies, inventory: supplyStock(tx) });
  const reasons: TravelPreparationReason[] = [...quote.reasons];
  // Explicit chat/drag sessions are externally owned. A preview must not
  // authorize a departure that actual command execution would reject.
  if (quote.route !== null && pet.presence === 'HOME' && (pet.activity === 'CHAT' || pet.activity === 'DRAG')) {
    reasons.push({ code: 'PET_BUSY', activity: pet.activity });
  }
  const preview = travelPreviewSchema.parse({ revision, petId: pet.petId, routeCatalogVersion: quote.routeCatalogVersion,
    requestedRouteId: input.routeId, route: quote.route === null ? null : metadata(quote.route),
    eligible: quote.route !== null && reasons.length === 0, reasons, energyCost10: quote.energyCost10, durationMs: quote.durationMs,
    selectedSupplies: input.selectedSupplies.map(item => ({ ...item })), supplyConsumption: quote.supplyConsumption.map(item => ({ ...item })) });
  return { preview, route: quote.route };
}

/** Persist full exact equipment identity and compatible bonuses with this
 * newly departing instance. Retired/old unavailable gear contributes no
 * substitute bonus and remains faithfully described by historical identity. */
export function freezeDepartureLoadout(tx: AppTransaction, pet: PetRecord, preview: TravelPreview): TripDepartureLoadout {
  if (preview.petId !== pet.petId || !preview.eligible || preview.route === null) throw new Error('Cannot freeze an ineligible departure');
  const battle = battleProjection(tx, pet);
  const equipment = [...tx.listPetEquipment(pet.petId)]
    .sort((a, b) => EQUIPMENT_SLOTS.indexOf(a.slot) - EQUIPMENT_SLOTS.indexOf(b.slot) || compareIds(a.instanceId, b.instanceId))
    .map(binding => {
      const instance = tx.getItemInstance(binding.instanceId);
      if (binding.petId !== pet.petId || !instance) throw new Error('Missing or mismatched equipped instance at departure');
      const item = instance.definitionVersion === ITEM_CATALOG_VERSION ? findItemDefinition(instance.definitionId) : undefined;
      const definition = item?.kind === 'EQUIPMENT' ? item.equipment : undefined;
      if (definition && definition.slot !== binding.slot) throw new Error('Equipment slot disagrees with departure definition');
      return { slot: binding.slot, instanceId: instance.instanceId, definitionId: instance.definitionId,
        definitionVersion: instance.definitionVersion, enhancement: instance.enhancement,
        bonus: definition ? equipmentBonus(definition, instance.enhancement) : null };
    });
  return tripDepartureLoadoutSchema.parse({ routeCatalogVersion: preview.routeCatalogVersion, itemCatalogVersion: ITEM_CATALOG_VERSION,
    level: battle.progression.level, energyCost10: preview.energyCost10,
    supplies: preview.supplyConsumption.map(item => ({ ...item })).sort((a, b) => compareIds(a.itemId, b.itemId)),
    stats: battle.stats, battlePower: battle.battlePower, equipment });
}

/** Report only actual settled facts and committed reward lines. The callback
 * audits the same immutable trip/replay/settlement invariants as startup;
 * history never resolves today's gear definitions or today's route catalog. */
export function projectTravelReports(tx: AppTransaction, query: TravelReportsQuery, revision: number,
  verify: (trip: TripRecord) => void): TravelReportsPage {
  const { total, trips } = tx.listSettledTrips(query);
  const rows = trips.map(trip => {
    if (trip.status !== 'SETTLED' || trip.checkpoint.actualReturnedAt === null || trip.checkpoint.returnReason === null) {
      throw new Error('Report query requires settled travel');
    }
    verify(trip);
    const snapshot = trip.snapshot;
    return tripReportSchema.parse({ tripId: snapshot.tripId, petId: snapshot.petId, routeId: snapshot.routeId,
      contentVersion: snapshot.contentVersion, rulesVersion: snapshot.rulesVersion, startAt: snapshot.startAt,
      expectedReturnAt: snapshot.expectedReturnAt, actualReturnedAt: trip.checkpoint.actualReturnedAt, readAt: trip.reportReadAt,
      returnReason: trip.checkpoint.returnReason, departurePower: snapshot.power, loadout: tx.getTripDepartureLoadout(snapshot.tripId),
      facts: tx.listTripFacts(snapshot.tripId), rewards: tx.listRewards(snapshot.tripId).map(({ kind, targetId, amount }) => ({ kind, targetId, amount })),
    });
  });
  return travelReportsPageSchema.parse({ revision, petId: query.petId ?? null, offset: query.offset, limit: query.limit, total, rows });
}
