import { describe, expect, it } from 'vitest';
import {
  advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE, drawRandomInt,
  getTripDurationMs, MAX_TRIP_FACTS, MAX_TRIP_NODES, nextRandomUint32, recallTrip,
  TRIP_RULES_VERSION,
} from '../src/index.js';
import type { RouteDefinition, RouteNode, TripCheckpoint, TripFact, TripSnapshot } from '../src/index.js';

const MINUTE = 60_000;
const START = 1_000;
const OFFLINE_72H = 72 * 60 * MINUTE;

function trip(seed = 8, startAt = START): TripSnapshot {
  return createTripSnapshot({ tripId: 'trip-1', petId: 'pet-a', startAt, seed, power: 20, route: DEMO_ROUTE });
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('V1 deterministic PRNG', () => {
  it('matches xorshift32 golden draws and consumes one draw per sample', () => {
    let state = 1;
    const draws = Array.from({ length: 5 }, () => state = nextRandomUint32(state));
    expect(draws).toEqual([270369, 67634689, 2647435461, 307599695, 2398689233]);
    expect(drawRandomInt(1, 10_000)).toEqual({ state: 270369, value: 369 });
  });
  it('stays in unsigned and exclusive sample ranges with valid nonzero state', () => {
    let state = 0xffff_ffff;
    for (let i = 0; i < 1_000; i++) {
      for (const bound of [1, 3, 10_000, 0x1_0000_0000]) {
        const sample = drawRandomInt(state, bound);
        expect(sample.value).toBeGreaterThanOrEqual(0);
        expect(sample.value).toBeLessThan(bound);
        expect(sample.state).toBeGreaterThan(0);
        expect(sample.state).toBeLessThanOrEqual(0xffff_ffff);
        expect(Number.isInteger(sample.value)).toBe(true);
        state = sample.state;
      }
    }
  });
  it('rejects invalid seeds and bounds', () => {
    for (const state of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(() => nextRandomUint32(state)).toThrow(RangeError);
      expect(() => trip(state)).toThrow(RangeError);
    }
    for (const bound of [0, -1, NaN, 1.5, 0x1_0000_0001]) {
      expect(() => drawRandomInt(1, bound)).toThrow(RangeError);
    }
  });
});

describe('V1 trip snapshots and checkpoints', () => {
  it('freezes inputs by value, including nested drop rules and content identity', () => {
    const drop = { itemId: 'drop', quantity: 1, chanceBps: 1_000 };
    const nodes: RouteNode[] = [
      { kind: 'GATHER', nodeId: 'g', durationMs: 1, itemId: 'herb', minQuantity: 1, maxQuantity: 2, xp: 1 },
      { kind: 'BATTLE', nodeId: 'b', durationMs: 2, enemyId: 'slime', enemyPower: 2,
        winXp: 4, winCoins: 1, lossXp: 1, drop },
    ];
    const route = { routeId: 'mutable', contentVersion: 1, nodes, returnDurationMs: 5 };
    const input = { tripId: 'frozen', petId: 'pet', startAt: 10, seed: 2, power: 10, route };
    const snapshot = createTripSnapshot(input);
    const before = JSON.stringify(snapshot);
    drop.quantity = 999;
    nodes.reverse();
    input.power = 1;
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(snapshot.expectedReturnAt).toBe(18);
    expect(snapshot.rulesVersion).toBe(TRIP_RULES_VERSION);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes[1])).toBe(true);
    expect(jsonRoundTrip(snapshot)).toEqual(snapshot);
    const secondNode = snapshot.nodes[1];
    if (secondNode?.kind !== 'BATTLE') throw new Error('Unexpected fixture');
    expect(Object.isFrozen(secondNode.drop)).toBe(true);
  });
  it('refuses unknown rule versions, altered route content, impossible times and mismatched checkpoints', () => {
    const s = trip();
    const cp = createTripCheckpoint(s);
    expect(() => advanceTrip({ ...s, rulesVersion: 'future' } as unknown as TripSnapshot, cp, START)).toThrow(/rules version/);
    expect(() => advanceTrip({ ...s, contentVersion: 2 }, cp, START)).toThrow(/frozen/);
    expect(() => createTripCheckpoint({ ...s, startAt: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
    expect(() => advanceTrip(s, { ...cp, tripId: 'other' }, START)).toThrow(/another trip/);
    expect(() => advanceTrip(s, { ...cp, rewardDraft: { ...cp.rewardDraft, xp: 1 } }, START)).toThrow(RangeError);
    expect(() => advanceTrip(s, cp, NaN)).toThrow(RangeError);
  });
  it('rejects corrupt random cursor, reward draft or return facts after JSON rehydration', () => {
    const s = trip();
    const partial = jsonRoundTrip(advanceTrip(s, createTripCheckpoint(s), START + 3 * MINUTE).checkpoint);
    expect(() => advanceTrip(s, { ...partial, rngState: 1 }, START + 4 * MINUTE)).toThrow(/random state/);
    expect(() => advanceTrip(s, { ...partial, drawCount: 0 }, START + 4 * MINUTE)).toThrow(/draw count/);
    for (const xp of [-1, 1.5, 1_000_001, NaN, Infinity]) {
      expect(() => advanceTrip(s, { ...partial, rewardDraft: { ...partial.rewardDraft, xp } }, START + 4 * MINUTE)).toThrow(RangeError);
    }
    const returning = jsonRoundTrip(advanceTrip(s, partial, START + 12 * MINUTE).checkpoint);
    const items = returning.rewardDraft.items;
    for (const invalidItems of [[...items, items[0]!], [...items].reverse(), [{ itemId: 'herb', quantity: 0 }]]) {
      expect(() => advanceTrip(s, { ...returning, rewardDraft: { ...returning.rewardDraft, items: invalidItems } }, START + 13 * MINUTE)).toThrow(RangeError);
    }
    expect(() => advanceTrip(s, { ...returning, returnReason: 'DEFEATED' }, START + 13 * MINUTE)).toThrow(RangeError);
    const recall = recallTrip(s, partial, START + 4 * MINUTE).checkpoint;
    expect(() => advanceTrip(s, { ...recall, returnReason: 'COMPLETED' }, START + 5 * MINUTE)).toThrow(RangeError);
    expect(() => advanceTrip(s, { ...recall, logicalTime: START + 8 * MINUTE, nextDueAt: START + 11 * MINUTE }, START + 8 * MINUTE)).toThrow(/skip a due node/);
    expect(() => advanceTrip(s, { ...recall, logicalTime: START + 3 * MINUTE }, START + 5 * MINUTE)).toThrow(/precede departure/);
  });
  it('ensures stable ASCII identifiers including space for event sequence suffix', () => {
    const s = trip();
    for (const tripId of ['unicode-宠', 'with space', '.bad', 't'.repeat(126)]) {
      expect(() => createTripSnapshot({ ...s, tripId, route: DEMO_ROUTE })).toThrow(RangeError);
    }
    const longestId = 't'.repeat(125);
    const longest = createTripSnapshot({ ...s, tripId: longestId, route: DEMO_ROUTE });
    const done = advanceTrip(longest, createTripCheckpoint(longest), START + OFFLINE_72H);
    expect(done.facts.every((fact) => fact.eventId.length <= 128)).toBe(true);
    expect(() => createTripSnapshot({ ...s, petId: 'p'.repeat(129), route: DEMO_ROUTE })).toThrow(RangeError);
  });
});

describe('V1 discrete trip simulation', () => {
  it('matches a stable success, drop and CG golden fixture at planned event times', () => {
    const s = trip();
    expect(getTripDurationMs(DEMO_ROUTE)).toBe(15 * MINUTE);
    const initial = createTripCheckpoint(s);
    const original = JSON.stringify(initial);
    const result = advanceTrip(s, initial, START + OFFLINE_72H);
    expect(JSON.stringify(initial)).toBe(original);
    expect(result.status).toBe('SETTLED');
    expect(result.presence).toBe('HOME');
    expect(result.checkpoint).toMatchObject({ phase: 'COMPLETE', rngState: 2397225082, drawCount: 4,
      sequence: 5, nodeIndex: 3, logicalTime: START + 15 * MINUTE, nextDueAt: null,
      actualReturnedAt: START + 15 * MINUTE, returnReason: 'COMPLETED' });
    expect(result.facts.map((fact) => [fact.eventId, fact.type, fact.scheduledAt])).toEqual([
      ['trip-1:1', 'GATHER_RESOLVED', START + 3 * MINUTE],
      ['trip-1:2', 'BATTLE_RESOLVED', START + 8 * MINUTE],
      ['trip-1:3', 'EVENT_RESOLVED', START + 12 * MINUTE],
      ['trip-1:4', 'RETURNING', START + 12 * MINUTE],
      ['trip-1:5', 'TRIP_RETURNED', START + 15 * MINUTE],
    ]);
    expect(result.rewardDraft).toEqual({ xp: 24, coins: 8,
      items: [{ itemId: 'herb', quantity: 1 }, { itemId: 'slime-gel', quantity: 1 }], cgIds: ['morning-dew'] });
  });
  it('matches defeat golden fixture and awards only completed nodes before retreat', () => {
    const s = trip(3);
    const result = advanceTrip(s, createTripCheckpoint(s), START + OFFLINE_72H);
    expect(result.checkpoint).toMatchObject({ returnReason: 'DEFEATED', actualReturnedAt: START + 11 * MINUTE,
      nodeIndex: 2, drawCount: 3, rngState: 3025432647 });
    expect(result.rewardDraft).toEqual({ xp: 9, coins: 0, items: [{ itemId: 'herb', quantity: 1 }], cgIds: [] });
    expect(result.facts.map((fact) => fact.type)).toEqual(['GATHER_RESOLVED', 'BATTLE_RESOLVED', 'RETURNING', 'TRIP_RETURNED']);
  });
  it('produces identical full and segmented/restarted results for 100 seeds over 72h and midnight', () => {
    const crossedDay = Date.UTC(2026, 10, 25, 23, 58);
    for (let seed = 1; seed <= 100; seed++) {
      const snapshot = trip(seed, crossedDay);
      const initial = createTripCheckpoint(snapshot);
      const expected = advanceTrip(snapshot, initial, crossedDay + OFFLINE_72H);
      let checkpoint: TripCheckpoint = initial;
      const allFacts: TripFact[] = [];
      for (const offset of [0, MINUTE, 3 * MINUTE, 5 * MINUTE, 8 * MINUTE,
        10 * MINUTE, 12 * MINUTE, 15 * MINUTE, OFFLINE_72H]) {
        const segment = advanceTrip(jsonRoundTrip(snapshot), jsonRoundTrip(checkpoint), crossedDay + offset);
        checkpoint = segment.checkpoint;
        allFacts.push(...segment.facts);
      }
      expect(checkpoint).toEqual(expected.checkpoint);
      expect(allFacts).toEqual(expected.facts);
      expect(checkpoint.rewardDraft).toEqual(expected.rewardDraft);
    }
  });
  it('does not rewind logical time or reissue facts after clock rollback and completion', () => {
    const s = trip();
    const first = advanceTrip(s, createTripCheckpoint(s), START + 5 * MINUTE);
    const backwards = advanceTrip(s, first.checkpoint, START + MINUTE);
    expect(backwards.facts).toEqual([]);
    expect(backwards.checkpoint).toEqual(first.checkpoint);
    const same = advanceTrip(s, backwards.checkpoint, START + 5 * MINUTE);
    expect(same.facts).toEqual([]);
    const done = advanceTrip(s, same.checkpoint, START + OFFLINE_72H);
    for (const target of [START, START + 15 * MINUTE, START + 2 * OFFLINE_72H]) {
      const duplicate = advanceTrip(s, done.checkpoint, target);
      expect(duplicate.facts).toEqual([]);
      expect(duplicate.checkpoint).toEqual(done.checkpoint);
    }
  });
  it('processes simultaneous due nodes before recall and settles no unresolved nodes', () => {
    const s = trip();
    const recalled = recallTrip(s, createTripCheckpoint(s), START + 3 * MINUTE);
    expect(recalled.status).toBe('TRAVELING');
    expect(recalled.presence).toBe('RETURNING');
    expect(recalled.facts.map((fact) => fact.type)).toEqual(['GATHER_RESOLVED', 'RETURNING']);
    expect(recalled.checkpoint).toMatchObject({ returnReason: 'RECALLED', nextDueAt: START + 6 * MINUTE,
      nodeIndex: 1, drawCount: 1 });
    const repeated = recallTrip(s, recalled.checkpoint, START + 4 * MINUTE);
    expect(repeated.facts).toEqual([]);
    expect(repeated.checkpoint.nextDueAt).toBe(recalled.checkpoint.nextDueAt);
    const arrived = advanceTrip(s, jsonRoundTrip(repeated.checkpoint), START + OFFLINE_72H);
    expect(arrived.rewardDraft).toEqual({ xp: 4, coins: 0, items: [{ itemId: 'herb', quantity: 1 }], cgIds: [] });
    expect(arrived.checkpoint.actualReturnedAt).toBe(START + 6 * MINUTE);
    expect(arrived.facts.map((fact) => fact.type)).toEqual(['TRIP_RETURNED']);
    expect(recallTrip(s, arrived.checkpoint, START + 2 * OFFLINE_72H).facts).toEqual([]);
  });
  it('clamps a recall request made after a system clock rollback to the prior logical watermark', () => {
    const s = trip();
    const advanced = advanceTrip(s, createTripCheckpoint(s), START + 2 * MINUTE);
    const recalled = recallTrip(s, advanced.checkpoint, START + MINUTE);
    expect(recalled.checkpoint.logicalTime).toBe(START + 2 * MINUTE);
    expect(recalled.checkpoint.nextDueAt).toBe(START + 5 * MINUTE);
    expect(recalled.facts[0]?.scheduledAt).toBe(START + 2 * MINUTE);
  });
  it('bounds event production and merges same-target reward quantities exactly', () => {
    const route: RouteDefinition = { routeId: 'max-route', contentVersion: 1, returnDurationMs: 10,
      nodes: Array.from({ length: MAX_TRIP_NODES }, (_, i) => ({ kind: 'GATHER', nodeId: `g-${i}`,
        durationMs: 10, itemId: 'herb', minQuantity: 2, maxQuantity: 2, xp: 1 })) };
    const s = createTripSnapshot({ tripId: 'bounded', petId: 'pet-a', startAt: START, seed: 1, power: 1, route });
    const done = advanceTrip(s, createTripCheckpoint(s), Number.MAX_SAFE_INTEGER);
    expect(done.facts.length).toBe(MAX_TRIP_FACTS);
    expect(done.rewardDraft).toEqual({ xp: MAX_TRIP_NODES, coins: 0,
      items: [{ itemId: 'herb', quantity: 2 * MAX_TRIP_NODES }], cgIds: [] });
    expect(() => getTripDurationMs({ ...route, nodes: [...route.nodes, route.nodes[0]!] })).toThrow(RangeError);
  });
  it('isolates independent pets without sharing random state, facts or drafts', () => {
    const first = trip();
    const second = createTripSnapshot({ ...first, tripId: 'trip-2', petId: 'pet-b', route: DEMO_ROUTE });
    const cp1 = createTripCheckpoint(first);
    const cp2 = createTripCheckpoint(second);
    const result1 = advanceTrip(first, cp1, START + OFFLINE_72H);
    const result2 = advanceTrip(second, cp2, START + OFFLINE_72H);
    expect(result2.rewardDraft).toEqual(result1.rewardDraft);
    expect(result2.facts[0]?.eventId).toBe('trip-2:1');
    expect(result2.facts.every((fact) => fact.petId === 'pet-b')).toBe(true);
    expect(() => advanceTrip(second, cp1, START)).toThrow(/another trip/);
  });
});
