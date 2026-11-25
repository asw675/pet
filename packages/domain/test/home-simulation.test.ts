import { describe, expect, it } from 'vitest';
import {
  advanceHomeState, HOME_RULES, initializeHomeState, interactHome, validateHomeSimulationState,
} from '../src/home-simulation.js';
import type { HomeSimulationState, HomeStateInput } from '../src/home-simulation.js';

const H = HOME_RULES.hourMs;
const DAY = HOME_RULES.dayMs;
const START = 1_800_000_000_000;
const baseline: HomeStateInput = {
  petId: 'pet-one', presence: 'HOME', activity: 'IDLE', mood: 'CALM', healthStatus: 'NORMAL',
  energy10: 600, healthPoints10: 1_000, moodScore10: 500, bond10: 150,
};
const fresh = (changes: Partial<HomeStateInput> = {}, at = START) => initializeHomeState({ ...baseline, ...changes }, at);
const advance = (state: HomeSimulationState, elapsed: number) => advanceHomeState(state, state.lastSimAt + elapsed);

describe('persistent HOME recovery and simulation clock', () => {
  it('initializes at the supplied migration time without retro-crediting old history', () => {
    const state = fresh({ energy10: 80, healthPoints10: 180, moodScore10: 720, bond10: 321, mood: 'EXCITED', healthStatus: 'INJURED' });
    expect(state).toMatchObject({ energy10: 80, healthPoints10: 180, moodScore10: 720, bond10: 321,
      healthStatus: 'RECOVERING', activity: 'SLEEP', lastSimAt: START, interactionDay: Math.floor(START / DAY),
      interactionCount: 0, lastInteractionAt: null, energyRemainder: 0, healthRemainder: 0, moodRemainder: 0 });
    expect(advanceHomeState(state, START)).toEqual(state);
    expect(() => validateHomeSimulationState(state)).not.toThrow();
  });

  it('restores the configured conservative amount of energy, health and mood in one hour', () => {
    const state = fresh({ energy10: 300, healthPoints10: 400, healthStatus: 'INJURED', moodScore10: 900, bond10: 120 });
    expect(advance(state, H)).toMatchObject({ energy10: 500, healthPoints10: 500, moodScore10: 800, bond10: 120,
      healthStatus: 'RECOVERING', activity: 'REST', mood: 'HAPPY' });
  });

  it('holds exact sub-tenth remainders across short polls and carries them once', () => {
    const state = fresh({ energy10: 600, healthPoints10: 700, moodScore10: 700 });
    const almost = advance(state, 17_999);
    expect(almost).toMatchObject({ energy10: 600, energyRemainder: 3_599_800, healthPoints10: 700, healthRemainder: 1_799_900,
      moodScore10: 700, moodRemainder: 1_799_900 });
    const crossed = advance(almost, 1);
    expect(crossed).toMatchObject({ energy10: 601, energyRemainder: 0, healthPoints10: 700, healthRemainder: 1_800_000 });
    expect(advance(crossed, 18_000)).toEqual(advance(state, 36_000));
  });

  it('saturation clears fractional credit, with no recovery saved for a future deficit', () => {
    const near = fresh({ energy10: 999, healthPoints10: 999, moodScore10: 499 });
    const after = advance(near, H * 2 + 15);
    expect(after).toMatchObject({ energy10: 1_000, healthPoints10: 1_000, moodScore10: 500, energyRemainder: 0,
      healthRemainder: 0, moodRemainder: 0, healthStatus: 'NORMAL' });
    const deficit = { ...after, energy10: 990, healthPoints10: 990, moodScore10: 490 };
    expect(advance(deficit, 1)).toMatchObject({ energy10: 990, healthPoints10: 990, moodScore10: 490,
      energyRemainder: 200, healthRemainder: 100, moodRemainder: 100 });
  });

  it('moves both positive and negative temporary mood toward 500 without lowering long-term bond', () => {
    const negative = advance(fresh({ moodScore10: 100, bond10: 890 }), 24 * H);
    const positive = advance(fresh({ moodScore10: 950, bond10: 890 }), 24 * H);
    expect(negative).toMatchObject({ moodScore10: 500, moodRemainder: 0, mood: 'CALM', bond10: 890 });
    expect(positive).toMatchObject({ moodScore10: 500, moodRemainder: 0, mood: 'CALM', bond10: 890 });
  });

  it('permits nonnegative tuning for health and mood without changing required energy recovery', () => {
    const state = fresh({ energy10: 500, healthPoints10: 100, moodScore10: 200 });
    const after = advanceHomeState(state, START + H, { healthRecoveryPerHour10: 50, moodTendencyPerHour10: 0 });
    expect(after).toMatchObject({ energy10: 700, healthPoints10: 150, moodScore10: 200 });
    expect(() => advanceHomeState(state, START + H, { healthRecoveryPerHour10: -1 })).toThrow(RangeError);
    expect(() => advanceHomeState(state, START + H, { moodTendencyPerHour10: 0.5 })).toThrow(RangeError);
  });

  it('one 72-hour advance equals irregular segmented simulation, including short activities and UTC day changes', () => {
    const start = DAY * 20_000 + DAY - 10_000;
    for (const input of [
      { energy10: 20, healthPoints10: 20, moodScore10: 900, activity: 'IDLE' as const },
      { energy10: 250, healthPoints10: 450, moodScore10: 50, activity: 'INTERACT' as const },
      { energy10: 600, healthPoints10: 980, moodScore10: 850, activity: 'REST' as const },
      { energy10: 1_000, healthPoints10: 500, moodScore10: 499, activity: 'CHAT' as const },
    ]) {
      const state = interactHome(fresh(input, start), 'PET', start).state;
      const target = start + 72 * H + 17_345;
      const oneShot = advanceHomeState(state, target);
      let segmented = state;
      let stride = 1;
      while (segmented.lastSimAt < target) {
        stride = ((stride * 1_103 + 7) % 7_200_000) + 1;
        segmented = advanceHomeState(segmented, Math.min(target, segmented.lastSimAt + stride));
      }
      expect(segmented).toEqual(oneShot);
      expect(oneShot.energy10).toBe(1_000);
      expect(oneShot.interactionCount).toBe(0);
    }
  });

  it('handles the full safe timestamp range without elapsed multiplication overflow', () => {
    const start = fresh({ energy10: 0, healthPoints10: 0, moodScore10: 0 }, 0);
    const final = advanceHomeState(start, Number.MAX_SAFE_INTEGER);
    expect(final).toMatchObject({ energy10: 1_000, healthPoints10: 1_000, moodScore10: 500,
      energyRemainder: 0, healthRemainder: 0, moodRemainder: 0, lastSimAt: Number.MAX_SAFE_INTEGER });
    expect(() => validateHomeSimulationState(final)).not.toThrow();
  });

  it('clamps wall-clock rollback and does not double-credit elapsed recovery', () => {
    const initial = fresh({ energy10: 150, healthPoints10: 650, moodScore10: 980 });
    const progressed = advance(initial, 23_456);
    expect(advanceHomeState(progressed, START)).toEqual(progressed);
    expect(advanceHomeState(progressed, START + 30_000)).toEqual(advance(initial, 30_000));
  });

  it('leaves AWAY and RETURNING numerics, activity and mood alone over multi-day offline time', () => {
    for (const presence of ['AWAY', 'RETURNING'] as const) {
      const initial = fresh({ presence, activity: null, energy10: 110, healthPoints10: 240, moodScore10: 80,
        mood: 'UPSET', healthStatus: 'INJURED', bond10: 99 });
      const advanced = advance(initial, 2 * DAY);
      expect(advanced).toEqual({ ...initial, lastSimAt: START + 2 * DAY, interactionDay: initial.interactionDay + 2 });
      expect(interactHome(initial, 'REST', START + H)).toEqual({ state: advance(initial, H), accepted: false,
        rewardGranted: false, reason: 'NOT_HOME' });
    }
  });

  it('can resume at authoritative trip return time and credits only later HOME duration', () => {
    const away = fresh({ presence: 'AWAY', activity: null, energy10: 500, healthPoints10: 800, moodScore10: 700 });
    const actualReturn = START + 10 * H;
    const atReturn = { ...away, presence: 'HOME' as const, activity: 'IDLE' as const, lastSimAt: actualReturn, activityDueAt: null };
    const after = advanceHomeState(atReturn, actualReturn + H);
    expect(after).toMatchObject({ energy10: 700, healthPoints10: 900, moodScore10: 600, lastSimAt: actualReturn + H });
  });
});

describe('finite activity scheduling and absolute autonomous walks', () => {
  it('automatically RESTs at low energy and ends exactly at the persisted recovery threshold', () => {
    const resting = fresh({ energy10: 350 });
    const due = START + 1.5 * H;
    expect(resting).toMatchObject({ activity: 'REST', activityDueAt: due });
    expect(advanceHomeState(resting, due - 1)).toMatchObject({ activity: 'REST', energy10: 649 });
    const completed = advanceHomeState(resting, due);
    expect(completed.energy10).toBe(650);
    expect(['IDLE', 'WALK']).toContain(completed.activity);
    expect(completed).toEqual(advanceHomeState(advanceHomeState(resting, due - 1), due));
  });

  it('sleeps at critically low energy until its own higher recovery threshold', () => {
    const sleeping = fresh({ energy10: 200 });
    const due = START + 3 * H;
    expect(sleeping).toMatchObject({ activity: 'SLEEP', mood: 'TIRED', activityDueAt: due });
    expect(advance(sleeping, 2.5 * H)).toMatchObject({ activity: 'SLEEP', energy10: 700 });
    expect(advanceHomeState(sleeping, due).energy10).toBe(800);
    expect(['IDLE', 'WALK']).toContain(advanceHomeState(sleeping, due).activity);
  });

  it('manual REST never instantly heals or restores energy, even at high energy', () => {
    const initial = fresh({ energy10: 900, healthPoints10: 300 });
    const result = interactHome(initial, 'REST', START);
    expect(result).toMatchObject({ accepted: true, rewardGranted: false, state: { activity: 'REST', energy10: 900,
      healthPoints10: 300, activityDueAt: START + HOME_RULES.manualRestMinMs } });
    const completed = advanceHomeState(result.state, START + HOME_RULES.manualRestMinMs);
    expect(['IDLE', 'WALK']).toContain(completed.activity);
    expect(completed.energy10).toBe(901);
    expect(completed.healthPoints10).toBe(300);
  });

  it('repeated REST preserves the first recovery schedule instead of extending it', () => {
    const state = fresh({ energy10: 600 });
    const first = interactHome(state, 'REST', START).state;
    const second = interactHome(first, 'REST', START + 60_000).state;
    expect(second.activityDueAt).toBe(first.activityDueAt);
    expect(second.energy10).toBe(603);
  });

  it('WAKE permits a short deliberate awake grace at low energy and then re-evaluates sleep', () => {
    const sleeping = fresh({ energy10: 80 });
    const wake = interactHome(sleeping, 'WAKE', START).state;
    expect(wake).toMatchObject({ activity: 'IDLE', activityDueAt: START + HOME_RULES.wakeGraceMs, energy10: 80 });
    expect(advance(wake, HOME_RULES.wakeGraceMs - 1).activity).toBe('IDLE');
    expect(advance(wake, HOME_RULES.wakeGraceMs).activity).toBe('SLEEP');
  });

  it('PET temporarily overrides sleep but short feedback returns to the low-energy schedule', () => {
    const state = fresh({ energy10: 90 });
    const touched = interactHome(state, 'PET', START);
    expect(touched.state).toMatchObject({ activity: 'INTERACT', activityDueAt: START + HOME_RULES.interactionDurationMs });
    const due = touched.state.activityDueAt!;
    expect(advanceHomeState(touched.state, due - 1).activity).toBe('INTERACT');
    expect(advanceHomeState(touched.state, due).activity).toBe('SLEEP');
  });

  it('expires each migrated short action without pretending it will run indefinitely', () => {
    for (const [activity, duration] of [
      ['INTERACT', HOME_RULES.interactionDurationMs], ['EAT', HOME_RULES.eatDurationMs], ['CELEBRATE', HOME_RULES.celebrateDurationMs],
    ] as const) {
      const state = fresh({ activity, energy10: 1_000 });
      expect(state.activityDueAt).toBe(START + duration);
      expect(advance(state, duration - 1).activity).toBe(activity);
      expect(['IDLE', 'WALK']).toContain(advance(state, duration).activity);
    }
  });

  it('does not steal externally owned CHAT or DRAG activities with random walking or REST', () => {
    for (const activity of ['CHAT', 'DRAG'] as const) {
      const busy = fresh({ activity, energy10: 0 });
      const later = advance(busy, 10 * H);
      expect(later).toMatchObject({ activity, activityDueAt: null, energy10: 1_000 });
      const pet = interactHome(later, 'PET', later.lastSimAt);
      expect(pet).toMatchObject({ accepted: true, rewardGranted: true, state: { activity } });
      expect(interactHome(later, 'REST', later.lastSimAt)).toMatchObject({ accepted: false, reason: 'ACTIVITY_BUSY' });
    }
  });

  it('has independent deterministic short WALK slots and no long-lived random timer', () => {
    const one = fresh({ petId: 'one', energy10: 1_000 });
    const two = fresh({ petId: 'two', energy10: 1_000 });
    let walkSeen = false;
    let differenceSeen = false;
    let segmented = one;
    for (let time = START; time <= START + H; time += 5_000) {
      const projected = advanceHomeState(one, time);
      segmented = advanceHomeState(segmented, time);
      const comparison = advanceHomeState(two, time);
      expect(segmented).toEqual(projected);
      if (projected.activity !== comparison.activity) differenceSeen = true;
      if (projected.activity === 'WALK') {
        walkSeen = true;
        expect(projected.activityDueAt! - time).toBeGreaterThan(0);
        expect(projected.activityDueAt! - time).toBeLessThanOrEqual(HOME_RULES.walkDurationMs);
        expect(advanceHomeState(projected, projected.activityDueAt!).activity).toBe('IDLE');
      }
    }
    expect(walkSeen).toBe(true);
    expect(differenceSeen).toBe(true);
  });
});

describe('UTC-bounded pet interaction eligibility', () => {
  it('gives immediate feedback but only grants gains once at the same logical instant', () => {
    const initial = fresh({ energy10: 1_000 });
    const first = interactHome(initial, 'PET', START);
    expect(first).toMatchObject({ accepted: true, rewardGranted: true, state: { moodScore10: 550, mood: 'HAPPY',
      bond10: 160, interactionCount: 1, lastInteractionAt: START } });
    const second = interactHome(first.state, 'PET', START);
    expect(second).toMatchObject({ accepted: true, rewardGranted: false, reason: 'COOLDOWN', state: { activity: 'INTERACT',
      moodScore10: 550, bond10: 160, interactionCount: 1, lastInteractionAt: START } });
  });

  it('enforces 30 seconds without extending cooldown on suppressed clicks', () => {
    const first = interactHome(fresh(), 'PET', START).state;
    const denied = interactHome(first, 'PET', START + 29_999);
    expect(denied.reason).toBe('COOLDOWN');
    expect(denied.state.lastInteractionAt).toBe(START);
    const eligible = interactHome(denied.state, 'PET', START + 30_000);
    expect(eligible).toMatchObject({ rewardGranted: true, state: { bond10: baseline.bond10 + 20, interactionCount: 2,
      lastInteractionAt: START + 30_000 } });
  });

  it('enforces ten daily eligible interactions and resets exactly at UTC midnight', () => {
    const noon = DAY * 20_001 + 12 * H;
    let state = fresh({}, noon);
    for (let i = 0; i < 10; i += 1) {
      const result = interactHome(state, 'PET', noon + i * HOME_RULES.petCooldownMs);
      expect(result.rewardGranted).toBe(true);
      state = result.state;
    }
    const excess = interactHome(state, 'PET', noon + 10 * HOME_RULES.petCooldownMs);
    expect(excess).toMatchObject({ accepted: true, rewardGranted: false, reason: 'DAILY_LIMIT', state: { interactionCount: 10,
      bond10: baseline.bond10 + 100 } });
    const midnight = DAY * 20_002;
    const nextDay = interactHome(excess.state, 'PET', midnight);
    expect(nextDay).toMatchObject({ rewardGranted: true, state: { interactionDay: 20_002, interactionCount: 1,
      bond10: baseline.bond10 + 110, lastInteractionAt: midnight } });
  });

  it('keeps cooldown across UTC midnight and rejects rollback attempts to bypass it', () => {
    const midnight = DAY * 20_000;
    const before = midnight - 10_000;
    const first = interactHome(fresh({}, before), 'PET', before).state;
    const crossing = interactHome(first, 'PET', midnight);
    expect(crossing).toMatchObject({ rewardGranted: false, reason: 'COOLDOWN', state: { interactionDay: 20_000,
      interactionCount: 0, lastInteractionAt: before } });
    expect(interactHome(crossing.state, 'PET', before - H).rewardGranted).toBe(false);
    expect(interactHome(crossing.state, 'PET', midnight + 20_000).rewardGranted).toBe(true);
  });

  it('preserves independent cooldown, mood and bond counters for different pet identities', () => {
    const a = fresh({ petId: 'a' });
    const b = fresh({ petId: 'b' });
    const touchedA = interactHome(a, 'PET', START);
    expect(touchedA.rewardGranted).toBe(true);
    expect(b.interactionCount).toBe(0);
    expect(interactHome(b, 'PET', START).rewardGranted).toBe(true);
    expect(interactHome(touchedA.state, 'PET', START).rewardGranted).toBe(false);
  });

  it('clamps rewards at maximum needs and clears directional mood remainder on deliberate gains', () => {
    const saturated = fresh({ moodScore10: 990, bond10: 995 });
    expect(interactHome(saturated, 'PET', START).state).toMatchObject({ moodScore10: 1_000, bond10: 1_000, interactionCount: 1 });
    const fraction = advance(fresh({ moodScore10: 490 }), 20_000);
    expect(fraction.moodRemainder).toBe(2_000_000);
    const touched = interactHome(fraction, 'PET', fraction.lastSimAt).state;
    expect(touched).toMatchObject({ moodScore10: 540, moodRemainder: 0 });
  });

  it('rejects invalid timestamps, need values, activity shapes and persisted counters', () => {
    expect(() => fresh({ energy10: 1_001 })).toThrow(RangeError);
    expect(() => fresh({ presence: 'AWAY', activity: 'IDLE' })).toThrow(RangeError);
    expect(() => fresh({ presence: 'HOME', activity: null })).toThrow(RangeError);
    expect(() => advanceHomeState(fresh(), -1)).toThrow(RangeError);
    expect(() => validateHomeSimulationState({ ...fresh(), energyRemainder: H })).toThrow(RangeError);
    expect(() => validateHomeSimulationState({ ...fresh(), interactionCount: 1, lastInteractionAt: null })).toThrow(RangeError);
    expect(() => validateHomeSimulationState({ ...fresh(), activity: 'INTERACT', activityDueAt: null })).toThrow(RangeError);
    expect(() => validateHomeSimulationState({ ...fresh(), activityDueAt: START - 1 })).toThrow(RangeError);
  });
});
