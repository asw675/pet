import { describe, expect, it } from 'vitest';
import { appSnapshotSchema, domainCommandSchema, eventsIpcResultSchema } from '@pet-desktop/contracts';
import type { AppSnapshot, PetSnapshot } from '@pet-desktop/contracts';
import { eventOccurrenceViewSchema, eventPageSchema } from '@pet-desktop/contracts/events';
import type { EventListQuery, EventOccurrenceView, EventPage, EventReward } from '@pet-desktop/contracts/events';
import { EVENT_CATALOG } from '@pet-desktop/domain/event-catalog';
import { resolveEventOccurrence, selectEvent } from '@pet-desktop/domain/event-engine';
import type { EventTrigger, FrozenEventOccurrence } from '@pet-desktop/domain/event-engine';
import {
  chosenEventLabel, confirmEventChoice, createEventChoiceConfirmation, eventChoiceWindowOpen, eventDeadlineText,
  eventPageOffset, eventQueryCanAccept, eventQueryKey, eventRewardText, eventSnapshotsMatch, eventsMatchQuery, hasUnlockedEventArt, usableEventPage,
} from '../src/renderer/shared/event-view-policy';
import type { EventChoiceConfirmation, PendingEventView, StampedEventPage } from '../src/renderer/shared/event-view-policy';

const NOW = 86_400_000 * 5 + 123;
const GEN = 7;
const pet = (petId: string, characterId: string, nickname: string, edits: Partial<PetSnapshot> = {}): PetSnapshot => ({
  petId, characterId, nickname, level: 2, xp: 100, revision: 3, presence: 'HOME', activity: 'IDLE', mood: 'CALM',
  healthStatus: 'NORMAL', visibility: petId === 'star' ? 'VISIBLE' : 'HIDDEN', moodScore: 95, healthPoints: 100, energy: 75, bond: 20, ...edits,
});
const star = pet('star', 'star-singer', '星咏');
const ranger = pet('ranger', 'fluffy-ranger', '绒绒', { presence: 'AWAY', activity: null, trip: {
  tripId: 'current-trip', routeId: 'mist-forest', status: 'TRAVELING', expectedReturnAt: NOW + 3_600_000,
} });
const nova = pet('nova', 'nova', '诺瓦');
const snapshot = appSnapshotSchema.parse({ revision: 9, walletCoins: 20, primaryPetId: star.petId,
  doNotDisturb: false, pausedRender: false, pets: [star, ranger, nova] });
const query: EventListQuery = { filter: 'PENDING', offset: 0, limit: 2 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function occurrence(character: PetSnapshot, trigger: EventTrigger, at: number): FrozenEventOccurrence {
  const outcome = selectEvent(EVENT_CATALOG, { trigger, triggerKey: `${character.petId}:${trigger}:test`,
    occurrenceId: `occ-${character.petId}-${trigger}`, seed: 8, at, chanceBps: 10000, history: [],
    context: { petId: character.petId, characterId: character.characterId, presence: 'HOME',
      level: character.level, bond10: character.bond * 10,
      ...(trigger === 'TRIP_RETURNED' ? { routeId: 'morning-dew-meadow', sourceTripId: 'earlier-trip' } : {}),
    } });
  if (outcome.kind !== 'OCCURRENCE') throw new Error('Missing actual authored event');
  return outcome.occurrence;
}
function fields(frozen: FrozenEventOccurrence) {
  return {
    occurrenceId: frozen.occurrenceId, petId: frozen.petId, characterId: frozen.characterId, eventId: frozen.eventId,
    eventVersion: frozen.eventVersion, trigger: frozen.trigger, sourceTripId: frozen.sourceTripId, routeId: frozen.routeId,
    occurredAt: frozen.occurredAt, rarity: frozen.rarity, title: frozen.narrative.title, narrative: frozen.narrative.text,
    actionId: frozen.narrative.actionId, choices: frozen.choices.map(({ choiceId, label }) => ({ choiceId, label })),
    deadlineAt: frozen.deadlineAt,
    artState: frozen.asset === null ? 'NONE' : frozen.asset.state === 'PINNED' ? 'LOCKED' : 'UNAVAILABLE',
  };
}
function pending(frozen: FrozenEventOccurrence): PendingEventView {
  const result = eventOccurrenceViewSchema.parse({ ...fields(frozen), status: 'PENDING', resolvedAt: null,
    selectedChoiceId: null, resultText: null, rewards: [] });
  if (result.status !== 'PENDING') throw new Error('pending fixture');
  return result;
}
function settled(frozen: FrozenEventOccurrence, kind: 'CHOICE' | 'EXPIRE' | 'AUTO', rewards: EventReward[], choiceId = frozen.defaultChoiceId!) {
  const base = { occurrenceId: frozen.occurrenceId, petId: frozen.petId, status: 'PENDING' as const,
    at: kind === 'EXPIRE' ? frozen.deadlineAt! + 100 : frozen.occurredAt + 100 };
  const outcome = resolveEventOccurrence(frozen, kind === 'CHOICE' ? { ...base, kind, choiceId } : { ...base, kind });
  if (!outcome.ok) throw new Error('actual resolution fixture failed');
  return eventOccurrenceViewSchema.parse({ ...fields(frozen), status: outcome.status, resolvedAt: outcome.resolvedAt,
    selectedChoiceId: outcome.choiceId, resultText: outcome.resultText, rewards,
    ...(rewards.some(reward => reward.kind === 'CG_UNLOCK') ? { artState: 'UNLOCKED' } : {}) });
}
const starStory = occurrence(star, 'HOME_DAILY', NOW - 1000);
const rangerStory = occurrence(ranger, 'TRIP_RETURNED', NOW - 100);
const novaStory = occurrence(nova, 'TRIP_RETURNED', NOW - 2100);
const r = pending(rangerStory), s = pending(starStory);
const page = eventPageSchema.parse({ revision: snapshot.revision, petId: null, filter: 'PENDING', offset: 0, limit: 2,
  pendingTotal: 2, total: 2, rows: [r, s] });
const stamp: StampedEventPage = { generation: GEN, snapshot, query, page };
const starChoice = s.choices[0]!.choiceId;
const rangerChoice = r.choices[0]!.choiceId;
function create(stamped: StampedEventPage | null = stamp, event = s, choiceId = starChoice,
  gen: number | null = GEN, source: AppSnapshot | null = snapshot, scope = query, displayNow = NOW, allow = true) {
  return createEventChoiceConfirmation(stamped, gen, source, scope, event.occurrenceId, choiceId, displayNow, allow);
}
const quote = create()!;
const confirm = (confirmation = quote, stamped: StampedEventPage | null = stamp, gen: number | null = GEN,
  source: AppSnapshot | null = snapshot, scope = query, displayNow = NOW, allow = true) =>
  confirmEventChoice(confirmation, stamped, gen, source, scope, displayNow, allow);

describe('authoritative event list and revision scope', () => {
  it('projects actual star/ranger authored story labels without hiding unknowns or exposing draft branch effects', () => {
    expect(s.title).toBe('星光笔记的空白页');
    expect(r.title).toBe('归家后的草原故事');
    expect(s.choices).toEqual(starStory.choices.map(({ choiceId, label }) => ({ choiceId, label })));
    expect(r.sourceTripId).toBe('earlier-trip');
    expect(r.routeId).toBe('morning-dew-meadow');
    expect(snapshot.pets[1]!.trip?.tripId).toBe('current-trip');
    expect(s.choices.every(choice => Object.keys(choice).sort().join(',') === 'choiceId,label')).toBe(true);
    expect(s.rewards).toEqual([]);
    expect(r.artState).toBe('LOCKED');
  });
  it('uses the actual event IPC payload with the same source revision and identities', () => {
    expect(eventsIpcResultSchema.safeParse({ schemaVersion: 1, ok: true, requestId: 'req', snapshot, events: page }).success).toBe(true);
    expect(eventsIpcResultSchema.safeParse({ schemaVersion: 1, ok: true, requestId: 'req', snapshot: { ...snapshot, revision: 10 }, events: page }).success).toBe(false);
    expect(eventsIpcResultSchema.safeParse({ schemaVersion: 1, ok: true, requestId: 'req', snapshot: { ...snapshot, pets: [star, nova] }, events: page }).success).toBe(false);
  });
  it('requires exact event scope and canonical query fingerprint', () => {
    expect(eventsMatchQuery(page, { limit: 2, offset: 0, filter: 'PENDING' })).toBe(true);
    expect(eventQueryKey(query)).toBe(eventQueryKey({ limit: 2, offset: 0, filter: 'PENDING' }));
    for (const edit of [{ petId: star.petId }, { filter: 'ALL' as const }, { offset: 2 }, { limit: 1 }]) {
      expect(eventsMatchQuery(page, { ...query, ...edit })).toBe(false);
      expect(eventQueryKey(query)).not.toBe(eventQueryKey({ ...query, ...edit }));
      expect(usableEventPage(stamp, GEN, snapshot, { ...query, ...edit })).toBeNull();
    }
  });
  it('reordered pets are equivalent but changed wallet, preference, primary, or pet data are not', () => {
    expect(eventSnapshotsMatch(snapshot, clone(snapshot))).toBe(true);
    expect(eventSnapshotsMatch(snapshot, { ...snapshot, pets: [...snapshot.pets].reverse() })).toBe(true);
    for (const edit of [{ walletCoins: 21 }, { primaryPetId: ranger.petId }, { revision: 10 },
      { doNotDisturb: true }, { pausedRender: true }, { pets: [{ ...star, bond: 21 }, ranger, nova] },
      { pets: [star, ranger, ranger] }]) {
      expect(eventSnapshotsMatch(snapshot, { ...snapshot, ...edit })).toBe(false);
      expect(usableEventPage(stamp, GEN, { ...snapshot, ...edit }, query)).toBeNull();
    }
  });
  it('cannot use a prior generation or absent live snapshot', () => {
    expect(usableEventPage(stamp, GEN, snapshot, query)).toBe(page);
    expect(usableEventPage(stamp, GEN + 1, snapshot, query)).toBeNull();
    expect(usableEventPage(stamp, null, snapshot, query)).toBeNull();
    expect(usableEventPage(stamp, GEN, null, query)).toBeNull();
    expect(usableEventPage(null, GEN, snapshot, query)).toBeNull();
  });
  it('rejects out-of-order, contradictory and mismatching query results', () => {
    expect(eventQueryCanAccept(page, snapshot, snapshot, 9, query)).toBe(true);
    expect(eventQueryCanAccept(page, snapshot, snapshot, 10, query)).toBe(false);
    expect(eventQueryCanAccept(page, snapshot, { ...snapshot, revision: 10 }, 9, query)).toBe(false);
    expect(eventQueryCanAccept(page, { ...snapshot, walletCoins: 3 }, snapshot, 9, query)).toBe(false);
    expect(eventQueryCanAccept(page, snapshot, snapshot, 9, { ...query, filter: 'HISTORY' })).toBe(false);
    expect(eventQueryCanAccept(page, snapshot, null, 9, query)).toBe(false);
  });
  it('an ahead reply is staged but not actionable until the exact main snapshot catches up', () => {
    const future = { ...snapshot, revision: 10, walletCoins: 21 };
    const futurePage = { ...page, revision: future.revision };
    expect(eventQueryCanAccept(futurePage, future, snapshot, 9, query)).toBe(true);
    const ahead: StampedEventPage = { ...stamp, snapshot: future, page: futurePage };
    expect(usableEventPage(ahead, GEN, snapshot, query)).toBeNull();
    expect(usableEventPage(ahead, GEN, future, query)).toBe(futurePage);
  });
  it('paginates the actual server total, not just the visible row count', () => {
    const first = { ...page, total: 5, pendingTotal: 5 };
    expect(eventPageOffset(first, -1)).toBeUndefined();
    expect(eventPageOffset(first, 1)).toBe(2);
    expect(eventPageOffset({ ...first, offset: 2 }, 1)).toBe(4);
    expect(eventPageOffset({ ...first, offset: 4, rows: [s] }, 1)).toBeUndefined();
    expect(eventPageOffset({ ...first, offset: 4, rows: [s] }, -1)).toBe(2);
  });
  it('does not create an out-of-contract page offset even for very large histories', () => {
    expect(eventPageOffset({ ...page, offset: 1_000_000, total: 1_000_003, pendingTotal: 1_000_003 }, 1)).toBeUndefined();
    expect(eventPageOffset({ ...page, offset: 1_000_000, total: 1_000_003, pendingTotal: 1_000_003 }, -1)).toBe(999_998);
  });
  it('rejects a different pet scope instead of narrowing the current page in renderer', () => {
    const scoped = { ...query, petId: ranger.petId };
    const one = eventPageSchema.parse({ ...page, petId: ranger.petId, total: 1, pendingTotal: 1, rows: [r] });
    expect(eventQueryCanAccept(page, snapshot, snapshot, 9, scoped)).toBe(false);
    expect(eventQueryCanAccept(one, snapshot, snapshot, 9, scoped)).toBe(true);
    expect(eventPageSchema.safeParse({ ...one, rows: [s] }).success).toBe(false);
  });
});

describe('explicit choice confirmation', () => {
  it('freezes the exact occurrence, revision, choice label and display deadline, not outcome', () => {
    expect(quote).toMatchObject({ generation: GEN, revision: 9, petId: star.petId, petName: star.nickname,
      title: s.title, eventId: s.eventId, eventVersion: s.eventVersion, occurrenceId: s.occurrenceId,
      choiceId: starChoice, choiceLabel: s.choices[0]!.label, deadlineAt: s.deadlineAt });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(quote).not.toHaveProperty('effects');
    expect(quote).not.toHaveProperty('rewards');
  });
  it('submits only the exact pet/occurrence/choice identity with enforced expected revision', () => {
    const payload = confirm();
    expect(payload).toEqual({ petId: star.petId, occurrenceId: s.occurrenceId, choiceId: starChoice });
    const command = { type: 'EVENT_CHOOSE', payload, commandId: 'click-1', issuedAt: NOW };
    expect(domainCommandSchema.safeParse(command).success).toBe(false);
    expect(domainCommandSchema.safeParse({ ...command, expectedRevision: quote.revision }).success).toBe(true);
    expect(domainCommandSchema.safeParse({ ...command, expectedRevision: quote.revision, payload: { ...payload, at: NOW } }).success).toBe(false);
  });
  it('allows an already-triggered pending story to be answered while its pet is away', () => {
    const awayQuote = create(stamp, r, rangerChoice);
    expect(awayQuote).toBeDefined();
    expect(confirm(awayQuote!)).toEqual({ petId: ranger.petId, occurrenceId: r.occurrenceId, choiceId: rangerChoice });
  });
  it('also allows a frozen occurrence for a returning pet', () => {
    const source: AppSnapshot = { ...snapshot, pets: [star, { ...ranger, presence: 'RETURNING' }, nova] };
    const returning = { ...stamp, snapshot: source };
    expect(create(returning, r, rangerChoice, GEN, source)).toBeDefined();
  });
  it('rejects missing pet, mismatched character or unknown occurrence/choice', () => {
    for (const source of [{ ...snapshot, pets: [ranger, nova] },
      { ...snapshot, pets: [{ ...star, characterId: 'nova' }, ranger, nova] }]) {
      expect(create({ ...stamp, snapshot: source }, s, starChoice, GEN, source)).toBeUndefined();
    }
    expect(create(stamp, { ...s, occurrenceId: 'other-occurrence' })).toBeUndefined();
    expect(create(stamp, s, 'unknown-choice')).toBeUndefined();
  });
  it('blocks stale generation, revision, changed query or busy/disallowed command', () => {
    expect(confirm(quote, stamp, GEN + 1)).toBeUndefined();
    expect(confirm(quote, stamp, GEN, { ...snapshot, revision: 10 })).toBeUndefined();
    expect(confirm(quote, stamp, GEN, snapshot, { ...query, offset: 2 })).toBeUndefined();
    expect(confirm(quote, stamp, GEN, snapshot, query, NOW, false)).toBeUndefined();
    expect(create(stamp, s, starChoice, GEN, snapshot, query, NOW, false)).toBeUndefined();
  });
  it.each([
    ['choice label', { choices: [{ ...s.choices[0]!, label: '另一个选择' }, ...s.choices.slice(1)] }],
    ['narrative', { narrative: '另一个故事情节' }],
    ['deadline', { deadlineAt: s.deadlineAt + 1 }],
    ['event version', { eventVersion: s.eventVersion + 1 }],
    ['title', { title: '改过的标题' }],
  ] as const)('rejects %s change even at same revision', (_label, edit) => {
    const changed: EventPage = { ...page, rows: [r, { ...s, ...edit, choices: edit && 'choices' in edit ? [...edit.choices] : s.choices }] };
    expect(confirm(quote, { ...stamp, page: changed })).toBeUndefined();
  });
  it('refreshing the exact same row preserves the quote, whereas changing the actual pet name invalidates it', () => {
    expect(confirm(quote, clone(stamp))).toBeDefined();
    const renamed = { ...snapshot, pets: [{ ...star, nickname: '新昵称' }, ranger, nova] };
    expect(confirm(quote, { ...stamp, snapshot: renamed }, GEN, renamed)).toBeUndefined();
  });
  it('does not accept a different occurrence masquerading as the previous confirmation fingerprint', () => {
    const altered: EventChoiceConfirmation = { ...quote, occurrenceId: r.occurrenceId, choiceId: rangerChoice };
    expect(confirm(altered)).toBeUndefined();
    expect(confirm({ ...quote, choiceLabel: '替换展示文字' })).toBeUndefined();
    expect(confirm({ ...quote, title: '替换展示标题' })).toBeUndefined();
  });
  it('allows just before the display deadline, blocks exactly at deadline without doing a resolution', () => {
    expect(eventChoiceWindowOpen(s, s.deadlineAt - 1)).toBe(true);
    expect(confirm(quote, stamp, GEN, snapshot, query, s.deadlineAt - 1)).toBeDefined();
    expect(eventChoiceWindowOpen(s, s.deadlineAt)).toBe(false);
    expect(confirm(quote, stamp, GEN, snapshot, query, s.deadlineAt)).toBeUndefined();
    expect(s.status).toBe('PENDING');
    expect(s.rewards).toEqual([]);
  });
  it.each([Number.NaN, Infinity, -1, 2.5])('rejects invalid display clock %s', time => {
    expect(eventChoiceWindowOpen(s, time)).toBe(false);
    expect(confirm(quote, stamp, GEN, snapshot, query, time)).toBeUndefined();
  });
  it('display countdown is approximate and not a client-side finalization', () => {
    expect(eventDeadlineText(s, s.deadlineAt - 60_001)).toBe('约 1 分 1 秒');
    expect(eventDeadlineText(s, s.deadlineAt - 3_600_001)).toBe('约 1 小时 0 分钟');
    expect(eventDeadlineText(s, s.deadlineAt)).toContain('等待服务确认');
    expect(chosenEventLabel(s)).toBe('尚未选择');
  });
});

describe('actual resolution history/reward projection', () => {
  const starResolved = settled(starStory, 'CHOICE', [{ kind: 'MOOD_DELTA', delta10: 5 }, { kind: 'BOND_DELTA', delta10: 15 }], 'share-notes');
  const rangerExpired = settled(rangerStory, 'EXPIRE', [{ kind: 'CG_UNLOCK', cgId: rangerStory.eventId, variant: 'default', newlyUnlocked: true }]);
  const novaResolved = settled(novaStory, 'AUTO', [{ kind: 'MOOD_DELTA', delta10: 15 }, { kind: 'ITEM', itemId: 'slime-gel', quantity: 1 }]);
  it('reports the selected authored branch and actual clamped mood reward, not the domain draft', () => {
    expect(chosenEventLabel(starResolved)).toBe(s.choices[0]!.label);
    expect(starResolved.status).toBe('RESOLVED');
    expect(starResolved.rewards.map(eventRewardText)).toEqual(['心情 +0.5 点', '好感 +1.5 点']);
    expect(eventDeadlineText(starResolved, NOW)).toBe('选择已结束');
  });
  it('records automatic completion for actual choice-less Nova travel story and no deadline', () => {
    expect(novaResolved.eventId).toBe('nova.field-calibration');
    expect(novaResolved.selectedChoiceId).toBeNull();
    expect(chosenEventLabel(novaResolved)).toBe('服务自动完成');
    expect(eventDeadlineText(novaResolved, NOW)).toBe('无需选择');
    expect(novaResolved.rewards.map(eventRewardText)).toEqual(['心情 +1.5 点', 'slime-gel × 1']);
  });
  it('shows the service-reported timeout choice and exact resolved timestamp', () => {
    expect(rangerExpired.status).toBe('EXPIRED');
    expect(rangerExpired.resolvedAt).toBe(r.deadlineAt);
    expect(chosenEventLabel(rangerExpired)).toBe(r.choices.find(choice => choice.choiceId === rangerStory.defaultChoiceId)?.label);
    expect(eventChoiceWindowOpen(rangerExpired, NOW)).toBe(false);
  });
  it('only displays gallery link on actual finalized CG unlock, even when already collected', () => {
    expect(hasUnlockedEventArt(rangerExpired)).toBe(true);
    expect(hasUnlockedEventArt(r)).toBe(false);
    expect(hasUnlockedEventArt({ ...r, artState: 'UNAVAILABLE' })).toBe(false);
    expect(hasUnlockedEventArt(starResolved)).toBe(false);
    expect(hasUnlockedEventArt({ ...rangerExpired, rewards: [] })).toBe(false);
    const repeat = eventOccurrenceViewSchema.parse({ ...rangerExpired,
      rewards: [{ kind: 'CG_UNLOCK', cgId: rangerStory.eventId, variant: 'default', newlyUnlocked: false }] });
    expect(hasUnlockedEventArt(repeat)).toBe(true);
    expect(repeat.rewards.map(eventRewardText)[0]).toContain('未重复发放');
  });
  it('formats signed, zero, coin and item ledger rows from the actual supplied amounts', () => {
    expect(eventRewardText({ kind: 'MOOD_DELTA', delta10: -18 })).toBe('心情 -1.8 点');
    expect(eventRewardText({ kind: 'BOND_DELTA', delta10: 0 })).toBe('好感未变化');
    expect(eventRewardText({ kind: 'COIN', amount: 3 })).toBe('游戏金币 +3');
    expect(eventRewardText({ kind: 'ITEM', itemId: 'herb', quantity: 2 })).toBe('herb × 2');
  });
  it('history pages contain actual results only, and cannot create a choice even for old selected IDs', () => {
    const scope: EventListQuery = { filter: 'HISTORY', offset: 0, limit: 2 };
    const history = eventPageSchema.parse({ revision: 9, petId: null, ...scope, pendingTotal: 1, total: 3, rows: [rangerExpired, starResolved] });
    const historyStamp = { ...stamp, query: scope, page: history };
    expect(usableEventPage(historyStamp, GEN, snapshot, scope)).toBe(history);
    expect(eventPageOffset(history, 1)).toBe(2);
    expect(createEventChoiceConfirmation(historyStamp, GEN, snapshot, scope, starResolved.occurrenceId, starChoice, NOW, true)).toBeUndefined();
    expect(eventPageSchema.safeParse({ ...history, rows: [rangerExpired, s] }).success).toBe(false);
  });
  it('once a choice is saved, the old quote cannot submit again even if command status unexpectedly remains visible', () => {
    const mixedQuery: EventListQuery = { ...query, filter: 'ALL' };
    const pendingMixed: StampedEventPage = { ...stamp, query: mixedQuery, page: { ...page, filter: 'ALL' } };
    const old = create(pendingMixed, s, starChoice, GEN, snapshot, mixedQuery)!;
    const newPage: EventPage = { ...pendingMixed.page, rows: [r, starResolved], pendingTotal: 1 };
    expect(confirm(old, { ...pendingMixed, page: newPage }, GEN, snapshot, mixedQuery)).toBeUndefined();
  });
});
