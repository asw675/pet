import { z } from 'zod';

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

export const interactionSchema = z.enum(['PET', 'REST']);
export const modeFlagSchema = z.enum(['doNotDisturb', 'pausedRender']);
export type Interaction = z.infer<typeof interactionSchema>;
export type ModeFlag = z.infer<typeof modeFlagSchema>;

// Each command carries its own closed payload. No open-ended action or host API.
export const domainCommandSchema = z.discriminatedUnion('type', [
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
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

export const ipcResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    ok: z.literal(true),
    requestId: idSchema,
    snapshot: appSnapshotSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    ok: z.literal(false),
    error: ipcErrorSchema,
  }),
]);
export type IpcResult = z.infer<typeof ipcResultSchema>;

/** Explicit renderer-facing API, independent of Electron and transport internals. */
export interface AppBridge {
  getSnapshot(): Promise<IpcResult>;
  dispatch(command: DomainCommand): Promise<IpcResult>;
  subscribeSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
}
