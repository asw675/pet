import { eventOccurrenceViewSchema, eventPageSchema } from '@pet-desktop/contracts/events';
import type { EventListQuery, EventOccurrenceView, EventPage, EventReward } from '@pet-desktop/contracts/events';
import type { DomainEvent } from '@pet-desktop/contracts';
import { EVENT_CATALOG } from '@pet-desktop/domain/event-catalog';
import { resolveEventOccurrence, selectEvent } from '@pet-desktop/domain/event-engine';
import type { EventResolutionResult, EventTrigger, FrozenEventOccurrence } from '@pet-desktop/domain/event-engine';
import { levelForXp } from '@pet-desktop/domain/progression';
import { advanceHomeState } from '@pet-desktop/domain/home-simulation';
import { findItemDefinition } from '@pet-desktop/domain/item-catalog';
import { applyHomeState, hasVisibleHomeChange, readHomeState, scheduleFromHome } from '#home-state-service';
import type { AppTransaction, EventOccurrenceRecord, PetRecord } from './ports.js';

/** This policy is authority-only. IPC accepts no chance or seed overrides. */
export type EventPolicy = Readonly<Record<EventTrigger, number>> | false;
export const DEFAULT_EVENT_POLICY: EventPolicy = Object.freeze({ HOME_DAILY: 6000, AFTER_INTERACTION: 3500,
  TRIP_RETURNED: 6000, BOND_MILESTONE: 10000 });
const PENDING_CAP = 3;
const DAY = 86_400_000;

export interface EventMutation {
  readonly tx: AppTransaction;
  readonly policy: EventPolicy;
  readonly authorityAt: number;
  readonly createOccurrenceId: () => string;
  /** Fold multiple effects into the enclosing visible command/return revision. */
  readonly markVisible: () => void;
  readonly emit: (type: string, id: string, cause: string, at: number, payload: DomainEvent['payload']) => void;
}

/** Independent, stable gameplay seed, never used for security or trip RNG. */
export function eventSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return (hash >>> 0) || 1;
}

function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid event effect balance');
  return result;
}

const clamp = (value: number): number => Math.max(0, Math.min(1000, value));

export function triggerEvent(ctx: EventMutation, pet: PetRecord, trigger: EventTrigger, source: string | number, at: number,
  provenance?: { sourceTripId: string; routeId: string }): void {
  if (ctx.policy === false) return;
  if (at > ctx.authorityAt) throw new Error('Event trigger is ahead of authority');
  const key = JSON.stringify([trigger, pet.petId, source]);
  const { tx } = ctx;
  if (tx.getEventTriggerReceipt(key) !== null) return;
  const seed = eventSeed(key);
  const audit = { triggerKey: key, petId: pet.petId, trigger, seed, at,
    sourceTripId: provenance?.sourceTripId ?? null, routeId: provenance?.routeId ?? null };
  if (tx.countPendingEvents(pet.petId) >= PENDING_CAP) {
    tx.insertEventTriggerReceipt({ ...audit, kind: 'NO_EVENT', reason: 'TRIGGER_INELIGIBLE', rngState: seed, drawCount: 0 });
    return;
  }
  const result = selectEvent(EVENT_CATALOG, { trigger, triggerKey: key, occurrenceId: ctx.createOccurrenceId(), seed, at,
    chanceBps: ctx.policy[trigger], context: { petId: pet.petId, characterId: pet.characterId, presence: pet.presence,
      level: levelForXp(pet.xp), bond10: pet.bond10, ...provenance }, history: tx.listEventHistory(pet.petId, at) });
  const rng = { rngState: result.rngState, drawCount: result.drawCount };
  if (result.kind === 'NO_EVENT') {
    tx.insertEventTriggerReceipt({ ...audit, ...rng, kind: 'NO_EVENT', reason: result.reason });
    return;
  }
  const occurrence = result.occurrence;
  tx.insertEventTriggerReceipt({ ...audit, ...rng, kind: 'OCCURRENCE', occurrenceId: occurrence.occurrenceId });
  tx.insertEventOccurrence(occurrence);
  ctx.markVisible();
  ctx.emit('EventOccurred', occurrence.occurrenceId, occurrence.occurrenceId, at, { petId: pet.petId, eventId: occurrence.eventId, trigger });
  if (occurrence.choices.length === 0) {
    const resolved = resolveEventOccurrence(occurrence, { kind: 'AUTO', occurrenceId: occurrence.occurrenceId,
      petId: pet.petId, status: 'PENDING', at });
    if (!resolved.ok) throw new Error('Frozen automatic event failed resolution');
    commitResolution(ctx, occurrence, resolved, null);
  }
}

export function triggerDaily(ctx: EventMutation, pet: PetRecord, at: number): void {
  if (pet.presence === 'HOME') triggerEvent(ctx, pet, 'HOME_DAILY', Math.floor(at / DAY), at);
}

/** Only actually crossed thresholds are considered. Each key is durable,
 * even when prerequisites are absent or the pending cap is reached. A
 * chained event can cross another threshold, but cannot reroll an old key. */
export function triggerBondMilestones(ctx: EventMutation, petId: string, before: number, after: number, at: number): void {
  if (ctx.policy === false || after <= before) return;
  for (const threshold of [200, 500, 800]) {
    if (before >= threshold || after < threshold) continue;
    const pet = ctx.tx.getPet(petId);
    if (!pet) throw new Error('Milestone pet is missing');
    triggerEvent(ctx, pet, 'BOND_MILESTONE', threshold, at);
  }
}

export function expireEvent(ctx: EventMutation, record: EventOccurrenceRecord): void {
  const o = record.occurrence;
  const resolved = resolveEventOccurrence(o, { kind: 'EXPIRE', occurrenceId: o.occurrenceId, petId: o.petId,
    status: record.status, at: ctx.authorityAt });
  if (!resolved.ok) throw new Error('Due event failed frozen expiry');
  commitResolution(ctx, o, resolved, null);
}

export function chooseEvent(ctx: EventMutation, record: EventOccurrenceRecord, choiceId: string, commandId: string): boolean {
  const o = record.occurrence;
  const resolved = resolveEventOccurrence(o, { kind: 'CHOICE', occurrenceId: o.occurrenceId, petId: o.petId,
    status: record.status, at: ctx.authorityAt, choiceId });
  if (!resolved.ok) return false;
  commitResolution(ctx, o, resolved, commandId);
  return true;
}

function commitResolution(ctx: EventMutation, occurrence: FrozenEventOccurrence,
  resolution: Extract<EventResolutionResult, { ok: true }>, commandId: string | null): void {
  const { tx } = ctx;
  const { effects, resolvedAt } = resolution;
  const pet = tx.getPet(occurrence.petId);
  if (!pet || pet.characterId !== occurrence.characterId || resolvedAt > ctx.authorityAt) throw new Error('Invalid event owner/time');
  // Integrate to the actual deadline/choice, not the eventual catch-up time.
  // Offsite pets retain their frozen travel inputs and receive no HOME recovery.
  const home = advanceHomeState(readHomeState(tx, pet, ctx.authorityAt), resolvedAt);
  const moodScore10 = clamp(home.moodScore10 + effects.moodDelta10), bond10 = clamp(home.bond10 + effects.bondDelta10);
  const next = advanceHomeState({ ...home, moodScore10, bond10,
    moodRemainder: moodScore10 === home.moodScore10 ? home.moodRemainder : 0 }, home.lastSimAt);
  const rewards: EventReward[] = [];
  if (effects.moodDelta10 !== 0) rewards.push({ kind: 'MOOD_DELTA', delta10: moodScore10 - home.moodScore10 });
  if (effects.bondDelta10 !== 0) rewards.push({ kind: 'BOND_DELTA', delta10: bond10 - home.bond10 });
  if (hasVisibleHomeChange(pet, next)) tx.savePet({ ...applyHomeState(pet, next), revision: add(pet.revision, 1) });
  tx.saveHomeSchedule(scheduleFromHome(next));
  if (effects.coins > 0) {
    tx.setWalletCoins(add(tx.getWalletCoins(), effects.coins));
    rewards.push({ kind: 'COIN', amount: effects.coins });
  }
  for (const item of effects.items) {
    const definition = findItemDefinition(item.itemId);
    if (!definition || definition.kind === 'EQUIPMENT') throw new Error('Event effect refers to invalid stack item');
    tx.addInventory(item.itemId, item.quantity);
    rewards.push({ kind: 'ITEM', itemId: item.itemId, quantity: item.quantity });
  }
  if (effects.cgUnlock) {
    const { cgId, variant } = effects.cgUnlock;
    const newlyUnlocked = tx.getCgUnlock(pet.petId, cgId, variant) === null && tx.getEventCgUnlock(pet.petId, cgId, variant) === null;
    rewards.push({ kind: 'CG_UNLOCK', cgId, variant, newlyUnlocked });
  }
  // A lost CAS or any failure rolls back rewards, selection and outbox together.
  if (!tx.finalizeEventOccurrence({ occurrenceId: occurrence.occurrenceId, status: resolution.status, resolvedAt,
    choiceId: resolution.choiceId, resultText: resolution.resultText, rewards, commandId })) throw new Error('Event was finalized concurrently');
  ctx.markVisible();
  ctx.emit('EventFinalized', occurrence.occurrenceId, commandId ?? occurrence.occurrenceId, resolvedAt,
    { petId: pet.petId, eventId: occurrence.eventId, status: resolution.status, choiceId: resolution.choiceId });
  for (const reward of rewards) if (reward.kind === 'CG_UNLOCK' && reward.newlyUnlocked) {
    ctx.emit('CGUnlocked', pet.petId, commandId ?? occurrence.occurrenceId, resolvedAt,
      { sourceEventId: occurrence.occurrenceId, cgId: reward.cgId, variant: reward.variant });
  }
  triggerBondMilestones(ctx, pet.petId, home.bond10, bond10, resolvedAt);
}

function projectEvent(record: EventOccurrenceRecord): EventOccurrenceView {
  const o = record.occurrence;
  const artState = record.rewards.some(reward => reward.kind === 'CG_UNLOCK') ? 'UNLOCKED'
    : o.asset?.state === 'PINNED' ? 'LOCKED' : o.asset?.state === 'FUTURE_UNAVAILABLE' ? 'UNAVAILABLE' : 'NONE';
  return eventOccurrenceViewSchema.parse({ occurrenceId: o.occurrenceId, petId: o.petId, characterId: o.characterId,
    eventId: o.eventId, eventVersion: o.eventVersion, trigger: o.trigger, sourceTripId: o.sourceTripId, routeId: o.routeId,
    occurredAt: o.occurredAt, rarity: o.rarity, title: o.narrative.title, narrative: o.narrative.text, actionId: o.narrative.actionId,
    choices: o.choices.map(choice => ({ choiceId: choice.choiceId, label: choice.label })), deadlineAt: o.deadlineAt,
    artState, status: record.status, resolvedAt: record.resolvedAt, selectedChoiceId: record.choiceId,
    resultText: record.resultText, rewards: record.rewards });
}

export function projectEvents(tx: AppTransaction, query: EventListQuery, revision: number): EventPage {
  const { total, pendingTotal, events } = tx.listEvents(query);
  return eventPageSchema.parse({ revision, petId: query.petId ?? null, filter: query.filter, offset: query.offset, limit: query.limit,
    total, pendingTotal, rows: events.map(projectEvent) });
}
