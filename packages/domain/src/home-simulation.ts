/** Deterministic, persisted HOME needs and activity schedule (V1). No I/O or wall clock. */
export type HomePresence = 'HOME' | 'AWAY' | 'RETURNING';
export type HomeActivity = 'IDLE' | 'WALK' | 'DRAG' | 'INTERACT' | 'CHAT' | 'EAT' | 'REST' | 'SLEEP' | 'CELEBRATE';
export type HomeMood = 'CALM' | 'HAPPY' | 'EXCITED' | 'BORED' | 'UPSET' | 'TIRED';
export type HomeHealth = 'NORMAL' | 'INJURED' | 'RECOVERING';
export type HomeInteraction = 'PET' | 'REST' | 'WAKE';

export interface HomeStateInput {
  readonly petId: string;
  readonly presence: HomePresence;
  readonly activity: HomeActivity | null;
  readonly mood: HomeMood;
  readonly healthStatus: HomeHealth;
  readonly energy10: number;
  readonly healthPoints10: number;
  readonly moodScore10: number;
  readonly bond10: number;
}

export interface HomeSimulationState extends HomeStateInput {
  readonly lastSimAt: number;
  /** Null for unscheduled idle/external activities; non-null IDLE is a deliberate awake grace period. */
  readonly activityDueAt: number | null;
  /** Fractional tenths/hour × milliseconds, modulo one hour. */
  readonly energyRemainder: number;
  readonly healthRemainder: number;
  readonly moodRemainder: number;
  /** UTC epoch day and count of *eligible* rewarded interactions that day. */
  readonly interactionDay: number;
  readonly interactionCount: number;
  /** Last eligible rewarded interaction, retained across UTC day changes. */
  readonly lastInteractionAt: number | null;
}

export const HOME_RULES = Object.freeze({
  hourMs: 3_600_000,
  dayMs: 86_400_000,
  energyRecoveryPerHour10: 200,
  healthRecoveryPerHour10: 100,
  moodTendencyPerHour10: 100,
  neutralMood10: 500,
  autoRestEnergy10: 350,
  autoSleepEnergy10: 200,
  restTargetEnergy10: 650,
  sleepTargetEnergy10: 800,
  manualRestMinMs: 30_000,
  wakeGraceMs: 60_000,
  interactionDurationMs: 2_500,
  eatDurationMs: 4_000,
  celebrateDurationMs: 5_000,
  walkSlotMs: 300_000,
  walkDurationMs: 15_000,
  petCooldownMs: 30_000,
  petDailyLimit: 10,
  petMoodGain10: 50,
  petBondGain10: 10,
});

/** Conservative balance tuning. Keep the same rates across any segmented run. */
export interface HomeSimulationOptions {
  readonly healthRecoveryPerHour10?: number;
  readonly moodTendencyPerHour10?: number;
}

export interface HomeInteractionResult {
  readonly state: HomeSimulationState;
  readonly accepted: boolean;
  /** True means reward eligibility was used; saturated needs remain saturated. */
  readonly rewardGranted: boolean;
  readonly reason?: 'NOT_HOME' | 'ACTIVITY_BUSY' | 'COOLDOWN' | 'DAILY_LIMIT';
}

const MAX_TIME = Number.MAX_SAFE_INTEGER;
const HOUR = HOME_RULES.hourMs;
const DAY = HOME_RULES.dayMs;
const maxNeed = 1000;
const act = new Set<HomeActivity>(['IDLE', 'WALK', 'DRAG', 'INTERACT', 'CHAT', 'EAT', 'REST', 'SLEEP', 'CELEBRATE']);
const mood = new Set<HomeMood>(['CALM', 'HAPPY', 'EXCITED', 'BORED', 'UPSET', 'TIRED']);
const health = new Set<HomeHealth>(['NORMAL', 'INJURED', 'RECOVERING']);
const uint = (n: number, max = MAX_TIME): boolean => Number.isSafeInteger(n) && n >= 0 && n <= max;
const utcDay = (at: number): number => Math.floor(at / DAY);
const addTime = (at: number, ms: number): number => at + Math.min(ms, MAX_TIME - at);

function requireTime(at: number): void {
  if (!uint(at)) throw new RangeError('Invalid home simulation timestamp');
}

function requireInput(state: HomeStateInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(state.petId)
    || !['HOME', 'AWAY', 'RETURNING'].includes(state.presence)
    || (state.presence === 'HOME' ? state.activity === null || !act.has(state.activity) : state.activity !== null)
    || !mood.has(state.mood) || !health.has(state.healthStatus)
    || ![state.energy10, state.healthPoints10, state.moodScore10, state.bond10].every((value) => uint(value, maxNeed))) {
    throw new RangeError('Invalid home simulation state');
  }
}

/** Validates persisted state without advancing it or changing gameplay. */
export function validateHomeSimulationState(state: HomeSimulationState): void {
  requireInput(state);
  requireTime(state.lastSimAt);
  const due = state.activityDueAt;
  const mustBeUnscheduled = state.presence !== 'HOME' || state.activity === 'CHAT' || state.activity === 'DRAG';
  const mustBeScheduled = state.presence === 'HOME' && state.activity !== 'IDLE' && !mustBeUnscheduled;
  if ((due !== null && (!uint(due) || due < state.lastSimAt)) || (mustBeUnscheduled && due !== null)
    || (mustBeScheduled && due === null)
    || ![state.energyRemainder, state.healthRemainder, state.moodRemainder].every((value) => uint(value, HOUR - 1))
    || !uint(state.interactionDay, utcDay(state.lastSimAt)) || !uint(state.interactionCount, HOME_RULES.petDailyLimit)
    || (state.lastInteractionAt !== null && !uint(state.lastInteractionAt, state.lastSimAt))
    || (state.interactionCount > 0 && (state.lastInteractionAt === null || utcDay(state.lastInteractionAt) !== state.interactionDay))) {
    throw new RangeError('Invalid persisted home simulation clock');
  }
}

function rates(options: HomeSimulationOptions): { health: number; mood: number } {
  const h = options.healthRecoveryPerHour10 ?? HOME_RULES.healthRecoveryPerHour10;
  const m = options.moodTendencyPerHour10 ?? HOME_RULES.moodTendencyPerHour10;
  if (!uint(h, maxNeed) || !uint(m, maxNeed)) throw new RangeError('Invalid home recovery rate');
  return { health: h, mood: m };
}

interface FractionalNeed { readonly value: number; readonly remainder: number }

/** Exact quotient/remainder avoids both long-offline overflow and rounding each poll. */
function toward(value: number, remainder: number, target: number, rate10: number, elapsedMs: number): FractionalNeed {
  if (value === target) return { value, remainder: 0 }; // never bank excess recovery at a cap
  if (rate10 === 0) return { value, remainder };
  const total = BigInt(elapsedMs) * BigInt(rate10) + BigInt(remainder);
  const gained = total / BigInt(HOUR);
  const distance = Math.abs(target - value);
  if (gained >= BigInt(distance)) return { value: target, remainder: 0 };
  return { value: value + Math.sign(target - value) * Number(gained), remainder: Number(total % BigInt(HOUR)) };
}

function energyAt(state: HomeSimulationState, at: number): FractionalNeed {
  return toward(state.energy10, state.energyRemainder, maxNeed, HOME_RULES.energyRecoveryPerHour10, at - state.lastSimAt);
}

function timeToEnergy(energy: FractionalNeed, target: number): number {
  const numerator = (target - energy.value) * HOUR - energy.remainder;
  return Math.max(0, Math.ceil(numerator / HOME_RULES.energyRecoveryPerHour10));
}

function deriveMood(score: number, energy: number): HomeMood {
  if (energy <= HOME_RULES.autoSleepEnergy10) return 'TIRED';
  if (score >= 850) return 'EXCITED';
  if (score >= 550) return 'HAPPY';
  if (score < 300) return 'UPSET';
  if (score < 450) return 'BORED';
  return 'CALM';
}

interface Schedule { readonly activity: HomeActivity; readonly activityDueAt: number | null }

function restSchedule(energy: FractionalNeed, at: number, activity: 'REST' | 'SLEEP', manual: boolean): Schedule {
  const target = activity === 'SLEEP' ? HOME_RULES.sleepTargetEnergy10 : HOME_RULES.restTargetEnergy10;
  const duration = Math.max(manual ? HOME_RULES.manualRestMinMs : 0, timeToEnergy(energy, target));
  return { activity, activityDueAt: addTime(at, duration) };
}

function mix32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function petSeed(petId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < petId.length; i += 1) hash = Math.imul(hash ^ petId.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Absolute deterministic schedule, independent of the number or duration of polls. */
function autonomousAt(petId: string, at: number): Schedule {
  const slot = Math.floor(at / HOME_RULES.walkSlotMs);
  const slotAt = slot * HOME_RULES.walkSlotMs;
  const random = mix32(petSeed(petId) ^ mix32(slot >>> 0) ^ Math.imul(Math.floor(slot / 0x1_0000_0000), 0x9e3779b1));
  // At most one brief walk per selected absolute five-minute slot. The first
  // minute stays free of walks; the remaining offset is stable for this pet/slot.
  const start = 60_000 + ((random >>> 8) % (HOME_RULES.walkSlotMs - 60_000 - HOME_RULES.walkDurationMs));
  const end = addTime(slotAt, start + HOME_RULES.walkDurationMs);
  return random % 3 === 0 && at - slotAt >= start && at < end
    ? { activity: 'WALK', activityDueAt: end } : { activity: 'IDLE', activityDueAt: null };
}

function ordinarySchedule(petId: string, energy: FractionalNeed, startAt: number, at: number): Schedule {
  if (energy.value <= HOME_RULES.autoRestEnergy10) {
    const active = restSchedule(energy, startAt, energy.value <= HOME_RULES.autoSleepEnergy10 ? 'SLEEP' : 'REST', false);
    const target = active.activity === 'SLEEP' ? HOME_RULES.sleepTargetEnergy10 : HOME_RULES.restTargetEnergy10;
    if (active.activityDueAt! > at || (active.activityDueAt === MAX_TIME && timeToEnergy(energy, target) > at - startAt)) return active;
    // Recovery is monotone; after this single threshold completion the pet
    // cannot re-enter a low-energy state without a separate authoritative action.
  }
  return autonomousAt(petId, at);
}

function resolveSchedule(state: HomeSimulationState, at: number): Schedule {
  const activity = state.activity!;
  if (activity === 'CHAT' || activity === 'DRAG') return { activity, activityDueAt: null };
  // WALK is a pure absolute-slot projection, not an independent persistent job.
  if (activity === 'WALK' || (activity === 'IDLE' && state.activityDueAt === null)) {
    return ordinarySchedule(state.petId, energyAt(state, state.lastSimAt), state.lastSimAt, at);
  }
  const due = state.activityDueAt!;
  if (due > at) return { activity, activityDueAt: due };
  // The safe-integer time horizon may clip a genuinely incomplete recovery.
  // Keep the same schedule at that last representable instant.
  if (due === MAX_TIME && (activity === 'REST' || activity === 'SLEEP')
    && energyAt(state, due).value < (activity === 'REST' ? HOME_RULES.restTargetEnergy10 : HOME_RULES.sleepTargetEnergy10)) {
    return { activity, activityDueAt: due };
  }
  // One explicit/short activity can finish, followed by at most one threshold
  // recovery period. Thousands of skipped idle/walk slots need no iteration.
  return ordinarySchedule(state.petId, energyAt(state, due), due, at);
}

/**
 * Migration/new-pet initializer. All numerics are preserved; clocks start at
 * the supplied authoritative time, never retro-crediting unknown history.
 */
export function initializeHomeState(input: HomeStateInput, at: number): HomeSimulationState {
  requireInput(input);
  requireTime(at);
  const base: HomeSimulationState = { ...input, lastSimAt: at, activityDueAt: null,
    energyRemainder: 0, healthRemainder: 0, moodRemainder: 0, interactionDay: utcDay(at),
    interactionCount: 0, lastInteractionAt: null };
  if (base.presence !== 'HOME') return base;
  let schedule: Schedule;
  switch (base.activity) {
    case 'INTERACT': schedule = { activity: 'INTERACT', activityDueAt: addTime(at, HOME_RULES.interactionDurationMs) }; break;
    case 'EAT': schedule = { activity: 'EAT', activityDueAt: addTime(at, HOME_RULES.eatDurationMs) }; break;
    case 'CELEBRATE': schedule = { activity: 'CELEBRATE', activityDueAt: addTime(at, HOME_RULES.celebrateDurationMs) }; break;
    case 'REST': case 'SLEEP': schedule = restSchedule({ value: base.energy10, remainder: 0 }, at, base.activity, true); break;
    case 'CHAT': case 'DRAG': schedule = { activity: base.activity, activityDueAt: null }; break;
    default: schedule = ordinarySchedule(base.petId, { value: base.energy10, remainder: 0 }, at, at);
  }
  return { ...base, ...schedule, mood: deriveMood(base.moodScore10, base.energy10),
    healthStatus: base.healthPoints10 === maxNeed ? 'NORMAL' : 'RECOVERING' };
}

/** Advance a HOME state in O(1) work; absence advances clocks but no home needs. */
export function advanceHomeState(state: HomeSimulationState, now: number, options: HomeSimulationOptions = {}): HomeSimulationState {
  validateHomeSimulationState(state);
  requireTime(now);
  const configured = rates(options);
  const at = Math.max(state.lastSimAt, now); // never credit the same elapsed time twice
  const day = utcDay(at);
  const clock = { lastSimAt: at, interactionDay: day, interactionCount: day === state.interactionDay ? state.interactionCount : 0 };
  if (state.presence !== 'HOME') return { ...state, ...clock };
  const elapsed = at - state.lastSimAt;
  const energy = energyAt(state, at);
  const recovery = toward(state.healthPoints10, state.healthRemainder, maxNeed, configured.health, elapsed);
  const tendency = toward(state.moodScore10, state.moodRemainder, HOME_RULES.neutralMood10, configured.mood, elapsed);
  return {
    ...state, ...clock, ...resolveSchedule(state, at), energy10: energy.value, energyRemainder: energy.remainder,
    healthPoints10: recovery.value, healthRemainder: recovery.remainder, moodScore10: tendency.value, moodRemainder: tendency.remainder,
    mood: deriveMood(tendency.value, energy.value), healthStatus: recovery.value === maxNeed ? 'NORMAL' : 'RECOVERING',
  };
}

/** Authority may apply the returned state after the game's command checks. No external effects. */
export function interactHome(state: HomeSimulationState, interaction: HomeInteraction, now: number,
  options: HomeSimulationOptions = {}): HomeInteractionResult {
  if (interaction !== 'PET' && interaction !== 'REST' && interaction !== 'WAKE') throw new RangeError('Unknown home interaction');
  const advanced = advanceHomeState(state, now, options);
  if (advanced.presence !== 'HOME') return { state: advanced, accepted: false, rewardGranted: false, reason: 'NOT_HOME' };
  const at = advanced.lastSimAt;
  const busy = advanced.activity === 'CHAT' || advanced.activity === 'DRAG';
  if (interaction === 'PET') {
    // An explicit click still yields immediate short feedback during cooldown;
    // CHAT/DRAG are externally owned activities and cannot be stolen by it.
    const feedback = busy ? advanced : { ...advanced, activity: 'INTERACT' as const, activityDueAt: addTime(at, HOME_RULES.interactionDurationMs) };
    const limited = advanced.interactionCount >= HOME_RULES.petDailyLimit ? 'DAILY_LIMIT' as const
      : advanced.lastInteractionAt !== null && at - advanced.lastInteractionAt < HOME_RULES.petCooldownMs ? 'COOLDOWN' as const : undefined;
    if (limited) return { state: feedback, accepted: true, rewardGranted: false, reason: limited };
    const moodScore10 = Math.min(maxNeed, advanced.moodScore10 + HOME_RULES.petMoodGain10);
    const bond10 = Math.min(maxNeed, advanced.bond10 + HOME_RULES.petBondGain10);
    return { state: { ...feedback, moodScore10, bond10,
      // A discrete mood jump may change recovery direction; the old fractional
      // remainder cannot be carried across that jump or target saturation.
      moodRemainder: moodScore10 === advanced.moodScore10 ? advanced.moodRemainder : 0,
      mood: deriveMood(moodScore10, advanced.energy10), interactionCount: advanced.interactionCount + 1, lastInteractionAt: at,
    }, accepted: true, rewardGranted: true };
  }
  if (busy) return { state: advanced, accepted: false, rewardGranted: false, reason: 'ACTIVITY_BUSY' };
  if (interaction === 'WAKE') {
    const awakened = advanced.activity === 'REST' || advanced.activity === 'SLEEP'
      ? { ...advanced, activity: 'IDLE' as const, activityDueAt: addTime(at, HOME_RULES.wakeGraceMs) } : advanced;
    return { state: awakened, accepted: true, rewardGranted: false };
  }
  // REST schedules recovery rather than manufacturing energy/health immediately;
  // another REST while already recovering does not postpone its completion.
  const resting = advanced.activity === 'REST' || advanced.activity === 'SLEEP' ? advanced
    : { ...advanced, ...restSchedule({ value: advanced.energy10, remainder: advanced.energyRemainder }, at,
      advanced.energy10 <= HOME_RULES.autoSleepEnergy10 ? 'SLEEP' : 'REST', true) };
  return { state: resting, accepted: true, rewardGranted: false };
}
