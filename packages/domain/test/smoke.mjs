// Runs directly with Node strip-types, without installing test dependencies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceTrip, createTripCheckpoint, createTripSnapshot, DEMO_ROUTE, drawRandomInt,
  getTripDurationMs, MAX_TRIP_FACTS, MAX_TRIP_NODES, nextRandomUint32, recallTrip,
} from '../src/index.ts';

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 25, 23, 58);
const OFFLINE_72H = 72 * 60 * MINUTE;
const trip = (seed = 8) => createTripSnapshot({ tripId: 'trip-1', petId: 'pet-a',
  startAt: START, seed, power: 20, route: DEMO_ROUTE });
const json = (value) => JSON.parse(JSON.stringify(value));

test('xorshift32 golden and exclusive integer sampling bounds', () => {
  let state = 1;
  assert.deepEqual(Array.from({ length: 5 }, () => state = nextRandomUint32(state)),
    [270369, 67634689, 2647435461, 307599695, 2398689233]);
  for (let i = 0; i < 1000; i++) {
    for (const bound of [1, 3, 10000, 0x100000000]) {
      const result = drawRandomInt(state, bound);
      assert(result.state > 0 && result.state <= 0xffffffff);
      assert(Number.isInteger(result.value) && result.value >= 0 && result.value < bound);
      state = result.state;
    }
  }
  for (const invalid of [0, -1, 1.5, NaN, 0x100000000]) assert.throws(() => trip(invalid), RangeError);
  assert.throws(() => drawRandomInt(1, 0), RangeError);
});

test('fixed seed success, loot, CG, scheduled return golden', () => {
  const s = trip();
  assert.equal(getTripDurationMs(DEMO_ROUTE), 15 * MINUTE);
  const checkpoint = createTripCheckpoint(s);
  const before = json(checkpoint);
  const done = advanceTrip(s, checkpoint, START + OFFLINE_72H);
  assert.deepEqual(checkpoint, before);
  assert.equal(done.status, 'SETTLED');
  assert.equal(done.presence, 'HOME');
  assert.equal(done.checkpoint.actualReturnedAt, START + 15 * MINUTE);
  assert.equal(done.checkpoint.rngState, 2397225082);
  assert.equal(done.checkpoint.drawCount, 4);
  assert.deepEqual(done.facts.map((fact) => [fact.eventId, fact.type, fact.scheduledAt]), [
    ['trip-1:1', 'GATHER_RESOLVED', START + 3 * MINUTE],
    ['trip-1:2', 'BATTLE_RESOLVED', START + 8 * MINUTE],
    ['trip-1:3', 'EVENT_RESOLVED', START + 12 * MINUTE],
    ['trip-1:4', 'RETURNING', START + 12 * MINUTE],
    ['trip-1:5', 'TRIP_RETURNED', START + 15 * MINUTE],
  ]);
  assert.deepEqual(done.rewardDraft, { xp: 24, coins: 8,
    items: [{ itemId: 'herb', quantity: 1 }, { itemId: 'slime-gel', quantity: 1 }], cgIds: ['morning-dew'] });
});

test('one-shot vs segmented/restarted 72h and midnight for 100 fixed seeds', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const snapshot = trip(seed);
    const initial = createTripCheckpoint(snapshot);
    const oneShot = advanceTrip(snapshot, initial, START + OFFLINE_72H);
    let checkpoint = initial;
    const allFacts = [];
    for (const offset of [0, MINUTE, 3 * MINUTE, 5 * MINUTE, 8 * MINUTE,
      10 * MINUTE, 12 * MINUTE, 15 * MINUTE, OFFLINE_72H]) {
      const step = advanceTrip(json(snapshot), json(checkpoint), START + offset);
      checkpoint = step.checkpoint;
      allFacts.push(...step.facts);
    }
    assert.deepEqual(checkpoint, oneShot.checkpoint);
    assert.deepEqual(allFacts, oneShot.facts);
  }
});

test('time rollback and repeated settled advances produce no repeated facts', () => {
  const s = trip();
  const first = advanceTrip(s, createTripCheckpoint(s), START + 5 * MINUTE);
  const backwards = advanceTrip(s, first.checkpoint, START + MINUTE);
  assert.deepEqual(backwards.facts, []);
  assert.deepEqual(backwards.checkpoint, first.checkpoint);
  const done = advanceTrip(s, backwards.checkpoint, START + OFFLINE_72H);
  for (const target of [START, START + 15 * MINUTE, START + 2 * OFFLINE_72H]) {
    const again = advanceTrip(s, done.checkpoint, target);
    assert.deepEqual(again.checkpoint, done.checkpoint);
    assert.deepEqual(again.facts, []);
  }
});

test('recall orders due node first and settles only accrued rewards; loss retreats early', () => {
  const s = trip();
  const recalled = recallTrip(s, createTripCheckpoint(s), START + 3 * MINUTE);
  assert.equal(recalled.presence, 'RETURNING');
  assert.deepEqual(recalled.facts.map((fact) => fact.type), ['GATHER_RESOLVED', 'RETURNING']);
  assert.equal(recalled.checkpoint.nextDueAt, START + 6 * MINUTE);
  const repeated = recallTrip(s, recalled.checkpoint, START + 4 * MINUTE);
  assert.deepEqual(repeated.facts, []);
  const home = advanceTrip(s, json(repeated.checkpoint), START + OFFLINE_72H);
  assert.deepEqual(home.rewardDraft, { xp: 4, coins: 0,
    items: [{ itemId: 'herb', quantity: 1 }], cgIds: [] });
  assert.equal(home.checkpoint.actualReturnedAt, START + 6 * MINUTE);
  const losing = trip(3);
  const defeated = advanceTrip(losing, createTripCheckpoint(losing), START + OFFLINE_72H);
  assert.equal(defeated.checkpoint.returnReason, 'DEFEATED');
  assert.equal(defeated.checkpoint.actualReturnedAt, START + 11 * MINUTE);
  assert.equal(defeated.checkpoint.drawCount, 3);
  assert.deepEqual(defeated.rewardDraft, { xp: 9, coins: 0,
    items: [{ itemId: 'herb', quantity: 1 }], cgIds: [] });
});

test('freeze route by value, verify version and reject corrupt restart state', () => {
  const route = json(DEMO_ROUTE);
  const input = { tripId: 'trip-frozen', petId: 'pet-a', startAt: START, seed: 8, power: 20, route };
  const snapshot = createTripSnapshot(input);
  const before = json(snapshot);
  route.nodes[1].drop.chanceBps = 10000;
  route.nodes.reverse();
  input.power = 1;
  assert.deepEqual(snapshot, before);
  assert(Object.isFrozen(snapshot.nodes[1].drop));
  const cp = createTripCheckpoint(snapshot);
  const progressed = advanceTrip(snapshot, cp, START + 3 * MINUTE).checkpoint;
  assert.throws(() => advanceTrip(snapshot, { ...progressed, rngState: 1 }, START + 4 * MINUTE), RangeError);
  assert.throws(() => advanceTrip(snapshot, { ...progressed, rewardDraft: { ...progressed.rewardDraft, xp: -1 } }, START + 4 * MINUTE), RangeError);
  assert.throws(() => advanceTrip(snapshot, { ...progressed, rewardDraft: { ...progressed.rewardDraft, xp: 1.5 } }, START + 4 * MINUTE), RangeError);
  assert.throws(() => advanceTrip({ ...snapshot, rulesVersion: 'future' }, cp, START), RangeError);
  assert.throws(() => advanceTrip({ ...snapshot, contentVersion: 2 }, cp, START), RangeError);
  assert.throws(() => advanceTrip(snapshot, { ...cp, tripId: 'other' }, START), RangeError);
  for (const tripId of ['unicode-宠', 'with space', '.bad', 't'.repeat(126)]) {
    assert.throws(() => createTripSnapshot({ ...snapshot, tripId, route: DEMO_ROUTE }), RangeError);
  }
  const returning = advanceTrip(snapshot, progressed, START + 12 * MINUTE).checkpoint;
  assert.throws(() => advanceTrip(snapshot, { ...returning, returnReason: 'DEFEATED' }, START + 13 * MINUTE), RangeError);
  assert.throws(() => advanceTrip(snapshot, { ...returning, rewardDraft: { ...returning.rewardDraft,
    items: [...returning.rewardDraft.items].reverse() } }, START + 13 * MINUTE), RangeError);
  const recall = recallTrip(snapshot, progressed, START + 4 * MINUTE).checkpoint;
  assert.throws(() => advanceTrip(snapshot, { ...recall, logicalTime: START + 3 * MINUTE }, START + 5 * MINUTE), RangeError);
});

test('bounded event count, safe arithmetic and canonical reward aggregation', () => {
  const route = { routeId: 'max-route', contentVersion: 1, returnDurationMs: 10,
    nodes: Array.from({ length: MAX_TRIP_NODES }, (_, i) => ({ kind: 'GATHER', nodeId: `g-${i}`,
      durationMs: 10, itemId: 'herb', minQuantity: 2, maxQuantity: 2, xp: 1 })) };
  const s = createTripSnapshot({ tripId: 'bounded', petId: 'pet-a', startAt: START, seed: 1, power: 1, route });
  const done = advanceTrip(s, createTripCheckpoint(s), Number.MAX_SAFE_INTEGER);
  assert.equal(done.facts.length, MAX_TRIP_FACTS);
  assert.deepEqual(done.rewardDraft, { xp: MAX_TRIP_NODES, coins: 0,
    items: [{ itemId: 'herb', quantity: 2 * MAX_TRIP_NODES }], cgIds: [] });
  assert.throws(() => getTripDurationMs({ ...route, nodes: [...route.nodes, route.nodes[0]] }), RangeError);
});
