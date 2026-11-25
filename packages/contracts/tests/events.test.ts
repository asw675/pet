import { describe, expect, it } from 'vitest';
import { eventChoosePayloadSchema, eventOccurrenceViewSchema, eventPageSchema, eventListQuerySchema } from '../src/events.js';
import type { EventOccurrenceView } from '../src/events.js';
const pending = { occurrenceId: 'ev-1', petId: 'pet-1', characterId: 'star-singer', eventId: 'star-singer.shared-constellation', eventVersion: 1,
  trigger: 'BOND_MILESTONE', sourceTripId: null, routeId: null, occurredAt: 100, rarity: 'RARE', title: '星图', narrative: '一起确认星图。', actionId: 'happy',
  choices: [{ choiceId: 'name', label: '命名星座' }, { choiceId: 'save', label: '留作纪念' }], deadlineAt: 200,
  artState: 'LOCKED', status: 'PENDING', resolvedAt: null, selectedChoiceId: null, resultText: null, rewards: [],
} satisfies EventOccurrenceView;
const resolved = { ...pending, status: 'RESOLVED', resolvedAt: 150, selectedChoiceId: 'name', resultText: '新的星光约定。', artState: 'UNLOCKED',
  rewards: [{ kind: 'BOND_DELTA', delta10: 15 }, { kind: 'CG_UNLOCK', cgId: 'star-singer.shared-constellation', variant: 'default', newlyUnlocked: true }],
} satisfies EventOccurrenceView;
describe('event occurrence projection', () => {
  it('accepts frozen pending and resolved history, without exposing seed/trigger key/draft', () => {
    expect(eventOccurrenceViewSchema.parse(pending)).toEqual(pending);
    expect(eventOccurrenceViewSchema.parse(resolved)).toEqual(resolved);
    for (const change of [{ seed: 42 }, { triggerKey: 'daily' }, { effects: [{ kind: 'COIN', amount: 7 }] }, { assetHash: 'example' }]) expect(eventOccurrenceViewSchema.safeParse({ ...pending, ...change }).success).toBe(false);
  });
  it('rejects mismatched provenance and requires actual trip identity on arrival', () => {
    for (const change of [{ trigger: 'TRIP_RETURNED' }, { sourceTripId: 'trip-1' }, { routeId: 'route' }, { trigger: 'TRIP_RETURNED', sourceTripId: 'trip-1' }]) expect(eventOccurrenceViewSchema.safeParse({ ...pending, ...change }).success).toBe(false);
    expect(eventOccurrenceViewSchema.safeParse({ ...pending, trigger: 'TRIP_RETURNED', sourceTripId: 'trip-1', routeId: 'route' }).success).toBe(true);
  });
  it('pending cannot claim paid rewards, CG unlocks, selected option or duplicate choices', () => {
    for (const change of [{ rewards: [{ kind: 'COIN', amount: 1 }] }, { artState: 'UNLOCKED' }, { selectedChoiceId: 'name' },
      { resolvedAt: 150 }, { deadlineAt: 100 }, { choices: [] }, { choices: [pending.choices[0], pending.choices[0]] }]) expect(eventOccurrenceViewSchema.safeParse({ ...pending, ...change }).success).toBe(false);
  });
  it('resolved history respects deadline, actual branch, unique ledger effects and real art', () => {
    expect(eventOccurrenceViewSchema.safeParse({ ...resolved, status: 'EXPIRED', resolvedAt: 200 }).success).toBe(true);
    for (const change of [{ selectedChoiceId: 'fake' }, { selectedChoiceId: null }, { resolvedAt: 200 }, { status: 'EXPIRED' },
      { artState: 'UNAVAILABLE' }, { rewards: [] }, { rewards: [...resolved.rewards, resolved.rewards[0]] }]) expect(eventOccurrenceViewSchema.safeParse({ ...resolved, ...change }).success).toBe(false);
    expect(eventOccurrenceViewSchema.safeParse({ ...resolved, choices: [], deadlineAt: null, selectedChoiceId: null, resolvedAt: 100 }).success).toBe(true);
  });
  it('paginates exact counts, scope, filters and order; choice command is closed', () => {
    const page = { revision: 5, petId: 'pet-1', filter: 'PENDING', pendingTotal: 1, total: 1, offset: 0, limit: 10, rows: [pending] };
    expect(eventPageSchema.parse(page)).toEqual(page);
    for (const change of [{ pendingTotal: 0 }, { rows: [resolved] }, { total: 3 }, { petId: 'other' }, { filter: 'HISTORY' }]) expect(eventPageSchema.safeParse({ ...page, ...change }).success).toBe(false);
    expect(eventPageSchema.safeParse({ ...page, filter: 'ALL', total: 2, rows: [pending, { ...resolved, occurrenceId: 'ev-2' }] }).success).toBe(true);
    expect(eventPageSchema.safeParse({ ...page, filter: 'ALL', total: 2, rows: [{ ...resolved, occurrenceId: 'ev-2' }, pending] }).success).toBe(false);
    expect(eventListQuerySchema.safeParse({ filter: 'ALL', offset: 0, limit: 31 }).success).toBe(false);
    const select = { petId: 'pet-1', occurrenceId: 'ev-1', choiceId: 'name' };
    expect(eventChoosePayloadSchema.safeParse(select).success).toBe(true);
    expect(eventChoosePayloadSchema.safeParse({ ...select, coins: 100, at: 150 }).success).toBe(false);
  });
});
