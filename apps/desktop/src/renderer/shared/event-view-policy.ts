import type { AppSnapshot } from '@pet-desktop/contracts';
import { eventChoosePayloadSchema, eventListQuerySchema } from '@pet-desktop/contracts/events';
import type { EventChoosePayload, EventListQuery, EventOccurrenceView, EventPage, EventReward } from '@pet-desktop/contracts/events';

export const eventTriggerLabel: Readonly<Record<EventOccurrenceView['trigger'], string>> = Object.freeze({
  HOME_DAILY: '日常事件', AFTER_INTERACTION: '互动事件', TRIP_RETURNED: '归家事件', BOND_MILESTONE: '亲密关系事件',
});
export const eventRarityLabel: Readonly<Record<EventOccurrenceView['rarity'], string>> = Object.freeze({
  COMMON: '普通', RARE: '稀有', EPIC: '史诗', LEGENDARY: '传说',
});
export const eventStatusLabel: Readonly<Record<EventOccurrenceView['status'], string>> = Object.freeze({
  PENDING: '等待选择', RESOLVED: '已完成', EXPIRED: '已按超时规则完成',
});
export type PendingEventView = Extract<EventOccurrenceView, { status: 'PENDING' }>;
export interface StampedEventPage {
  readonly generation: number;
  readonly snapshot: AppSnapshot;
  readonly query: EventListQuery;
  readonly page: EventPage;
}

export function eventQueryKey(query: EventListQuery): string {
  return JSON.stringify([query.petId ?? null, query.filter, query.offset, query.limit]);
}
export function eventsMatchQuery(page: EventPage, query: EventListQuery): boolean {
  return page.petId === (query.petId ?? null) && page.filter === query.filter
    && page.offset === query.offset && page.limit === query.limit;
}

/** Supplemental event data may not replace a coherent main projection. */
export function eventSnapshotsMatch(left: AppSnapshot, right: AppSnapshot): boolean {
  if (left.revision !== right.revision || left.walletCoins !== right.walletCoins || left.primaryPetId !== right.primaryPetId
    || left.doNotDisturb !== right.doNotDisturb || left.pausedRender !== right.pausedRender || left.pets.length !== right.pets.length) return false;
  const pets = new Map(left.pets.map(pet => [pet.petId, pet]));
  return pets.size === left.pets.length && new Set(right.pets.map(pet => pet.petId)).size === right.pets.length
    && right.pets.every(pet => JSON.stringify(pets.get(pet.petId)) === JSON.stringify(pet));
}
export function eventQueryCanAccept(page: EventPage, returnedSnapshot: AppSnapshot, live: AppSnapshot | null,
  baseRevision: number, query: EventListQuery): boolean {
  return live !== null && page.revision === returnedSnapshot.revision && page.revision >= baseRevision
    && page.revision >= live.revision && eventsMatchQuery(page, query)
    && (page.revision > live.revision || eventSnapshotsMatch(returnedSnapshot, live));
}
export function usableEventPage(stamp: StampedEventPage | null, generation: number | null, live: AppSnapshot | null,
  query: EventListQuery): EventPage | null {
  return stamp && generation !== null && stamp.generation === generation && live
    && stamp.page.revision === live.revision && eventSnapshotsMatch(stamp.snapshot, live)
    && eventQueryKey(stamp.query) === eventQueryKey(query) && eventsMatchQuery(stamp.page, query) ? stamp.page : null;
}
export function eventPageOffset(page: EventPage, direction: -1 | 1): number | undefined {
  const offset = page.offset + page.limit * direction;
  return offset >= 0 && offset < page.total && eventListQuerySchema.safeParse({
    offset, limit: page.limit, filter: page.filter, ...(page.petId ? { petId: page.petId } : {}),
  }).success ? offset : undefined;
}

/** Renderer wall time is a display/extra conservative guard only. It never
 * resolves an event or gets sent to the authority as the resolution clock. */
export function eventChoiceWindowOpen(event: EventOccurrenceView, displayNow: number): event is PendingEventView {
  return event.status === 'PENDING' && Number.isSafeInteger(displayNow) && displayNow >= 0 && displayNow < event.deadlineAt;
}
export function eventDeadlineText(event: EventOccurrenceView, displayNow: number): string {
  if (event.status !== 'PENDING') return event.deadlineAt === null ? '无需选择' : '选择已结束';
  if (!eventChoiceWindowOpen(event, displayNow)) return '已到显示截止时间，等待服务确认';
  const seconds = Math.ceil((event.deadlineAt - displayNow) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  return h > 0 ? `约 ${h} 小时 ${m} 分钟` : `约 ${m} 分 ${s} 秒`;
}

export interface EventChoiceConfirmation {
  readonly generation: number;
  readonly revision: number;
  readonly petId: string;
  readonly petName: string;
  readonly occurrenceId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly title: string;
  readonly choiceId: string;
  readonly choiceLabel: string;
  readonly deadlineAt: number;
  readonly fingerprint: string;
}

/** A pending choice reflects only authored narrative and label from the
 * exact occurrence. No branch rewards are guessed, pre-applied or exposed. */
export function createEventChoiceConfirmation(stamp: StampedEventPage | null, generation: number | null,
  live: AppSnapshot | null, query: EventListQuery, occurrenceId: string, choiceId: string, displayNow: number,
  allow: boolean): EventChoiceConfirmation | undefined {
  const page = usableEventPage(stamp, generation, live, query);
  const row = page?.rows.find(event => event.occurrenceId === occurrenceId);
  if (!page || !row || !live || generation === null || !allow || !eventChoiceWindowOpen(row, displayNow)) return undefined;
  const pet = live.pets.find(candidate => candidate.petId === row.petId && candidate.characterId === row.characterId);
  const choice = row.choices.find(candidate => candidate.choiceId === choiceId);
  if (!pet || !choice) return undefined;
  // Away/returning pets can complete their existing choice. Presence is
  // not a reason to deny a frozen event; it is not a new trigger.
  const body = {
    generation, revision: page.revision, petId: pet.petId, petName: pet.nickname,
    occurrenceId: row.occurrenceId, eventId: row.eventId, eventVersion: row.eventVersion, title: row.title,
    choiceId: choice.choiceId, choiceLabel: choice.label, deadlineAt: row.deadlineAt,
  };
  const fingerprint = JSON.stringify([body, eventQueryKey(query), row, pet]);
  return Object.freeze({ ...body, fingerprint });
}

export function confirmEventChoice(confirmation: EventChoiceConfirmation, stamp: StampedEventPage | null,
  generation: number | null, live: AppSnapshot | null, query: EventListQuery, displayNow: number,
  allow: boolean): EventChoosePayload | undefined {
  const fresh = createEventChoiceConfirmation(stamp, generation, live, query, confirmation.occurrenceId, confirmation.choiceId, displayNow, allow);
  if (!fresh || fresh.generation !== confirmation.generation || fresh.revision !== confirmation.revision
    || fresh.fingerprint !== confirmation.fingerprint || fresh.petId !== confirmation.petId
    || fresh.petName !== confirmation.petName || fresh.eventId !== confirmation.eventId
    || fresh.eventVersion !== confirmation.eventVersion || fresh.title !== confirmation.title
    || fresh.choiceLabel !== confirmation.choiceLabel || fresh.deadlineAt !== confirmation.deadlineAt) return undefined;
  const payload = eventChoosePayloadSchema.safeParse({ petId: fresh.petId, occurrenceId: fresh.occurrenceId, choiceId: fresh.choiceId });
  return payload.success ? payload.data : undefined;
}

export function chosenEventLabel(event: EventOccurrenceView): string {
  if (event.status === 'PENDING') return '尚未选择';
  if (event.selectedChoiceId === null) return '服务自动完成';
  return event.choices.find(choice => choice.choiceId === event.selectedChoiceId)?.label ?? event.selectedChoiceId;
}
export function eventRewardText(reward: EventReward): string {
  const signed = (label: string, delta: number) => `${label}${delta === 0 ? '未变化' : ` ${delta > 0 ? '+' : ''}${delta / 10} 点`}`;
  switch (reward.kind) {
    case 'MOOD_DELTA': return signed('心情', reward.delta10);
    case 'BOND_DELTA': return signed('好感', reward.delta10);
    case 'COIN': return `游戏金币 +${reward.amount}`;
    case 'ITEM': return `${reward.itemId} × ${reward.quantity}`;
    case 'CG_UNLOCK': return `${reward.newlyUnlocked ? '新解锁' : '已收藏（未重复发放）'} CG ${reward.cgId} · ${reward.variant}`;
  }
}
export function hasUnlockedEventArt(event: EventOccurrenceView): boolean {
  return event.status !== 'PENDING' && event.artState === 'UNLOCKED' && event.rewards.some(reward => reward.kind === 'CG_UNLOCK');
}
