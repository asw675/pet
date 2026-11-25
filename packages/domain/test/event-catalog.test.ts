import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, EVENT_CATALOG_VERSION } from '@pet-desktop/domain/event-catalog';
import { findCharacterDefinition } from '@pet-desktop/domain/character-catalog';
import { findItemDefinition } from '@pet-desktop/domain/item-catalog';
import { findRouteDefinition } from '@pet-desktop/domain/route-catalog';
import { resolveEventOccurrence, selectEvent, validateEventCatalog, validateFrozenOccurrence } from '@pet-desktop/domain/event-engine';
import type {
  EventHistoryEntry, EventSelectionInput, EventTrigger, FrozenEventOccurrence,
} from '@pet-desktop/domain/event-engine';

const DAY = 86_400_000;
const NOW = DAY * 5 + 123;
function selection(
  characterId: string, trigger: EventTrigger,
  extra: Partial<EventSelectionInput> = {},
): EventSelectionInput {
  const petId = `pet-${characterId}`;
  const context = {
    petId, characterId, presence: 'HOME' as const, level: 2, bond10: 200,
    ...(trigger === 'TRIP_RETURNED' ? { routeId: 'morning-dew-meadow', sourceTripId: 'demo-finished-trip' } : {}),
  };
  return { trigger, triggerKey: `${petId}:${trigger}:day-5`, occurrenceId: `occ-${characterId}-${trigger}`,
    seed: 8, at: NOW, chanceBps: 10000, context, history: [], ...extra };
}
function selected(input: EventSelectionInput): FrozenEventOccurrence {
  const result = selectEvent(EVENT_CATALOG, input);
  expect(result.kind).toBe('OCCURRENCE');
  if (result.kind !== 'OCCURRENCE') throw new Error('Expected authored event');
  return result.occurrence;
}
function choice(event: FrozenEventOccurrence, choiceId: string) {
  return resolveEventOccurrence(event, { kind: 'CHOICE', occurrenceId: event.occurrenceId,
    petId: event.petId, choiceId, status: 'PENDING', at: NOW + 100 });
}
function auto(event: FrozenEventOccurrence) {
  return resolveEventOccurrence(event, { kind: 'AUTO', occurrenceId: event.occurrenceId,
    petId: event.petId, status: 'PENDING', at: NOW + 100 });
}

describe('actual built-in event-v1 authored content', () => {
  it('ships six canonical frozen definitions with real heroine/route/item references and no phantom art grant', () => {
    expect(EVENT_CATALOG_VERSION).toBe(1);
    expect(EVENT_CATALOG.map((d) => d.eventId)).toEqual([
      'fluffy-ranger.forest-tea', 'fluffy-ranger.meadow-homecoming', 'nova.field-calibration',
      'nova.workshop-inventory', 'star-singer.shared-constellation', 'star-singer.starlight-notes',
    ]);
    expect(validateEventCatalog(EVENT_CATALOG)).toEqual(EVENT_CATALOG);
    const authoredCharacters = new Set<string>();
    for (const d of EVENT_CATALOG) {
      expect(d.version).toBe(1);
      expect(Object.isFrozen(d)).toBe(true);
      expect(Object.isFrozen(d.conditions)).toBe(true);
      expect(Object.isFrozen(d.narrative)).toBe(true);
      expect(Object.isFrozen(d.choices)).toBe(true);
      expect(d.narrative.title.length).toBeGreaterThan(0);
      expect(d.narrative.text.length).toBeGreaterThan(0);
      for (const condition of d.conditions) {
        if (condition.kind === 'CHARACTER') {
          for (const id of condition.characterIds) {
            expect(findCharacterDefinition(id)).toBeDefined();
            authoredCharacters.add(id);
          }
        } else if (condition.kind === 'ROUTE') {
          for (const id of condition.routeIds) expect(findRouteDefinition(id)).toBeDefined();
        } else if (condition.kind === 'PREREQUISITE') {
          const prerequisite = EVENT_CATALOG.find((other) => other.eventId === condition.eventId);
          expect(prerequisite).toBeDefined();
          if (condition.choiceId) expect(prerequisite!.choices.some(c => c.choiceId === condition.choiceId)).toBe(true);
        }
      }
      for (const effect of [...d.effects, ...d.choices.flatMap((c) => c.effects)]) {
        if (effect.kind === 'ITEM') expect(findItemDefinition(effect.itemId)?.storage).toBe('STACK');
        expect(effect.kind).not.toBe('CG_UNLOCK'); // these new scenes have no pinned art yet
      }
      if (d.asset !== null) expect(d.asset.state).toBe('FUTURE_UNAVAILABLE');
    }
    expect([...authoredCharacters].sort()).toEqual(['fluffy-ranger', 'nova', 'star-singer']);
    expect(JSON.stringify(EVENT_CATALOG)).not.toContain('carefully');
  });

  it.each([
    ['star-singer', 'HOME_DAILY', 'star-singer.starlight-notes'],
    ['fluffy-ranger', 'AFTER_INTERACTION', 'fluffy-ranger.forest-tea'],
    ['nova', 'HOME_DAILY', 'nova.workshop-inventory'],
    ['fluffy-ranger', 'TRIP_RETURNED', 'fluffy-ranger.meadow-homecoming'],
    ['nova', 'TRIP_RETURNED', 'nova.field-calibration'],
  ] as const)('%s %s selects its correct authored scene', (characterId, trigger, eventId) => {
    const event = selected(selection(characterId, trigger));
    expect(event.eventId).toBe(eventId);
    expect(event.characterId).toBe(characterId);
    expect(validateFrozenOccurrence(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('star-singer first story returns distinct meaningful branch effects', () => {
    const story = selected(selection('star-singer', 'HOME_DAILY'));
    expect(story.narrative.title).toBe('星光笔记的空白页');
    expect(story.defaultChoiceId).toBe('share-notes');
    expect(story.deadlineAt).toBe(NOW + DAY);
    expect(choice(story, 'share-notes')).toMatchObject({
      ok: true, status: 'RESOLVED', effects: { moodDelta10: 30, bondDelta10: 15, coins: 0, items: [], cgUnlock: null },
    });
    expect(choice(story, 'study-herbs')).toMatchObject({
      ok: true, effects: { moodDelta10: 10, bondDelta10: 5, items: [{ itemId: 'herb', quantity: 1 }], cgUnlock: null },
    });
  });

  it('star-singer rare follow-up requires its actual predecessor choice, level/bond and same pet', () => {
    const first = selected(selection('star-singer', 'HOME_DAILY'));
    const answer = choice(first, 'share-notes');
    if (!answer.ok || answer.status !== 'RESOLVED') throw new Error('Precondition fixture not resolved');
    const receipt: EventHistoryEntry = {
      occurrenceId: first.occurrenceId, triggerKey: first.triggerKey, petId: first.petId, eventId: first.eventId,
      eventVersion: first.eventVersion, occurredAt: first.occurredAt, status: answer.status,
      resolvedAt: answer.resolvedAt, choiceId: answer.choiceId,
    };
    const next = selection('star-singer', 'BOND_MILESTONE', { at: NOW + 200, history: [receipt] });
    const follow = selected(next);
    expect(follow.eventId).toBe('star-singer.shared-constellation');
    expect(follow.rarity).toBe('RARE');
    expect(follow.asset).toEqual({
      state: 'FUTURE_UNAVAILABLE', characterId: 'star-singer', eventDefId: follow.eventId, cgId: follow.eventId, variant: 'default',
    });
    expect(resolveEventOccurrence(follow, { kind: 'CHOICE', occurrenceId: follow.occurrenceId, petId: follow.petId,
      status: 'PENDING', choiceId: 'name-constellation', at: NOW + 300 })).toMatchObject({
      ok: true, effects: { moodDelta10: 20, bondDelta10: 30, cgUnlock: null },
    });
    for (const edit of [{ petId: 'another-star' }, { choiceId: 'study-herbs' }, { status: 'EXPIRED' as const }]) {
      expect(selectEvent(EVENT_CATALOG, { ...next, history: [{ ...receipt, ...edit }] })).toMatchObject({
        kind: 'NO_EVENT', reason: 'NO_ELIGIBLE', drawCount: 0,
      });
    }
    for (const edit of [{ level: 1 }, { bond10: 199 }]) {
      expect(selectEvent(EVENT_CATALOG, { ...next, context: { ...next.context, ...edit } })).toMatchObject({ kind: 'NO_EVENT', reason: 'NO_ELIGIBLE' });
    }
  });

  it('fluffy-ranger tea time shares mood/bond or distinct real materials', () => {
    const story = selected(selection('fluffy-ranger', 'AFTER_INTERACTION'));
    expect(story.narrative.title).toBe('林地游侠的午后茶会');
    expect(choice(story, 'tea-together')).toMatchObject({ ok: true, effects: { moodDelta10: 40, bondDelta10: 12, items: [] } });
    expect(choice(story, 'prepare-trail')).toMatchObject({ ok: true, effects: { moodDelta10: 0, bondDelta10: 5,
      items: [{ itemId: 'herb', quantity: 2 }] } });
  });

  it('nova workshop provides different verified effects, with explicit default branch', () => {
    const story = selected(selection('nova', 'HOME_DAILY'));
    expect(story.narrative.title).toBe('工坊里的小小清单');
    expect(choice(story, 'polish-tools')).toMatchObject({
      ok: true, effects: { coins: 2, moodDelta10: 25, bondDelta10: 3, items: [], cgUnlock: null },
    });
    expect(choice(story, 'catalog-materials')).toMatchObject({
      ok: true, effects: { moodDelta10: 0, bondDelta10: 10, items: [{ itemId: 'slime-gel', quantity: 1 }] },
    });
    expect(resolveEventOccurrence(story, { kind: 'EXPIRE', occurrenceId: story.occurrenceId, petId: story.petId,
      at: NOW + 2 * DAY, status: 'PENDING' })).toMatchObject({
      ok: true, status: 'EXPIRED', resolvedAt: NOW + DAY, choiceId: 'catalog-materials',
      effects: { bondDelta10: 10, items: [{ itemId: 'slime-gel', quantity: 1 }] },
    });
  });

  it('ranger return story is linked to the exact completed meadow trip, not the currently selected route or future CG', () => {
    const source = selection('fluffy-ranger', 'TRIP_RETURNED');
    const story = selected(source);
    expect(story.routeId).toBe('morning-dew-meadow');
    expect(story.sourceTripId).toBe('demo-finished-trip');
    expect(story.narrative.title).toBe('归家后的草原故事');
    expect(story.asset).toMatchObject({ state: 'FUTURE_UNAVAILABLE', cgId: 'fluffy-ranger.meadow-homecoming' });
    expect(choice(story, 'listen-to-story')).toMatchObject({ ok: true, effects: { bondDelta10: 15, moodDelta10: 30, cgUnlock: null } });
    expect(choice(story, 'save-keepsake')).toMatchObject({ ok: true,
      effects: { moodDelta10: 10, items: [{ itemId: 'herb', quantity: 1 }], cgUnlock: null } });
    expect(selectEvent(EVENT_CATALOG, { ...source, context: { ...source.context, routeId: 'mist-forest' } })).toMatchObject({
      kind: 'NO_EVENT', reason: 'NO_ELIGIBLE',
    });
  });

  it('nova field calibration is automatic, separate from already-settled trip reward records', () => {
    const story = selected(selection('nova', 'TRIP_RETURNED'));
    expect(story.narrative.title).toBe('归家后的例行校准');
    expect(story.sourceTripId).toBe('demo-finished-trip');
    expect(story.deadlineAt).toBeNull();
    expect(story.choices).toEqual([]);
    expect(auto(story)).toMatchObject({ ok: true, status: 'RESOLVED', resolvedAt: NOW, choiceId: null,
      effects: { moodDelta10: 15, items: [{ itemId: 'slime-gel', quantity: 1 }], cgUnlock: null, coins: 0 } });
  });

  it.each([
    ['fluffy-ranger', 'HOME_DAILY'], ['star-singer', 'AFTER_INTERACTION'], ['nova', 'AFTER_INTERACTION'],
  ] as const)('does not borrow another heroine event for %s %s', (characterId, trigger) => {
    expect(selectEvent(EVENT_CATALOG, selection(characterId, trigger))).toMatchObject({ kind: 'NO_EVENT', reason: 'NO_ELIGIBLE', drawCount: 0 });
  });
});
