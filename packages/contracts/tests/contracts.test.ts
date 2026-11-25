import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMA_VERSION,
  appSnapshotSchema,
  domainCommandSchema,
  domainEventSchema,
  ipcErrorSchema,
  ipcRequestSchema,
  ipcResultSchema,
  petSnapshotSchema,
  type AppSnapshot,
  type DomainCommand,
  type DomainEvent,
  type IpcError,
  type IpcRequest,
  type IpcResult,
  type PetSnapshot,
} from '../src/index.js';

const pet = {
  petId: 'pet-001',
  characterId: 'cat-template',
  nickname: '小猫',
  presence: 'HOME',
  activity: 'IDLE',
  mood: 'CALM',
  healthStatus: 'NORMAL',
  visibility: 'VISIBLE',
  moodScore: 65.2,
  healthPoints: 100,
  energy: 0,
  bond: 50,
  level: 1,
  xp: 0,
  revision: 1,
} satisfies PetSnapshot;

const trip = {
  tripId: 'trip-001',
  routeId: 'morning-dew-meadow',
  status: 'TRAVELING',
  expectedReturnAt: 1_800_000_000_000,
} satisfies NonNullable<PetSnapshot['trip']>;

const app = {
  revision: 1,
  primaryPetId: pet.petId,
  pets: [pet],
  walletCoins: 10,
  doNotDisturb: true,
  pausedRender: true,
} satisfies AppSnapshot;

const commandFields = { commandId: 'command-001', issuedAt: 1_799_999_900_000 };
const commands = [
  { ...commandFields, type: 'PET_SELECT', payload: { petId: pet.petId } },
  { ...commandFields, type: 'PET_INTERACT', payload: { petId: pet.petId, interaction: 'PET' } },
  { ...commandFields, type: 'PET_INTERACT', payload: { petId: pet.petId, interaction: 'REST' } },
  { ...commandFields, type: 'PET_SET_VISIBILITY', payload: { petId: pet.petId, visibility: 'HIDDEN' } },
  { ...commandFields, expectedRevision: 1, type: 'TRIP_START', payload: { petId: pet.petId, routeId: trip.routeId } },
  { ...commandFields, type: 'TRIP_RECALL', payload: { petId: pet.petId, tripId: trip.tripId } },
  { ...commandFields, type: 'TRIP_REPORT_READ', payload: { petId: pet.petId, tripId: trip.tripId } },
  { ...commandFields, type: 'APP_SET_MODE', payload: { flag: 'doNotDisturb', enabled: true } },
  { ...commandFields, type: 'APP_SET_MODE', payload: { flag: 'pausedRender', enabled: false } },
] satisfies DomainCommand[];

const selectCommand = {
  ...commandFields,
  type: 'PET_SELECT',
  payload: { petId: pet.petId },
} satisfies DomainCommand;

describe('snapshot projections', () => {
  it('accepts finite display scores, independent modes, and an optional travel projection', () => {
    expect(petSnapshotSchema.parse(pet)).toEqual(pet);
    expect(appSnapshotSchema.parse(app)).toEqual(app);
    expect(petSnapshotSchema.parse({ ...pet, presence: 'AWAY', activity: null, trip })).toEqual({
      ...pet, presence: 'AWAY', activity: null, trip,
    });
    expect(petSnapshotSchema.safeParse({ ...pet, presence: 'RETURNING', activity: null, trip }).success).toBe(true);
    expect(petSnapshotSchema.safeParse({ ...pet, trip: { ...trip, status: 'SETTLED' } }).success).toBe(true);
    const empty = { ...app, primaryPetId: null, pets: [] };
    expect(appSnapshotSchema.parse(empty)).toEqual(empty);
  });

  it.each([
    { petId: 1 },
    { petId: '' },
    { petId: '  ' },
    { petId: '小猫' },
    { petId: 'pet/001' },
    { petId: 'x'.repeat(129) },
    { characterId: null },
    { nickname: '' },
    { nickname: 'x'.repeat(81) },
    { presence: 'HIDDEN' },
    { activity: 'EATING' },
    { mood: 'ANGRY' },
    { healthStatus: 'HEALTHY' },
    { visibility: 'AWAY' },
    { moodScore: -0.1 },
    { healthPoints: 100.1 },
    { energy: '99' },
    { energy: Number.NaN },
    { bond: Number.POSITIVE_INFINITY },
    { xp: -1 },
    { xp: 1.5 },
    { xp: Number.MAX_SAFE_INTEGER + 1 },
    { level: 0 },
    { level: 1.5 },
    { revision: -1 },
    { revision: 0.1 },
    { debug: true },
    { trip: { ...trip, status: 'RETURNING' } },
    { trip: { ...trip, status: 'PREPARING' } },
    { trip: { ...trip, expectedReturnAt: new Date(0) } },
    { trip: { ...trip, expectedReturnAt: -1 } },
    { trip: { ...trip, expectedReturnAt: 1.1 } },
    { trip: { ...trip, tripId: 1 } },
    { trip: { ...trip, checkpoint: {} } },
    { trip }, // home pets cannot have an active trip
    { presence: 'AWAY', activity: null },
    { presence: 'RETURNING', activity: 'IDLE', trip },
    { presence: 'AWAY', activity: null, trip: { ...trip, status: 'SETTLED' } },
  ])('rejects invalid or additional pet fields: %j', (fields) => {
    expect(petSnapshotSchema.safeParse({ ...pet, ...fields }).success).toBe(false);
  });

  it.each([
    { revision: 1.5 },
    { primaryPetId: 1 },
    { primaryPetId: 'missing-pet' },
    { pets: [pet, pet] },
    { pets: [{ ...pet, debug: true }] },
    { pets: Array.from({ length: 101 }, (_, n) => ({ ...pet, petId: `pet-${n}` })) },
    { walletCoins: -1 },
    { walletCoins: 1.5 },
    { doNotDisturb: 'true' },
    { pausedRender: 0 },
    { preferences: {} },
  ])('rejects invalid or additional app fields: %j', (fields) => {
    expect(appSnapshotSchema.safeParse({ ...app, ...fields }).success).toBe(false);
  });
});

describe('domain commands', () => {
  it.each(commands)('parses $type with its specific payload', (command) => {
    expect(domainCommandSchema.parse(command)).toEqual(command);
  });

  it.each([
    { type: 'PET_DELETE' },
    { commandId: null },
    { issuedAt: -1 },
    { issuedAt: 1.1 },
    { issuedAt: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAt: '2026-11-25T00:00:00Z' },
    { issuedAt: new Date(0) },
    { expectedRevision: -1 },
    { expectedRevision: null },
    { expectedRevision: 0.01 },
    { petId: pet.petId }, // target belongs to the strict payload, not the command root
    { payload: { petId: 2 } },
    { payload: {} },
    { payload: { petId: pet.petId, routeId: trip.routeId } },
    { type: 'PET_INTERACT', payload: { petId: pet.petId } },
    { type: 'PET_INTERACT', payload: { petId: pet.petId, interaction: 'FEED' } },
    { type: 'PET_SET_VISIBILITY', payload: { petId: pet.petId, visibility: false } },
    { type: 'PET_SET_VISIBILITY', payload: { petId: pet.petId, visibility: 'AWAY' } },
    { type: 'TRIP_START', payload: { petId: pet.petId } },
    { type: 'TRIP_START', payload: { petId: pet.petId, routeId: trip.routeId, rewards: 999 } },
    { type: 'TRIP_RECALL', payload: { petId: pet.petId, routeId: trip.routeId } },
    { type: 'TRIP_REPORT_READ', payload: { tripId: trip.tripId } },
    { type: 'APP_SET_MODE', payload: { flag: 'pausedRender', enabled: 1 } },
    { type: 'APP_SET_MODE', payload: { flag: 'visibility', enabled: true } },
    { type: 'APP_SET_MODE', payload: { flag: 'pausedRender', enabled: true, petId: pet.petId } },
  ])('rejects commands outside the discriminated union: %j', (fields) => {
    expect(domainCommandSchema.safeParse({ ...selectCommand, ...fields }).success).toBe(false);
  });
});

describe('domain event envelope', () => {
  const event = {
    eventId: 'event-001',
    type: 'PetStateChanged',
    aggregateId: pet.petId,
    revision: 2,
    occurredAt: 1_800_000_000_000,
    causationId: commandFields.commandId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    payload: { petId: pet.petId, energy: 1.2, healthy: true, tripId: null },
  } satisfies DomainEvent;

  it('accepts a bounded, serializable fact map', () => {
    expect(domainEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    { schemaVersion: 2 },
    { occurredAt: -1 },
    { occurredAt: 1.5 },
    { eventId: 4 },
    { causationId: '' },
    { revision: -1 },
    { debug: 'internal detail' },
    { payload: { fact: { energy: 1 } } },
    { payload: { fact: [] } },
    { payload: { fact: new Date(0) } },
    { payload: { fact: undefined } },
    { payload: { fact: Number.NaN } },
    { payload: { fact: 'x'.repeat(2049) } },
    { payload: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`fact-${n}`, n])) },
  ])('rejects invalid event envelopes or unbounded payloads: %j', (fields) => {
    expect(domainEventSchema.safeParse({ ...event, ...fields }).success).toBe(false);
  });
});

describe('IPC messages', () => {
  const fields = { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: 'request-001' };
  const snapshotRequest = {
    ...fields, method: 'snapshot/get', payload: {},
  } satisfies IpcRequest;
  const dispatchRequest = {
    ...fields, method: 'command/dispatch', payload: { command: selectCommand },
  } satisfies IpcRequest;
  const success = {
    ...fields, ok: true, snapshot: app,
  } satisfies IpcResult;
  const error = {
    requestId: fields.requestId,
    code: 'INVALID_REQUEST',
    message: 'Malformed request',
    retryable: false,
  } satisfies IpcError;
  const failure = {
    schemaVersion: CONTRACT_SCHEMA_VERSION, ok: false, error,
  } satisfies IpcResult;

  it('accepts requests and either result branch without implicit conversion', () => {
    expect(ipcRequestSchema.parse(snapshotRequest)).toEqual(snapshotRequest);
    expect(ipcRequestSchema.parse(dispatchRequest)).toEqual(dispatchRequest);
    expect(ipcResultSchema.parse(success)).toEqual(success);
    expect(ipcResultSchema.parse(failure)).toEqual(failure);
  });

  it.each([
    { schemaVersion: 0 },
    { schemaVersion: '1' },
    { schemaVersion: undefined },
    { requestId: 1 },
    { requestId: '' },
    { method: 'shell/execute' },
    { method: 'command/dispatch', payload: {} },
    { method: 'command/dispatch', payload: { command: { ...selectCommand, payload: { petId: 1 } } } },
    { method: 'command/dispatch', payload: { command: selectCommand, raw: 'unused' } },
    { payload: { command: selectCommand } },
    { requestId: 'x'.repeat(129) },
    { channel: 'extra' },
  ])('rejects undeclared request methods, versions, and payloads: %j', (invalid) => {
    expect(ipcRequestSchema.safeParse({ ...snapshotRequest, ...invalid }).success).toBe(false);
  });

  it.each([
    { schemaVersion: 2 },
    { requestId: null },
    { ok: 'true' },
    { ok: false },
    { error },
    { snapshot: { ...app, rawDb: {} } },
  ])('rejects invalid success result branches: %j', (invalid) => {
    expect(ipcResultSchema.safeParse({ ...success, ...invalid }).success).toBe(false);
  });

  it.each([
    { requestId: 1 },
    { code: 'HACK' },
    { message: '' },
    { message: 'x'.repeat(513) },
    { retryable: 'yes' },
    { stack: 'raw exception detail' },
  ])('rejects invalid errors and private diagnostic fields: %j', (invalid) => {
    const invalidError = { ...error, ...invalid };
    expect(ipcErrorSchema.safeParse(invalidError).success).toBe(false);
    expect(ipcResultSchema.safeParse({ ...failure, error: invalidError }).success).toBe(false);
  });
});
