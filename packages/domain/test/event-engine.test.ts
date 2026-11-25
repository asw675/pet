import { describe, expect, it } from 'vitest';
import { findBuiltinCg } from '@pet-desktop/domain/cg-catalog';
import {
  EVENT_LIMITS, EVENT_OCCURRENCE_SCHEMA_VERSION, EVENT_RULES_VERSION,
  resolveEventOccurrence, selectEvent, validateEventCatalog, validateFrozenOccurrence,
} from '@pet-desktop/domain/event-engine';
import type {
  EventDefinition, EventHistoryEntry, EventResolveRequest, EventSelectionInput, FrozenEventOccurrence,
  PinnedEventAsset,
} from '@pet-desktop/domain/event-engine';

const NOW = 1_000;
const baseDefinition: EventDefinition = {
  eventId: 'quiet-morning', version: 1, trigger: 'HOME_DAILY', conditions: [],
  weight: 1, rarity: 'COMMON', cooldownMs: 0, maxPerPet: 10,
  narrative: { title: '清晨', text: '记录清晨的故事。', actionId: 'idle' },
  effects: [{ kind: 'MOOD_DELTA', delta10: 10 }], choices: [], defaultChoiceId: null, expiresAfterMs: null, asset: null,
};
const definition = (edit: Partial<EventDefinition> = {}): EventDefinition => ({ ...baseDefinition, ...edit });
const baseInput: EventSelectionInput = {
  trigger: 'HOME_DAILY', triggerKey: 'pet-a:daily:2', occurrenceId: 'occ-new', seed: 1, at: NOW, chanceBps: 10_000,
  context: { petId: 'pet-a', characterId: 'star-singer', presence: 'HOME', level: 4, bond10: 200 },
  history: [],
};
const input = (edit: Partial<EventSelectionInput> = {}): EventSelectionInput => ({ ...baseInput, ...edit });
const history = (edit: Partial<EventHistoryEntry> = {}): EventHistoryEntry => ({
  occurrenceId: 'occ-old', triggerKey: 'pet-a:daily:1', petId: 'pet-a', eventId: baseDefinition.eventId,
  eventVersion: 1, occurredAt: 900, status: 'RESOLVED', resolvedAt: 901, choiceId: null, ...edit,
});
const choices = (): EventDefinition => definition({
  effects: [{ kind: 'MOOD_DELTA', delta10: 15 }, { kind: 'ITEM', itemId: 'slime-gel', quantity: 1 }],
  choices: [
    { choiceId: 'together', label: '一起记录', resultText: '妥善记下今日的见闻。',
      effects: [{ kind: 'MOOD_DELTA', delta10: -5 }, { kind: 'BOND_DELTA', delta10: 20 },
        { kind: 'ITEM', itemId: 'herb', quantity: 2 }, { kind: 'ITEM', itemId: 'slime-gel', quantity: 3 }] },
    { choiceId: 'keepsake', label: '收到纪念品', resultText: '收下一份纪念品。',
      effects: [{ kind: 'COIN', amount: 2 }] },
  ],
  defaultChoiceId: 'keepsake', expiresAfterMs: 100,
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function occur(catalog: readonly EventDefinition[] = [definition()], selection = input()): FrozenEventOccurrence {
  const result = selectEvent(catalog, selection);
  expect(result.kind).toBe('OCCURRENCE');
  if (result.kind !== 'OCCURRENCE') throw new Error('Expected event');
  return result.occurrence;
}
function noEvent(catalog: readonly EventDefinition[], selection: EventSelectionInput, reason: string, drawCount = 0) {
  expect(selectEvent(catalog, selection)).toMatchObject({ kind: 'NO_EVENT', reason, drawCount });
}
const request = (kind: 'AUTO' | 'EXPIRE', occurrence: FrozenEventOccurrence, at: number): EventResolveRequest => ({
  kind, occurrenceId: occurrence.occurrenceId, petId: occurrence.petId, status: 'PENDING', at,
});
const choose = (occurrence: FrozenEventOccurrence, choiceId: string, at: number): EventResolveRequest => ({
  kind: 'CHOICE', occurrenceId: occurrence.occurrenceId, petId: occurrence.petId, status: 'PENDING', at, choiceId,
});

describe('deterministic sorted chance and weighted event selection', () => {
  it.each([[1, 'a-event', 67634689], [8, 'z-event', 537014280], [0xffff_ffff, 'z-event', 4228382207]] as const)(
    'seed %d selects %s with golden multiply-high stream independent of input order', (seed, eventId, rngState) => {
      const a = definition({ eventId: 'a-event', weight: 1, rarity: 'LEGENDARY' });
      const z = definition({ eventId: 'z-event', weight: 9, rarity: 'COMMON' });
      const first = selectEvent([z, a], input({ seed }));
      const second = selectEvent([a, z], input({ seed }));
      expect(first).toEqual(second);
      expect(first).toMatchObject({ kind: 'OCCURRENCE', seed, drawCount: 2, rngState, occurrence: { eventId } });
    },
  );

  it('uses one exact chance draw before only-on-success weighted selection at the basis-point boundary', () => {
    // seed 2 -> first xorshift state 540738; multiply-high into 10000 yields 1.
    expect(selectEvent([definition()], input({ seed: 2, chanceBps: 0 }))).toMatchObject({
      kind: 'NO_EVENT', reason: 'CHANCE_MISS', drawCount: 1, rngState: 540738,
    });
    expect(selectEvent([definition()], input({ seed: 2, chanceBps: 1 }))).toMatchObject({
      kind: 'NO_EVENT', reason: 'CHANCE_MISS', drawCount: 1, rngState: 540738,
    });
    expect(selectEvent([definition()], input({ seed: 2, chanceBps: 2 }))).toMatchObject({
      kind: 'OCCURRENCE', drawCount: 2, rngState: 134253570,
    });
  });

  it('draws zero values when zero eligible candidates remain', () => {
    for (const catalog of [[], [definition({ trigger: 'AFTER_INTERACTION' })],
      [definition({ conditions: [{ kind: 'LEVEL_AT_LEAST', level: 5 }] })]]) {
      expect(selectEvent(catalog, input())).toEqual({
        kind: 'NO_EVENT', reason: 'NO_ELIGIBLE', triggerKey: baseInput.triggerKey,
        seed: 1, rngState: 1, drawCount: 0,
      });
    }
  });

  it.each(['AWAY', 'RETURNING'] as const)('does not select a home event when authority presence is %s', (presence) => {
    noEvent([definition()], input({ context: { ...baseInput.context, presence } }), 'TRIGGER_INELIGIBLE');
  });

  it('selects only the newest authored definition revision per ID, not a weight duplicate of old history', () => {
    const old = definition({ version: 1, weight: 999 });
    const latest = definition({ version: 2, weight: 1, narrative: { ...baseDefinition.narrative, title: '新定义' } });
    expect(occur([latest, old])).toMatchObject({ eventVersion: 2, narrative: { title: '新定义' } });
    const latestOtherTrigger = definition({ version: 3, trigger: 'AFTER_INTERACTION' });
    noEvent([old, latest, latestOtherTrigger], input(), 'NO_ELIGIBLE');
  });

  it('frozen definition ordering is canonical, not mutable or duplicated', () => {
    const catalog = validateEventCatalog([
      definition({ eventId: 'z-event' }), definition({ eventId: 'a-event', version: 3 }),
      definition({ eventId: 'a-event', version: 1 }),
    ]);
    expect(catalog.map((event) => [event.eventId, event.version])).toEqual([['a-event', 1], ['a-event', 3], ['z-event', 1]]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(() => validateEventCatalog([definition(), definition()])).toThrow(RangeError);
  });
});

describe('eligibility, history, cooldown, prerequisite, duplicate triggers and pet isolation', () => {
  it('checks level, bond, character and route conjunctively with exact completed-trip provenance', () => {
    const tripDefinition = definition({ trigger: 'TRIP_RETURNED', conditions: [
      { kind: 'CHARACTER', characterIds: ['star-singer'] }, { kind: 'LEVEL_AT_LEAST', level: 4 },
      { kind: 'BOND_AT_LEAST', bond10: 200 }, { kind: 'PRESENCE', presence: 'HOME' }, { kind: 'ROUTE', routeIds: ['mist-forest'] },
    ] });
    const returned = input({ trigger: 'TRIP_RETURNED', context: {
      ...baseInput.context, routeId: 'mist-forest', sourceTripId: 'finished-trip',
    } });
    expect(occur([tripDefinition], returned)).toMatchObject({ routeId: 'mist-forest', sourceTripId: 'finished-trip' });
    for (const edit of [{ characterId: 'nova' }, { level: 3 }, { bond10: 199 }, { routeId: 'starfall-ruins' }]) {
      noEvent([tripDefinition], { ...returned, context: { ...returned.context, ...edit } }, 'NO_ELIGIBLE');
    }
  });

  it('counts cooldown from prior occurrence timestamp at the precise equality boundary', () => {
    const rule = definition({ cooldownMs: 100 });
    noEvent([rule], input({ at: 999, history: [history()] }), 'NO_ELIGIBLE');
    expect(occur([rule], input({ at: 1000, history: [history()] })).occurredAt).toBe(1000);
  });

  it('blocks another instance of a still-pending stable event even with zero cooldown and a revised version', () => {
    const pending = history({ status: 'PENDING', resolvedAt: null });
    noEvent([definition({ version: 2 })], input({ history: [pending] }), 'NO_ELIGIBLE');
  });

  it('counts final and expired occurrences across historical revisions toward maxPerPet', () => {
    const expired = history({ eventVersion: 1, status: 'EXPIRED', choiceId: 'default-old' });
    noEvent([definition({ maxPerPet: 1, version: 3 })], input({ history: [expired] }), 'NO_ELIGIBLE');
  });

  it('does not confuse a pet instance with another instance of the same character', () => {
    const other = history({ petId: 'pet-b', status: 'PENDING', resolvedAt: null });
    expect(occur([definition({ cooldownMs: EVENT_LIMITS.cooldownMs, maxPerPet: 1 })],
      input({ history: [other] })).petId).toBe('pet-a');
  });

  it('requires prerequisite version and selected choice from a resolved occurrence of this pet', () => {
    const dependent = definition({ eventId: 'milestone', conditions: [
      { kind: 'PREREQUISITE', eventId: 'first-notes', eventVersion: 2, choiceId: 'share' },
    ] });
    const right = history({ eventId: 'first-notes', eventVersion: 2, choiceId: 'share' });
    expect(occur([dependent], input({ history: [right] })).eventId).toBe('milestone');
    for (const edit of [{ petId: 'pet-b' }, { eventVersion: 1 }, { choiceId: 'skip' }, { status: 'EXPIRED' as const }]) {
      noEvent([dependent], input({ history: [{ ...right, ...edit }] }), 'NO_ELIGIBLE');
    }
    noEvent([dependent], input({ history: [{ ...right, status: 'PENDING', resolvedAt: null, choiceId: null }] }), 'NO_ELIGIBLE');
  });

  it('rejects an authority-global used trigger receipt without rerolling any seed', () => {
    for (const seed of [1, 5, 0xffff_ffff]) {
      const used = history({ triggerKey: baseInput.triggerKey, petId: 'pet-b' });
      expect(selectEvent([definition()], input({ seed, history: [used] }))).toEqual({
        kind: 'NO_EVENT', reason: 'TRIGGER_ALREADY_SEEN', triggerKey: baseInput.triggerKey, rngState: seed, seed, drawCount: 0,
      });
    }
  });

  it('detects reused occurrence IDs and contradictory duplicate historical identity', () => {
    expect(() => selectEvent([definition()], input({ history: [history({ occurrenceId: baseInput.occurrenceId })] }))).toThrow(RangeError);
    const duplicateId = [history(), history({ triggerKey: 'another-key' })];
    const duplicateKey = [history(), history({ occurrenceId: 'another-id' })];
    for (const records of [duplicateId, duplicateKey]) {
      expect(() => selectEvent([definition()], input({ history: records }))).toThrow(RangeError);
    }
  });

  it.each([
    { trigger: 'TRIP_RETURNED', context: { ...baseInput.context } },
    { trigger: 'TRIP_RETURNED', context: { ...baseInput.context, routeId: 'mist-forest' } },
    { trigger: 'TRIP_RETURNED', context: { ...baseInput.context, sourceTripId: 'trip-a' } },
    { trigger: 'HOME_DAILY', context: { ...baseInput.context, routeId: 'mist-forest' } },
    { trigger: 'AFTER_INTERACTION', context: { ...baseInput.context, sourceTripId: 'trip-a' } },
  ])('fails closed when selection trigger provenance is missing or attached to unrelated trigger: %s', (bad) => {
    expect(() => selectEvent([definition()], { ...baseInput, ...bad } as EventSelectionInput)).toThrow(/provenance/);
  });
});

describe('immutable event occurrences, resolution and exclusive deadlines', () => {
  it('copies and deep-freezes narrative, common effects, choices and independent persisted snapshots', () => {
    const authored = clone(choices());
    const selected = occur([authored]);
    const serialized = JSON.stringify(selected);
    (authored.narrative as { text: string }).text = 'mutated';
    (authored.choices[0] as { resultText: string }).resultText = 'wrong';
    expect(JSON.stringify(selected)).toBe(serialized);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.narrative)).toBe(true);
    expect(Object.isFrozen(selected.effects)).toBe(true);
    expect(Object.isFrozen(selected.effects[0])).toBe(true);
    expect(Object.isFrozen(selected.choices)).toBe(true);
    expect(Object.isFrozen(selected.choices[0])).toBe(true);
    expect(Object.isFrozen(selected.choices[0]!.effects)).toBe(true);
    expect(selected.schemaVersion).toBe(EVENT_OCCURRENCE_SCHEMA_VERSION);
    expect(selected.rulesVersion).toBe(EVENT_RULES_VERSION);
    const detached = validateFrozenOccurrence(clone(selected));
    expect(detached).toEqual(selected);
    expect(detached).not.toBe(selected);
    // The persisted instance's branch still resolves with original content,
    // regardless of any later catalog changes.
    expect(resolveEventOccurrence(detached, choose(detached, 'together', 1050))).toMatchObject({
      ok: true, resultText: '妥善记下今日的见闻。', resolvedAt: 1050,
      effects: { moodDelta10: 10, bondDelta10: 20, coins: 0,
        items: [{ itemId: 'herb', quantity: 2 }, { itemId: 'slime-gel', quantity: 4 }], cgUnlock: null },
    });
  });

  it('automatic events finalize at logical occurrence time even after an offline resume', () => {
    const occurrence = occur();
    expect(resolveEventOccurrence(occurrence, request('AUTO', occurrence, NOW + 10_000))).toEqual({
      ok: true, occurrenceId: occurrence.occurrenceId, status: 'RESOLVED', choiceId: null,
      resultText: occurrence.narrative.text, resolvedAt: NOW,
      effects: { moodDelta10: 10, bondDelta10: 0, coins: 0, items: [], cgUnlock: null },
    });
    expect(resolveEventOccurrence(occurrence, choose(occurrence, 'fake-choice', NOW))).toEqual({ ok: false, reason: 'NO_CHOICES' });
    expect(resolveEventOccurrence(occurrence, request('EXPIRE', occurrence, NOW))).toEqual({ ok: false, reason: 'NO_CHOICES' });
  });

  it('requires the exact occurrence and pet identity, pending status and nondecreasing occurrence time', () => {
    const occurrence = occur([choices()]);
    const correct = choose(occurrence, 'together', NOW);
    expect(resolveEventOccurrence(occurrence, { ...correct, occurrenceId: 'another-occ' })).toEqual({ ok: false, reason: 'IDENTITY_MISMATCH' });
    expect(resolveEventOccurrence(occurrence, { ...correct, petId: 'another-pet' })).toEqual({ ok: false, reason: 'IDENTITY_MISMATCH' });
    for (const status of ['RESOLVED', 'EXPIRED'] as const) {
      expect(resolveEventOccurrence(occurrence, { ...correct, status })).toEqual({ ok: false, reason: 'ALREADY_FINAL' });
    }
    expect(resolveEventOccurrence(occurrence, { ...correct, at: NOW - 1 })).toEqual({ ok: false, reason: 'NOT_YET_CREATED' });
  });

  it('requires a known branch selection and never accepts AUTO to bypass a pending choice', () => {
    const occurrence = occur([choices()]);
    expect(resolveEventOccurrence(occurrence, request('AUTO', occurrence, NOW))).toEqual({ ok: false, reason: 'CHOICE_REQUIRED' });
    expect(resolveEventOccurrence(occurrence, choose(occurrence, 'not-authored', NOW))).toEqual({ ok: false, reason: 'UNKNOWN_CHOICE' });
  });

  it('permits deadline-1 but denies deadline and every late choice even while stored status is PENDING', () => {
    const occurrence = occur([choices()]);
    expect(occurrence.deadlineAt).toBe(1100);
    expect(resolveEventOccurrence(occurrence, choose(occurrence, 'together', 1099))).toMatchObject({ ok: true, status: 'RESOLVED' });
    for (const at of [1100, 1101, 20_000]) {
      expect(resolveEventOccurrence(occurrence, choose(occurrence, 'together', at))).toEqual({ ok: false, reason: 'DEADLINE_PASSED' });
    }
  });

  it('default expiry is not due before deadline and commits only the frozen default at scheduled time', () => {
    const occurrence = occur([choices()]);
    expect(resolveEventOccurrence(occurrence, request('EXPIRE', occurrence, 1099))).toEqual({ ok: false, reason: 'NOT_DUE' });
    for (const wake of [1100, 86000]) {
      expect(resolveEventOccurrence(clone(occurrence), request('EXPIRE', occurrence, wake))).toEqual({
        ok: true, occurrenceId: occurrence.occurrenceId, status: 'EXPIRED', choiceId: 'keepsake',
        resultText: '收下一份纪念品。', resolvedAt: 1100,
        effects: { moodDelta10: 15, bondDelta10: 0, coins: 2, items: [{ itemId: 'slime-gel', quantity: 1 }], cgUnlock: null },
      });
    }
  });

  it('rejects frozen occurrences with unsupported schema/rules, malformed deadlines or unknown fields', () => {
    const occurrence = occur([choices()]);
    for (const edit of [
      { schemaVersion: 2 }, { rulesVersion: 'event-v2' }, { deadlineAt: NOW }, { deadlineAt: NOW + EVENT_LIMITS.expiryMs + 1 },
      { defaultChoiceId: 'unknown' }, { untrustedEffect: 'grant' },
    ]) expect(() => validateFrozenOccurrence({ ...occurrence, ...edit })).toThrow(RangeError);
  });

  it('requires both trip fields on persisted TRIP_RETURNED and neither on other persisted triggers', () => {
    const occurrence = occur([definition({ trigger: 'TRIP_RETURNED' })], input({
      trigger: 'TRIP_RETURNED', context: { ...baseInput.context, routeId: 'mist-forest', sourceTripId: 'trip-a' },
    }));
    expect(validateFrozenOccurrence(clone(occurrence))).toEqual(occurrence);
    for (const edit of [{ routeId: null }, { sourceTripId: null }, { trigger: 'HOME_DAILY' }]) {
      expect(() => validateFrozenOccurrence({ ...occurrence, ...edit })).toThrow(/provenance/);
    }
    const ordinary = occur();
    for (const edit of [{ routeId: 'mist-forest' }, { sourceTripId: 'trip-a' }]) {
      expect(() => validateFrozenOccurrence({ ...ordinary, ...edit })).toThrow(/provenance/);
    }
  });

  it('fails before a choice deadline can overflow a safe integer timestamp', () => {
    expect(() => occur([choices()], input({ at: Number.MAX_SAFE_INTEGER - 10 }))).toThrow(/deadline overflow/);
  });
});

function realPinnedCg(): PinnedEventAsset {
  const actual = findBuiltinCg('star-singer', 'morning-dew', 'default', '1.0.0');
  if (!actual) throw new Error('Existing versioned demo CG missing');
  return {
    state: 'PINNED', characterId: actual.characterId, eventDefId: actual.eventDefId,
    cgId: actual.cgId, variant: actual.variant, assetVersion: actual.assetVersion, assetHash: actual.assetHash,
  };
}
function pinnedDefinition(): EventDefinition {
  // A test-only example using a genuinely existing, hash-pinned CG. This
  // does not add another production grant of the existing trip CG.
  const asset = realPinnedCg();
  return definition({ eventId: asset.eventDefId, conditions: [{ kind: 'CHARACTER', characterIds: [asset.characterId] }],
    effects: [{ kind: 'CG_UNLOCK' }], asset });
}

describe('strict closed effects, bounded authoring, and historical CG identity', () => {
  it('keeps the actual exact version/hash in the frozen CG and effect draft', () => {
    const assets = realPinnedCg();
    const occurrence = occur([pinnedDefinition()]);
    expect(occurrence.asset).toEqual(assets);
    expect(Object.isFrozen(occurrence.asset)).toBe(true);
    const reloaded = validateFrozenOccurrence(clone(occurrence));
    expect(resolveEventOccurrence(reloaded, request('AUTO', reloaded, NOW))).toMatchObject({
      ok: true, effects: { cgUnlock: assets },
    });
    noEvent([pinnedDefinition()], input({ context: { ...baseInput.context, characterId: 'nova' } }), 'NO_ELIGIBLE');
  });

  it('retains explicit future-unavailable content as a non-unlock marker, even if a later resolver might gain art', () => {
    const pending = { state: 'FUTURE_UNAVAILABLE' as const, characterId: 'star-singer',
      eventDefId: baseDefinition.eventId, cgId: 'future-story', variant: 'default' };
    const f = definition({ conditions: [{ kind: 'CHARACTER', characterIds: ['star-singer'] }], asset: pending });
    const occurrence = occur([f]);
    expect(occurrence.asset).toEqual(pending);
    expect(resolveEventOccurrence(clone(occurrence), request('AUTO', occurrence, NOW))).toMatchObject({ ok: true, effects: { cgUnlock: null } });
    expect(() => validateEventCatalog([{ ...f, effects: [{ kind: 'CG_UNLOCK' }] }])).toThrow(RangeError);
    expect(() => validateEventCatalog([{ ...f, asset: { ...pending, assetVersion: '1.0.0', assetHash: 'a'.repeat(64) } }])).toThrow(RangeError);
  });

  it.each([
    [{ kind: 'GRANT_XP', amount: 10 }],
    [{ kind: 'COIN', amount: 0 }],
    [{ kind: 'COIN', amount: EVENT_LIMITS.coins + 1 }],
    [{ kind: 'ITEM', itemId: 'bad item', quantity: 1 }],
    [{ kind: 'ITEM', itemId: 'herb', quantity: 0 }],
    [{ kind: 'ITEM', itemId: 'herb', quantity: 101 }],
    [{ kind: 'ITEM', itemId: 'herb', quantity: 1, filePath: '/tmp/invented' }],
    [{ kind: 'MOOD_DELTA', delta10: 0 }],
    [{ kind: 'BOND_DELTA', delta10: -201 }],
    [{ kind: 'MOOD_DELTA', delta10: 100 }, { kind: 'MOOD_DELTA', delta10: -101 }],
    [{ kind: 'ITEM', itemId: 'herb', quantity: 80 }, { kind: 'ITEM', itemId: 'herb', quantity: 21 }],
    [{ kind: 'COIN', amount: 500 }, { kind: 'COIN', amount: 501 }],
    [{ kind: 'CG_UNLOCK' }],
  ].map((effects) => ({ effects })))('rejects invalid/unknown effect or combined budget $effects', ({ effects }) => {
    expect(() => validateEventCatalog([{ ...definition(), effects }])).toThrow(RangeError);
  });

  it('rejects repeated CG unlock effects and invalid asset identities', () => {
    const valid = pinnedDefinition();
    const asset = valid.asset!;
    for (const edit of [
      { effects: [{ kind: 'CG_UNLOCK' }, { kind: 'CG_UNLOCK' }] },
      { asset: { ...asset, assetHash: 'abc' } }, { asset: { ...asset, assetVersion: 'latest' } },
      { asset: { ...asset, eventDefId: 'unrelated-event' } }, { asset: { ...asset, characterId: 'nova' } },
      { conditions: [] }, { conditions: [{ kind: 'CHARACTER', characterIds: ['star-singer', 'nova'] }] },
    ]) expect(() => validateEventCatalog([{ ...valid, ...edit }])).toThrow(RangeError);
    const occurrence = occur([valid]);
    expect(() => validateFrozenOccurrence({ ...occurrence, asset: { ...asset, characterId: 'nova' } })).toThrow(RangeError);
  });

  it('rejects malformed conditions, out-of-bounds weights/versions and self-prerequisites', () => {
    for (const edit of [
      { weight: 0 }, { weight: EVENT_LIMITS.weight + 1 }, { version: 0 }, { maxPerPet: 0 },
      { cooldownMs: EVENT_LIMITS.cooldownMs + 1 }, { trigger: 'SOME_TRIGGER' },
      { conditions: [{ kind: 'ROUTE', routeIds: ['mist-forest'] }] },
      { conditions: [{ kind: 'PREREQUISITE', eventId: baseDefinition.eventId }] },
      { conditions: [{ kind: 'CHARACTER', characterIds: ['nova', 'nova'] }] },
      { conditions: [{ kind: 'BOND_AT_LEAST', bond10: 1001 }] },
      { conditions: [{ kind: 'UNKNOWN' }] },
    ]) expect(() => validateEventCatalog([{ ...definition(), ...edit }])).toThrow(RangeError);
  });

  it('rejects branches without a valid default/deadline and combined common+branch effect overflow', () => {
    const valid = choices();
    for (const edit of [
      { choices: valid.choices.slice(0, 1) }, { choices: [valid.choices[0], valid.choices[0]] },
      { defaultChoiceId: null }, { defaultChoiceId: 'unknown' }, { expiresAfterMs: null }, { expiresAfterMs: 0 },
      { expiresAfterMs: EVENT_LIMITS.expiryMs + 1 },
      { effects: [{ kind: 'MOOD_DELTA', delta10: 200 }] },
    ]) expect(() => validateEventCatalog([{ ...valid, ...edit }])).toThrow(RangeError);
    for (const edit of [{ defaultChoiceId: 'not-auto' }, { expiresAfterMs: 1 }]) {
      expect(() => validateEventCatalog([{ ...definition(), ...edit }])).toThrow(RangeError);
    }
  });
});
