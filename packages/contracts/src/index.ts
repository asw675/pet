import { z } from 'zod';
import { cgMarkViewedPayloadSchema, cgSetFavoritePayloadSchema, galleryPageSchema, galleryQuerySchema } from '#gallery';
import { characterCatalogPageSchema, petAcquirePayloadSchema, petRenamePayloadSchema } from '#characters';
import { equipmentEquipPayloadSchema, equipmentUnequipPayloadSchema, equipmentUpgradePayloadSchema,
  equipmentSalvagePayloadSchema, inventoryPageSchema, inventoryQuerySchema, itemUsePayloadSchema, shopPurchasePayloadSchema } from '#inventory';
import { tripPreparationPayloadSchema, travelCatalogSchema, travelPreviewSchema, travelReportsPageSchema, travelReportsQuerySchema } from '#travel';
import { eventChoosePayloadSchema, eventPageSchema, eventListQuerySchema } from '#events';

/** Independent from the application, database and game-rule versions. */
export const CONTRACT_SCHEMA_VERSION = 1 as const;

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** UTC epoch milliseconds, rather than Date or an arbitrary string. */
export const timestampSchema = nonnegativeIntegerSchema;
export const revisionSchema = nonnegativeIntegerSchema;
export const displayScoreSchema = z.number().min(0).max(100);

export const presenceSchema = z.enum(['HOME', 'AWAY', 'RETURNING']);
export const activitySchema = z.enum([
  'IDLE', 'WALK', 'DRAG', 'INTERACT', 'CHAT', 'EAT', 'REST', 'SLEEP', 'CELEBRATE',
]);
export const moodSchema = z.enum(['CALM', 'HAPPY', 'EXCITED', 'BORED', 'UPSET', 'TIRED']);
export const healthStatusSchema = z.enum(['NORMAL', 'INJURED', 'RECOVERING']);
export const visibilitySchema = z.enum(['VISIBLE', 'HIDDEN']);
export const tripStatusSchema = z.enum(['TRAVELING', 'SETTLED']);

export type Presence = z.infer<typeof presenceSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type Mood = z.infer<typeof moodSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;
export type TripStatus = z.infer<typeof tripStatusSchema>;

export const tripSnapshotSchema = z.strictObject({
  tripId: idSchema,
  routeId: idSchema,
  status: tripStatusSchema,
  expectedReturnAt: timestampSchema,
});
export type TripSnapshot = z.infer<typeof tripSnapshotSchema>;

/** Read-only projection. Domain rules and fixed-point persistence are not DTOs. */
export const petSnapshotSchema = z.strictObject({
  petId: idSchema,
  characterId: idSchema,
  nickname: z.string().min(1).max(80),
  presence: presenceSchema,
  activity: activitySchema.nullable(),
  mood: moodSchema,
  healthStatus: healthStatusSchema,
  visibility: visibilitySchema,
  moodScore: displayScoreSchema,
  healthPoints: displayScoreSchema,
  energy: displayScoreSchema,
  bond: displayScoreSchema,
  level: nonnegativeIntegerSchema.min(1),
  xp: nonnegativeIntegerSchema,
  revision: revisionSchema,
  trip: tripSnapshotSchema.optional(),
}).superRefine((pet, context) => {
  if (pet.presence === 'HOME') {
    if (pet.activity === null) {
      context.addIssue({ code: 'custom', path: ['activity'], message: 'A home pet requires a home activity' });
    }
    if (pet.trip?.status === 'TRAVELING') {
      context.addIssue({ code: 'custom', path: ['trip', 'status'], message: 'A home pet cannot have an active trip' });
    }
  } else {
    if (pet.activity !== null) {
      context.addIssue({ code: 'custom', path: ['activity'], message: 'A pet offsite has no home activity' });
    }
    if (pet.trip?.status !== 'TRAVELING') {
      context.addIssue({ code: 'custom', path: ['trip'], message: 'An offsite pet requires an active trip' });
    }
  }
});
export type PetSnapshot = z.infer<typeof petSnapshotSchema>;

export const appSnapshotSchema = z.strictObject({
  revision: revisionSchema,
  primaryPetId: idSchema.nullable(),
  pets: z.array(petSnapshotSchema).max(100),
  walletCoins: nonnegativeIntegerSchema,
  doNotDisturb: z.boolean(),
  pausedRender: z.boolean(),
}).superRefine((app, context) => {
  const petIds = new Set<string>();
  for (const [index, pet] of app.pets.entries()) {
    if (petIds.has(pet.petId)) {
      context.addIssue({ code: 'custom', path: ['pets', index, 'petId'], message: 'Duplicate pet ID' });
    }
    petIds.add(pet.petId);
  }
  if (app.primaryPetId !== null && !petIds.has(app.primaryPetId)) {
    context.addIssue({ code: 'custom', path: ['primaryPetId'], message: 'Primary pet is not in the snapshot' });
  }
});
export type AppSnapshot = z.infer<typeof appSnapshotSchema>;

const commandFields = {
  commandId: idSchema,
  issuedAt: timestampSchema,
  expectedRevision: revisionSchema.optional(),
};
const commerceCommandFields = { ...commandFields, expectedRevision: revisionSchema };

export const interactionSchema = z.enum(['PET', 'REST', 'WAKE']);
export const modeFlagSchema = z.enum(['doNotDisturb', 'pausedRender']);
export type Interaction = z.infer<typeof interactionSchema>;
export type ModeFlag = z.infer<typeof modeFlagSchema>;

// Each command carries its own closed payload. No open-ended action or host API.
export const domainCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commandFields, type: z.literal('PET_ACQUIRE'), payload: petAcquirePayloadSchema }),
  z.strictObject({ ...commandFields, type: z.literal('PET_RENAME'), payload: petRenamePayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('SHOP_PURCHASE'), payload: shopPurchasePayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('EQUIPMENT_EQUIP'), payload: equipmentEquipPayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('EQUIPMENT_UNEQUIP'), payload: equipmentUnequipPayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('EQUIPMENT_UPGRADE'), payload: equipmentUpgradePayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('EQUIPMENT_SALVAGE'), payload: equipmentSalvagePayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('ITEM_USE'), payload: itemUsePayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('TRIP_START_PREPARED'), payload: tripPreparationPayloadSchema }),
  z.strictObject({ ...commerceCommandFields, type: z.literal('EVENT_CHOOSE'), payload: eventChoosePayloadSchema }),
  z.strictObject({
    ...commandFields,
    type: z.literal('PET_SELECT'),
    payload: z.strictObject({ petId: idSchema }),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal('PET_INTERACT'),
    payload: z.strictObject({ petId: idSchema, interaction: interactionSchema }),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal('PET_SET_VISIBILITY'),
    payload: z.strictObject({ petId: idSchema, visibility: visibilitySchema }),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal('TRIP_START'),
    payload: z.strictObject({ petId: idSchema, routeId: idSchema }),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal('TRIP_RECALL'),
    payload: z.strictObject({ petId: idSchema, tripId: idSchema }),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal('TRIP_REPORT_READ'),
    payload: z.strictObject({ petId: idSchema, tripId: idSchema }),
  }),
  z.strictObject({ ...commandFields, type: z.literal('CG_SET_FAVORITE'), payload: cgSetFavoritePayloadSchema }),
  z.strictObject({ ...commandFields, type: z.literal('CG_MARK_VIEWED'), payload: cgMarkViewedPayloadSchema }),
  z.strictObject({
    ...commandFields,
    type: z.literal('APP_SET_MODE'),
    payload: z.strictObject({ flag: modeFlagSchema, enabled: z.boolean() }),
  }),
]);
export type DomainCommand = z.infer<typeof domainCommandSchema>;

// The initial event envelope permits only a bounded, shallow JSON fact map.
// Each new complex event needs a dedicated versioned payload schema first.
const eventScalarSchema = z.union([
  z.string().max(2048),
  z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.null(),
]);
export const domainEventSchema = z.strictObject({
  eventId: idSchema,
  type: idSchema,
  aggregateId: idSchema,
  revision: revisionSchema,
  occurredAt: timestampSchema,
  causationId: idSchema,
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  payload: z.record(idSchema, eventScalarSchema).refine(
    (payload) => Object.keys(payload).length <= 32,
    'Event payload must have at most 32 entries',
  ),
});
export type DomainEvent = z.infer<typeof domainEventSchema>;

export const ipcErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'FORBIDDEN',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'COMMAND_CONFLICT',
  'BUSINESS_RULE',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'INTERNAL_ERROR',
]);
export type IpcErrorCode = z.infer<typeof ipcErrorCodeSchema>;

/** Stable public errors. Transport adapters must not expose raw exception details. */
export const ipcErrorSchema = z.strictObject({
  code: ipcErrorCodeSchema,
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
  requestId: idSchema,
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

const requestFields = {
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  requestId: idSchema,
};
export const ipcRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    ...requestFields,
    method: z.literal('snapshot/get'),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...requestFields,
    method: z.literal('command/dispatch'),
    payload: z.strictObject({ command: domainCommandSchema }),
  }),
  z.strictObject({ ...requestFields, method: z.literal('gallery/list'), payload: galleryQuerySchema }),
  z.strictObject({ ...requestFields, method: z.literal('characters/list'), payload: z.strictObject({}) }),
  z.strictObject({ ...requestFields, method: z.literal('inventory/list'), payload: inventoryQuerySchema }),
  z.strictObject({ ...requestFields, method: z.literal('travel/catalog'), payload: z.strictObject({}) }),
  z.strictObject({ ...requestFields, method: z.literal('travel/preview'), payload: tripPreparationPayloadSchema }),
  z.strictObject({ ...requestFields, method: z.literal('travel/reports'), payload: travelReportsQuerySchema }),
  z.strictObject({ ...requestFields, method: z.literal('events/list'), payload: eventListQuerySchema }),
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

const snapshotSuccessSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  ok: z.literal(true),
  requestId: idSchema,
  snapshot: appSnapshotSchema,
});
const errorResultSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  ok: z.literal(false),
  error: ipcErrorSchema,
});
const gallerySuccessSchema = snapshotSuccessSchema.extend({ gallery: galleryPageSchema })
  .refine((result) => result.gallery.revision === result.snapshot.revision, 'Gallery and snapshot revisions must match');
const charactersSuccessSchema = snapshotSuccessSchema.extend({ characters: characterCatalogPageSchema })
  .superRefine((result, ctx) => {
    const { characters, snapshot } = result;
    if (characters.revision !== snapshot.revision || characters.walletCoins !== snapshot.walletCoins) {
      ctx.addIssue({ code: 'custom', path: ['characters'], message: 'Character catalog and snapshot must share an authority revision and wallet' });
    }
    for (const [index, row] of characters.rows.entries()) {
      const expected = snapshot.pets.filter((pet) => pet.characterId === row.characterId);
      if (expected.length !== row.instances.length || !row.instances.every((instance) => expected.some((pet) => pet.petId === instance.petId && pet.nickname === instance.nickname))) {
        ctx.addIssue({ code: 'custom', path: ['characters', 'rows', index, 'instances'], message: 'Character instances must match the snapshot' });
      }
      if (row.availability === 'CAPACITY_REACHED' && snapshot.pets.length < 100) {
        ctx.addIssue({ code: 'custom', path: ['characters', 'rows', index, 'availability'], message: 'Capacity result contradicts the snapshot' });
      }
    }
  });

const inventorySuccessSchema = snapshotSuccessSchema.extend({ inventory: inventoryPageSchema })
  .superRefine(({ inventory, snapshot }, ctx) => {
    if (inventory.revision !== snapshot.revision || inventory.walletCoins !== snapshot.walletCoins) {
      ctx.addIssue({ code: 'custom', path: ['inventory'], message: 'Inventory and snapshot must share an authority revision and wallet' });
    }
    const pets = new Map(snapshot.pets.map((pet) => [pet.petId, pet]));
    if (inventory.pets.length !== pets.size || inventory.pets.some((entry) => {
      const pet = pets.get(entry.petId);
      return !pet || pet.characterId !== entry.characterId || pet.nickname !== entry.nickname
        || entry.progression.cumulativeXp !== pet.xp || entry.progression.level !== pet.level;
    })) ctx.addIssue({ code: 'custom', path: ['inventory', 'pets'], message: 'Inventory pets must match the authority snapshot' });
  });
const travelCatalogSuccessSchema = snapshotSuccessSchema.extend({ travelCatalog: travelCatalogSchema })
  .refine((result) => result.travelCatalog.revision === result.snapshot.revision, 'Route catalog and snapshot revisions must match');
const travelPreviewSuccessSchema = snapshotSuccessSchema.extend({ travelPreview: travelPreviewSchema })
  .superRefine(({ travelPreview, snapshot }, ctx) => {
    const pet = snapshot.pets.find((entry) => entry.petId === travelPreview.petId);
    if (travelPreview.revision !== snapshot.revision || !pet) ctx.addIssue({ code: 'custom', path: ['travelPreview'], message: 'Departure quote must belong to current snapshot' });
    if (travelPreview.eligible && pet && (pet.presence !== 'HOME' || pet.healthStatus !== 'NORMAL' || pet.healthPoints <= 0
      || pet.activity === 'CHAT' || pet.activity === 'DRAG' || pet.energy * 10 + 1e-6 < travelPreview.energyCost10
      || pet.level < (travelPreview.route?.minLevel ?? 1))) ctx.addIssue({ code: 'custom', path: ['travelPreview', 'eligible'], message: 'Eligible quote contradicts the pet state' });
  });
const travelReportsSuccessSchema = snapshotSuccessSchema.extend({ travelReports: travelReportsPageSchema })
  .refine((result) => result.travelReports.revision === result.snapshot.revision
    && result.travelReports.rows.every((report) => result.snapshot.pets.some((pet) => pet.petId === report.petId)), 'Travel reports must belong to current snapshot');
const eventsSuccessSchema = snapshotSuccessSchema.extend({ events: eventPageSchema })
  .refine((result) => result.events.revision === result.snapshot.revision && result.events.rows.every((event) =>
    result.snapshot.pets.some((pet) => pet.petId === event.petId && pet.characterId === event.characterId)), 'Events must belong to current snapshot');

// Old snapshot and persistent command result shape stays exactly as before.
// The gallery query has a distinct closed success shape plus the same snapshot.
export const snapshotIpcResultSchema = z.union([snapshotSuccessSchema, errorResultSchema]);
export type SnapshotIpcResult = z.infer<typeof snapshotIpcResultSchema>;
export const galleryIpcResultSchema = z.union([gallerySuccessSchema, errorResultSchema]);
export type GalleryIpcResult = z.infer<typeof galleryIpcResultSchema>;
export const charactersIpcResultSchema = z.union([charactersSuccessSchema, errorResultSchema]);
export type CharactersIpcResult = z.infer<typeof charactersIpcResultSchema>;
export const inventoryIpcResultSchema = z.union([inventorySuccessSchema, errorResultSchema]);
export type InventoryIpcResult = z.infer<typeof inventoryIpcResultSchema>;
export const travelCatalogIpcResultSchema = z.union([travelCatalogSuccessSchema, errorResultSchema]);
export type TravelCatalogIpcResult = z.infer<typeof travelCatalogIpcResultSchema>;
export const travelPreviewIpcResultSchema = z.union([travelPreviewSuccessSchema, errorResultSchema]);
export type TravelPreviewIpcResult = z.infer<typeof travelPreviewIpcResultSchema>;
export const travelReportsIpcResultSchema = z.union([travelReportsSuccessSchema, errorResultSchema]);
export type TravelReportsIpcResult = z.infer<typeof travelReportsIpcResultSchema>;
export const eventsIpcResultSchema = z.union([eventsSuccessSchema, errorResultSchema]);
export type EventsIpcResult = z.infer<typeof eventsIpcResultSchema>;
export const ipcResultSchema = z.union([snapshotSuccessSchema, gallerySuccessSchema, charactersSuccessSchema, inventorySuccessSchema,
  travelCatalogSuccessSchema, travelPreviewSuccessSchema, travelReportsSuccessSchema, eventsSuccessSchema, errorResultSchema]);
export type IpcResult = z.infer<typeof ipcResultSchema>;

/** Request correlation includes its method, not merely an equal request ID. */
export function resultMatchesMethod(method: IpcRequest['method'], result: IpcResult): boolean {
  if (!result.ok) return true;
  if (method === 'gallery/list') return 'gallery' in result;
  if (method === 'characters/list') return 'characters' in result;
  if (method === 'inventory/list') return 'inventory' in result;
  if (method === 'travel/catalog') return 'travelCatalog' in result;
  if (method === 'travel/preview') return 'travelPreview' in result;
  if (method === 'travel/reports') return 'travelReports' in result;
  if (method === 'events/list') return 'events' in result;
  return !('gallery' in result) && !('characters' in result) && !('inventory' in result)
    && !('travelCatalog' in result) && !('travelPreview' in result) && !('travelReports' in result) && !('events' in result);
}

/** Explicit renderer-facing API, independent of Electron and transport internals. */
export interface AppBridge {
  getSnapshot(): Promise<IpcResult>;
  dispatch(command: DomainCommand): Promise<IpcResult>;
  subscribeSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
}

export * from '#character-pack';
export * from '#gallery';
export * from '#characters';
export type { InventoryPage } from '#inventory';
