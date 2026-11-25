/** Local, opt-in workload suggestions. No paths, processes, window contents,
 * arbitrary app IDs, telemetry, or execution functions are accepted. */
export const RECOMMENDATION_RULES_VERSION = 1 as const;
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
export const RECOMMENDATION_LIMITS = Object.freeze({ targets: 100, history: 1_000, perLocalDay: 2, minIndependentManualUses: 3, cooccurrenceMs: 10 * MINUTE });
export type LaunchSource = 'MANUAL' | 'ROUTINE' | 'SUGGESTION';
export type LaunchOutcome = 'ACCEPTED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';
export type LocalPeriod = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT';
export interface RecommendableTarget { readonly targetId: string; readonly label: string; readonly enabled: boolean; readonly approved: boolean; readonly recommendable: boolean; }
export interface LaunchHistoryFact {
  readonly targetId: string; readonly runId: string; readonly source: LaunchSource; readonly outcome: LaunchOutcome;
  /** Privacy-minimized five-minute UTC bucket; offset captured at this use so
   * DST/time-zone changes do not rewrite the user's previous local period. */
  readonly timeBucket: number; readonly utcOffsetMinutes: number;
}
export interface RecommendationPreference {
  readonly targetId: string; readonly ignoredUntil: number | null; readonly permanentlyExcluded: boolean;
}
export interface RecommendInput {
  readonly enabled: boolean; readonly now: number; readonly utcOffsetMinutes: number; readonly retentionDays: 7 | 30;
  readonly targets: readonly RecommendableTarget[]; readonly history: readonly LaunchHistoryFact[];
  readonly preferences: readonly RecommendationPreference[];
  readonly shownToday: number;
}
export interface RecommendationEvidence {
  readonly count7: number; readonly count30: number; readonly sameLocalPeriod: number; readonly weekdayKind: 'WEEKDAY' | 'WEEKEND';
  readonly period: LocalPeriod; readonly sharedUses: number; readonly contextTargetIds: readonly string[];
}
export interface LocalRecommendation {
  readonly targetId: string; readonly label: string; readonly score: number; readonly evidence: RecommendationEvidence;
  /** User may create/edit a routine from these approved IDs; this is never an execution instruction. */
  readonly routineSuggestion: readonly string[];
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const offsetValid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -840 && value <= 840;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const periodAt = (at: number, utcOffsetMinutes: number): { period: LocalPeriod; weekdayKind: 'WEEKDAY' | 'WEEKEND' } => {
  const time = new Date(at + utcOffsetMinutes * MINUTE);
  const hour = time.getUTCHours(), weekday = time.getUTCDay();
  return { period: hour >= 5 && hour < 12 ? 'MORNING' : hour >= 12 && hour < 18 ? 'AFTERNOON' : hour >= 18 && hour < 23 ? 'EVENING' : 'NIGHT',
    weekdayKind: weekday === 0 || weekday === 6 ? 'WEEKEND' : 'WEEKDAY' };
};
const currentTarget = (value: RecommendableTarget): boolean => validId(value.targetId) && typeof value.label === 'string'
  && value.label.trim().length > 0 && value.label.length <= 80 && value.enabled === true && value.approved === true && value.recommendable === true;
const validLaunch = (value: LaunchHistoryFact): boolean => validId(value.targetId) && validId(value.runId) && integer(value.timeBucket)
  && value.timeBucket % (5 * MINUTE) === 0 && offsetValid(value.utcOffsetMinutes)
  && ['MANUAL', 'ROUTINE', 'SUGGESTION'].includes(value.source) && ['ACCEPTED', 'FAILED', 'SKIPPED', 'UNKNOWN'].includes(value.outcome);

/** Only app-origin accepted manual facts contribute to frequency and the
 * threshold. A batch (or an accepted recommendation) cannot train itself.
 * Routine outcomes may supply co-use evidence once per run/day-target pair. */
export function recommendTargets(input: RecommendInput): readonly LocalRecommendation[] {
  if (!input.enabled) return [];
  if (!integer(input.now) || input.now > 8_640_000_000_000_000 - DAY || !offsetValid(input.utcOffsetMinutes)
    || (input.retentionDays !== 7 && input.retentionDays !== 30) || !integer(input.shownToday)
    || !Array.isArray(input.targets) || input.targets.length > RECOMMENDATION_LIMITS.targets
    || !Array.isArray(input.history) || input.history.length > RECOMMENDATION_LIMITS.history
    || !Array.isArray(input.preferences) || input.preferences.length > RECOMMENDATION_LIMITS.targets) throw new RangeError('Invalid recommendation input');
  if (input.shownToday >= RECOMMENDATION_LIMITS.perLocalDay) return [];
  const targetIds = new Set<string>(), eligible = new Map<string, RecommendableTarget>();
  for (const target of input.targets) {
    if (!target || !validId(target.targetId) || targetIds.has(target.targetId)) throw new RangeError('Invalid or duplicate recommendation target');
    targetIds.add(target.targetId);
    if (currentTarget(target)) eligible.set(target.targetId, target);
  }
  const prefs = new Map<string, RecommendationPreference>();
  for (const pref of input.preferences) {
    if (!pref || !validId(pref.targetId) || prefs.has(pref.targetId) || typeof pref.permanentlyExcluded !== 'boolean'
      || (pref.ignoredUntil !== null && !integer(pref.ignoredUntil))) throw new RangeError('Invalid recommendation preference');
    prefs.set(pref.targetId, pref);
  }
  const recent = input.history.filter((fact) => {
    if (!fact || !validLaunch(fact)) throw new RangeError('Invalid local launch history fact');
    return fact.outcome === 'ACCEPTED' && fact.source !== 'SUGGESTION' && eligible.has(fact.targetId)
      && fact.timeBucket <= input.now && fact.timeBucket > input.now - input.retentionDays * DAY;
  }).sort((a, b) => a.timeBucket - b.timeBucket || compare(a.runId, b.runId) || compare(a.targetId, b.targetId));
  const byTarget = new Map<string, Map<string, LaunchHistoryFact>>();
  // A duplicate receipt or repeated item in one batch is at most one event.
  for (const fact of recent) {
    if (fact.source !== 'MANUAL') continue;
    const uses = byTarget.get(fact.targetId) ?? new Map<string, LaunchHistoryFact>();
    if (!uses.has(fact.runId)) uses.set(fact.runId, fact);
    byTarget.set(fact.targetId, uses);
  }
  const recurrence = periodAt(input.now, input.utcOffsetMinutes);
  const contextIds = [...new Set(recent.filter((fact) => fact.timeBucket >= input.now - RECOMMENDATION_LIMITS.cooccurrenceMs).map((fact) => fact.targetId))].sort(compare);
  const manualMetrics = [...byTarget].map(([targetId, runs]) => {
    const facts = [...runs.values()];
    const count7 = facts.filter((fact) => fact.timeBucket > input.now - 7 * DAY).length;
    const sameLocalPeriod = facts.filter((fact) => {
      const local = periodAt(fact.timeBucket, fact.utcOffsetMinutes);
      return local.period === recurrence.period && local.weekdayKind === recurrence.weekdayKind;
    }).length;
    return { targetId, count7, count30: facts.length, sameLocalPeriod };
  });
  const max7 = Math.max(1, ...manualMetrics.map((metric) => metric.count7));
  const max30 = Math.max(1, ...manualMetrics.map((metric) => metric.count30));
  // Pair history in a sliding 10-minute window; count at most one joint-use
  // day per target pair, so a batch/repeated click cannot amplify a scene.
  const pairs = new Map<string, Set<string>>();
  for (let i = 0; i < recent.length; i++) {
    const a = recent[i]!;
    for (let j = i + 1; j < recent.length; j++) {
      const b = recent[j]!;
      if (b.timeBucket - a.timeBucket > RECOMMENDATION_LIMITS.cooccurrenceMs) break;
      if (a.targetId === b.targetId) continue;
      const pairKey = [a.targetId, b.targetId].sort(compare).join('\u0000');
      const joint = pairs.get(pairKey) ?? new Set<string>();
      joint.add(String(Math.floor((b.timeBucket + b.utcOffsetMinutes * MINUTE) / DAY)));
      pairs.set(pairKey, joint);
    }
  }
  const pairedUses = (a: string, b: string): number => pairs.get([a, b].sort(compare).join('\u0000'))?.size ?? 0;
  const suggestions: LocalRecommendation[] = [];
  for (const metric of manualMetrics) {
    if (metric.count30 < RECOMMENDATION_LIMITS.minIndependentManualUses || contextIds.includes(metric.targetId)) continue;
    const pref = prefs.get(metric.targetId);
    if (pref?.permanentlyExcluded || (pref?.ignoredUntil !== undefined && pref.ignoredUntil !== null && pref.ignoredUntil > input.now)) continue;
    const target = eligible.get(metric.targetId)!;
    const related = contextIds.filter((other) => pairedUses(metric.targetId, other) > 0);
    const sharedUses = Math.max(0, ...related.map((other) => pairedUses(metric.targetId, other)));
    const frequency = 0.65 * metric.count7 / max7 + 0.35 * metric.count30 / max30;
    const periodRate = metric.sameLocalPeriod / metric.count30;
    const coUse = Math.min(1, sharedUses / metric.count30);
    const score = Math.round((related.length === 0 ? (0.5 * frequency + 0.3 * periodRate) / 0.8
      : 0.5 * frequency + 0.3 * periodRate + 0.2 * coUse) * 1000) / 1000;
    const frequentPartners = [...eligible.keys()].filter((other) => other !== metric.targetId && pairedUses(metric.targetId, other) >= 3
      && (byTarget.get(other)?.size ?? 0) >= RECOMMENDATION_LIMITS.minIndependentManualUses
      && !prefs.get(other)?.permanentlyExcluded && (prefs.get(other)?.ignoredUntil ?? 0) <= input.now)
      .sort((a, b) => pairedUses(metric.targetId, b) - pairedUses(metric.targetId, a) || compare(a, b)).slice(0, 3);
    suggestions.push({ targetId: metric.targetId, label: target.label, score,
      evidence: { count7: metric.count7, count30: metric.count30, sameLocalPeriod: metric.sameLocalPeriod,
        period: recurrence.period, weekdayKind: recurrence.weekdayKind, sharedUses, contextTargetIds: related },
      routineSuggestion: frequentPartners.length ? [metric.targetId, ...frequentPartners] : [] });
  }
  return suggestions.sort((a, b) => b.score - a.score || compare(a.targetId, b.targetId))
    .slice(0, RECOMMENDATION_LIMITS.perLocalDay - input.shownToday);
}
