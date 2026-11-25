import { advanceHomeState, initializeHomeState, validateHomeSimulationState } from '@pet-desktop/domain/home-simulation';
import type { HomeSimulationState, HomeStateInput } from '@pet-desktop/domain/home-simulation';
import type { AppTransaction, HomeScheduleRecord, PetRecord } from './ports.js';

/** Explicit field projection keeps storage metadata, progression, and utility
 * process presentation fields out of the pure simulation. */
function inputFromPet(pet: PetRecord): HomeStateInput {
  const { petId, presence, activity, mood, healthStatus, energy10, healthPoints10, moodScore10, bond10 } = pet;
  return { petId, presence, activity, mood, healthStatus, energy10, healthPoints10, moodScore10, bond10 };
}

export function initialHomeState(pet: PetRecord, at: number): HomeSimulationState {
  return initializeHomeState(inputFromPet(pet), at);
}

export function scheduleFromHome(state: HomeSimulationState): HomeScheduleRecord {
  const { petId, lastSimAt, activityDueAt, energyRemainder, healthRemainder, moodRemainder,
    interactionDay, interactionCount, lastInteractionAt } = state;
  return { petId, lastSimAt, activityDueAt, energyRemainder, healthRemainder, moodRemainder,
    interactionDay, interactionCount, lastInteractionAt };
}

/** Read and audit the combined persisted facts. The service never presents a
 * schedule from an unknown pet or credits time beyond its authority clock. */
export function readHomeState(tx: AppTransaction, pet: PetRecord, authorityAt: number): HomeSimulationState {
  const schedule = tx.getHomeSchedule(pet.petId);
  if (!schedule || schedule.petId !== pet.petId || schedule.lastSimAt > authorityAt) {
    throw new Error('Missing or inconsistent home schedule');
  }
  const state = { ...inputFromPet(pet), ...schedule };
  validateHomeSimulationState(state);
  return state;
}

export function applyHomeState(pet: PetRecord, home: HomeSimulationState): PetRecord {
  if (pet.petId !== home.petId) throw new Error('Home simulation belongs to another pet');
  const { presence, activity, mood, healthStatus, energy10, healthPoints10, moodScore10, bond10 } = home;
  return { ...pet, presence, activity, mood, healthStatus, energy10, healthPoints10, moodScore10, bond10 };
}

export function hasVisibleHomeChange(pet: PetRecord, home: HomeSimulationState): boolean {
  if (pet.petId !== home.petId) throw new Error('Home simulation belongs to another pet');
  return pet.presence !== home.presence || pet.activity !== home.activity || pet.mood !== home.mood
    || pet.healthStatus !== home.healthStatus || pet.energy10 !== home.energy10 || pet.healthPoints10 !== home.healthPoints10
    || pet.moodScore10 !== home.moodScore10 || pet.bond10 !== home.bond10;
}

/** Explicit presence transitions discard the old activity deadline, retain
 * fractional recovery already earned HOME, and establish the actual boundary.
 * A legacy waterline later than a returned timestamp is conservatively kept. */
export function transitionHomeState(previous: HomeSimulationState, pet: PetRecord, at: number): HomeSimulationState {
  if (previous.petId !== pet.petId || previous.presence === pet.presence) throw new Error('Invalid presence transition');
  const lastSimAt = Math.max(previous.lastSimAt, at);
  const next = { ...inputFromPet(pet), ...scheduleFromHome(previous), lastSimAt, activityDueAt: null };
  // Same-instant normalization only; no HOME time is credited for the offsite
  // interval. The caller subsequently advances the returned pet to its target.
  return advanceHomeState(next, lastSimAt);
}
