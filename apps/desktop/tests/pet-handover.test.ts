import { describe, expect, it } from 'vitest';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import { petVisualReadySchema } from '../src/shared/protocol';
import type { ServiceStatus } from '../src/shared/protocol';
import { desiredPetSurface, isCurrentVisualReport, planPetHandover } from '../src/main/pet-handover';
import type { PetSurfaceIdentity, PetSurfaceInfo } from '../src/main/pet-handover';

const status: ServiceStatus = { stage: 'READY', generation: 8 };
const identity = (petId: string, generation = status.generation): PetSurfaceIdentity => ({ petId, characterId: `character-${petId}`, generation });
const home = (petId: string, visible = false): PetSnapshot => ({
  petId, characterId: identity(petId).characterId, nickname: petId, presence: 'HOME',
  visibility: visible ? 'VISIBLE' : 'HIDDEN', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL',
  moodScore: 50, healthPoints: 100, energy: 100, bond: 0, level: 1, xp: 0, revision: 0,
});
const projection = (visible: string): AppSnapshot => ({
  revision: 1, primaryPetId: 'a', walletCoins: 10, doNotDisturb: false, pausedRender: false,
  pets: ['a', 'b', 'c'].map((id) => home(id, visible === id)),
});
const surface = (senderId: number, petId: string, changes: Partial<PetSurfaceInfo> = {}): PetSurfaceInfo => ({
  senderId, identity: identity(petId), phase: 'ACTIVE', visible: true, responsive: true,
  documentReady: true, paintReady: true, visualResult: 'READY', retirementDeadline: undefined, ...changes,
});
const staged = (senderId: number, petId: string, changes: Partial<PetSurfaceInfo> = {}): PetSurfaceInfo => surface(senderId, petId, {
  phase: 'STAGING', visible: false, documentReady: false, paintReady: false, visualResult: undefined, ...changes,
});
const retained = (senderId: number, petId: string, deadline = 10_000): PetSurfaceInfo => surface(senderId, petId, {
  phase: 'RETIRING', retirementDeadline: deadline,
});

describe('Main single-slot pet surface handover', () => {
  it('creates exactly the single home-visible authority target, not the primary pet', () => {
    const snapshot = projection('b');
    expect(desiredPetSurface(snapshot, status, false)).toEqual(identity('b'));
    expect(planPetHandover(snapshot, status, false, [], 0)).toEqual({
      desired: identity('b'), create: identity('b'), active: undefined, staging: undefined, retiring: undefined, remove: [],
    });
    expect(desiredPetSurface({ ...snapshot, pets: [home('a', true), home('b', true)] }, status, false)).toBeUndefined();
    expect(desiredPetSurface(projection('none'), status, false)).toBeUndefined();
  });

  it('retains old A only while latest B is staging, without ever picking A as active', () => {
    const snapshot = projection('b');
    const old = surface(1, 'a');
    expect(planPetHandover(snapshot, status, false, [old], 0)).toMatchObject({
      active: undefined, staging: undefined, retiring: 1, create: identity('b'), remove: [],
    });
    expect(planPetHandover(snapshot, status, false, [retained(1, 'a'), staged(2, 'b')], 1)).toMatchObject({
      active: undefined, staging: 2, retiring: 1, create: undefined, remove: [],
    });
  });

  it('requires DOM load, first paint, visual-ready result and responsive target before swap', () => {
    const snapshot = projection('b');
    const old = retained(1, 'a');
    for (const changes of [
      { documentReady: false }, { paintReady: false }, { visualResult: undefined }, { responsive: false },
    ]) {
      const next = staged(2, 'b', { documentReady: true, paintReady: true, visualResult: 'READY', ...changes });
      expect(planPetHandover(snapshot, status, false, [old, next], 10)).toMatchObject({
        active: undefined, staging: 2, retiring: 1, remove: [], create: undefined,
      });
    }
    for (const result of ['READY', 'FALLBACK'] as const) {
      const next = staged(2, 'b', { documentReady: true, paintReady: true, visualResult: result });
      expect(planPetHandover(snapshot, status, false, [old, next], 10)).toMatchObject({
        active: 2, staging: undefined, retiring: undefined, remove: [1], create: undefined,
      });
    }
  });

  it('reuses ready old A on A->B->A and discards stale B even if it finished late', () => {
    const windows = [retained(1, 'a'), staged(2, 'b', { paintReady: true, documentReady: true, visualResult: 'READY' })];
    const snapshot = projection('a');
    expect(planPetHandover(snapshot, status, false, windows, 5)).toMatchObject({
      active: 1, retiring: undefined, staging: undefined, create: undefined, remove: [2],
    });
    expect(isCurrentVisualReport(identity('b'), identity('a'), { characterId: identity('b').characterId, generation: 8, result: 'READY' })).toBe(false);
  });

  it('replaces obsolete hidden B with newest C and never extends A retirement', () => {
    const windows = [retained(1, 'a', 100), staged(2, 'b')];
    const snapshot = projection('c');
    expect(planPetHandover(snapshot, status, false, windows, 99)).toMatchObject({
      active: undefined, retiring: 1, staging: undefined, create: identity('c'), remove: [2],
    });
    expect(planPetHandover(snapshot, status, false, [windows[0]!, staged(3, 'c')], 100)).toMatchObject({
      active: undefined, retiring: undefined, staging: 3, create: undefined, remove: [1],
    });
  });

  it('clears old frames on suppression, unavailable authority, missing desired pet or new generation', () => {
    const windows = [retained(1, 'a'), staged(2, 'b')];
    const snapshot = projection('b');
    for (const plan of [
      planPetHandover(snapshot, status, true, windows, 0),
      planPetHandover(snapshot, { ...status, stage: 'UNAVAILABLE' }, false, windows, 0),
      planPetHandover(undefined, status, false, windows, 0),
      planPetHandover(projection('none'), status, false, windows, 0),
    ]) expect(plan).toMatchObject({ active: undefined, retiring: undefined, staging: undefined, create: undefined, remove: [1, 2] });
    expect(planPetHandover(snapshot, { ...status, generation: 9 }, false, windows, 0)).toMatchObject({
      active: undefined, retiring: undefined, staging: undefined, create: identity('b', 9), remove: [1, 2],
    });
  });

  it('never retains a departed, re-charactered, invisible, unresponsive or staging old surface', () => {
    const snapshot = projection('b');
    const away: PetSnapshot = { ...home('a'), presence: 'AWAY', activity: null,
      trip: { tripId: 'trip-a', routeId: 'route', status: 'TRAVELING', expectedReturnAt: 30 } };
    const variants = [
      { snapshot: { ...snapshot, pets: [away, home('b', true)] }, old: surface(1, 'a') },
      { snapshot: { ...snapshot, pets: [{ ...home('a'), characterId: 'other' }, home('b', true)] }, old: surface(1, 'a') },
      { snapshot, old: surface(1, 'a', { visible: false }) },
      { snapshot, old: surface(1, 'a', { responsive: false }) },
      { snapshot, old: surface(1, 'a', { phase: 'STAGING' }) },
    ];
    for (const { snapshot: state, old } of variants) {
      expect(planPetHandover(state, status, false, [old, staged(2, 'b')], 0)).toMatchObject({
        active: undefined, retiring: undefined, staging: 2, remove: [1],
      });
    }
  });

  it('rejects stale character/generation/identity and cannot accept arbitrary renderer pet IDs', () => {
    const desired = identity('b');
    const report = { characterId: desired.characterId, generation: desired.generation, result: 'READY' } as const;
    expect(petVisualReadySchema.safeParse({ ...report, petId: 'a' }).success).toBe(false);
    expect(isCurrentVisualReport(identity('b'), desired, report)).toBe(true);
    expect(isCurrentVisualReport(identity('a'), desired, report)).toBe(false);
    expect(isCurrentVisualReport(identity('b', 7), desired, report)).toBe(false);
    expect(isCurrentVisualReport(identity('b'), desired, { ...report, characterId: 'wrong' })).toBe(false);
    expect(isCurrentVisualReport(identity('b'), desired, { ...report, generation: 7 })).toBe(false);
    expect(isCurrentVisualReport(identity('b'), undefined, report)).toBe(false);
  });
});
