import type { AppSnapshot } from '@pet-desktop/contracts';
import type { PetVisualReady, ServiceStatus } from '../shared/protocol';

/** Main-only presentation identity; no ownership or game-state changes. */
export interface PetSurfaceIdentity {
  readonly petId: string;
  readonly characterId: string;
  readonly generation: number;
}

export type PetSurfacePhase = 'STAGING' | 'ACTIVE' | 'RETIRING';

export interface PetSurfaceInfo {
  readonly senderId: number;
  readonly identity: PetSurfaceIdentity;
  readonly phase: PetSurfacePhase;
  readonly documentReady: boolean;
  readonly paintReady: boolean;
  readonly visualResult: PetVisualReady['result'] | undefined;
  readonly responsive: boolean;
  readonly visible: boolean;
  readonly retirementDeadline: number | undefined;
}

export interface PetHandoverPlan {
  readonly desired: PetSurfaceIdentity | undefined;
  readonly active: number | undefined;
  readonly retiring: number | undefined;
  readonly staging: number | undefined;
  readonly remove: readonly number[];
  readonly create: PetSurfaceIdentity | undefined;
}

export function samePetSurface(a: PetSurfaceIdentity, b: PetSurfaceIdentity): boolean {
  return a.petId === b.petId && a.characterId === b.characterId && a.generation === b.generation;
}

/** Fail closed on malformed multiple-visible projections, offline or suppressed host. */
export function desiredPetSurface(
  snapshot: AppSnapshot | undefined,
  status: ServiceStatus,
  suppressed: boolean,
): PetSurfaceIdentity | undefined {
  if (suppressed || status.stage !== 'READY' || !snapshot) return undefined;
  const visible = snapshot.pets.filter((pet) => pet.visibility === 'VISIBLE');
  const only = visible.length === 1 && visible[0]?.presence === 'HOME' ? visible[0] : undefined;
  return only && { petId: only.petId, characterId: only.characterId, generation: status.generation };
}

export function surfaceIsReady(surface: PetSurfaceInfo): boolean {
  return surface.responsive && surface.documentReady && surface.paintReady && surface.visualResult !== undefined;
}

/** The renderer cannot select a pet ID; Main derives it from the bound window. */
export function isCurrentVisualReport(
  identity: PetSurfaceIdentity,
  desired: PetSurfaceIdentity | undefined,
  report: PetVisualReady,
): boolean {
  return desired !== undefined && samePetSurface(identity, desired)
    && report.characterId === desired.characterId && report.generation === desired.generation;
}

/** Only keep an already displayed, healthy, old home-pet surface during a
 * real cross-pet handover. A previous retirement deadline is never extended. */
export function planPetHandover(
  snapshot: AppSnapshot | undefined,
  status: ServiceStatus,
  suppressed: boolean,
  windows: readonly PetSurfaceInfo[],
  now: number,
): PetHandoverPlan {
  const desired = desiredPetSurface(snapshot, status, suppressed);
  const target = desired && windows.find((surface) => samePetSurface(surface.identity, desired));
  const active = target && surfaceIsReady(target) ? target.senderId : undefined;
  const staging = target && active === undefined ? target.senderId : undefined;
  const retiring = desired && active === undefined && snapshot ? windows.find((surface) => {
    if (surface.identity.petId === desired.petId || surface.identity.generation !== desired.generation
      || !surface.visible || !surfaceIsReady(surface) || surface.phase === 'STAGING') return false;
    if (surface.phase === 'RETIRING' && (surface.retirementDeadline === undefined || surface.retirementDeadline <= now)) return false;
    return snapshot.pets.some((pet) => pet.petId === surface.identity.petId
      && pet.characterId === surface.identity.characterId && pet.presence === 'HOME');
  })?.senderId : undefined;

  return {
    desired, active, staging, retiring,
    remove: windows.filter((surface) => surface.senderId !== active
      && surface.senderId !== staging && surface.senderId !== retiring).map((surface) => surface.senderId),
    create: target ? undefined : desired,
  };
}
