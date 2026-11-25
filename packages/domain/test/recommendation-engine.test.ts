import { describe, expect, it } from 'vitest';
import { recommendTargets } from '../src/recommendation-engine.js';
import type { LaunchHistoryFact, RecommendableTarget, RecommendInput } from '../src/recommendation-engine.js';

const day = 86_400_000, minute = 60_000;
const now = Date.parse('2026-11-25T02:00:00Z'); // Wednesday 10:00 at UTC+8
const target = (targetId: string): RecommendableTarget => ({ targetId, label: targetId, enabled: true, approved: true, recommendable: true });
const launch = (targetId: string, runId: string, timeBucket: number, extra: Partial<LaunchHistoryFact> = {}): LaunchHistoryFact =>
  ({ targetId, runId, timeBucket, source: 'MANUAL', outcome: 'ACCEPTED', utcOffsetMinutes: 480, ...extra });
const inputs = (history: LaunchHistoryFact[], extra: Partial<RecommendInput> = {}): RecommendInput => ({ enabled: true, now, utcOffsetMinutes: 480,
  retentionDays: 30, targets: [target('editor'), target('music'), target('browser')], history, preferences: [], shownToday: 0, ...extra });
const repeated = (id: string, times: number[], offset = 0) => times.map((days, index) => launch(id, `${id}-${index}`, now - days * day + offset));

describe('opt-in local usage recommendation', () => {
  it('does not read history at all when consent is off, and does not recommend cold starts', () => {
    expect(recommendTargets(inputs([], { enabled: false, history: null as unknown as LaunchHistoryFact[] }))).toEqual([]);
    expect(recommendTargets(inputs(repeated('editor', [1, 2])))).toEqual([]);
  });
  it('requires three distinct manually accepted in-app uses, excludes failed/batch/suggestion receipts', () => {
    const twice = repeated('editor', [1, 2]);
    const extras = [launch('editor', 'batch', now - 3 * day, { source: 'ROUTINE' }), launch('editor', 'recommended', now - 4 * day, { source: 'SUGGESTION' }),
      launch('editor', 'failed', now - 5 * day, { outcome: 'FAILED' }), twice[0]!];
    expect(recommendTargets(inputs([...twice, ...extras]))).toEqual([]);
    expect(recommendTargets(inputs([...twice, ...extras, launch('editor', 'third', now - 6 * day)]))[0]?.evidence.count30).toBe(3);
  });
  it('uses truthful 7/30-day counts and local weekday/time periods', () => {
    const suggestions = recommendTargets(inputs(repeated('editor', [1, 2, 7, 10, 15, 31])));
    expect(suggestions[0]?.evidence).toMatchObject({ count7: 2, count30: 5, weekdayKind: 'WEEKDAY', period: 'MORNING', sameLocalPeriod: 4 });
    const shorter = recommendTargets(inputs(repeated('editor', [1, 2, 3, 10]), { retentionDays: 7 }));
    expect(shorter[0]?.evidence.count30).toBe(3);
  });
  it('stores local time semantics per fact instead of rewriting prior time zones', () => {
    const history = repeated('editor', [1, 2, 7]).map(fact => ({ ...fact, utcOffsetMinutes: -480 }));
    expect(recommendTargets(inputs(history))[0]?.evidence.sameLocalPeriod).toBe(0);
  });
  it('limits daily impressions, respects ignored/permanent-disabled and unapproved targets', () => {
    const history = [...repeated('editor', [1, 2, 3]), ...repeated('browser', [1, 2, 3]), ...repeated('music', [1, 2, 3])];
    expect(recommendTargets(inputs(history, { shownToday: 2 }))).toEqual([]);
    expect(recommendTargets(inputs(history, { shownToday: 1 }))).toHaveLength(1);
    expect(recommendTargets(inputs(history, { targets: [target('editor'), { ...target('browser'), approved: false }, target('music')],
      preferences: [{ targetId: 'editor', ignoredUntil: now + day, permanentlyExcluded: false }, { targetId: 'music', ignoredUntil: null, permanentlyExcluded: true }] }))).toEqual([]);
  });
  it('lets the user create a repeated co-use routine with approved stable target IDs only', () => {
    const history = [...repeated('editor', [1, 2, 7]), ...repeated('music', [1, 2, 7], 5 * minute)];
    const list = recommendTargets(inputs(history));
    expect(list.find(row => row.targetId === 'editor')?.routineSuggestion).toEqual(['editor', 'music']);
    const recent = [...history, launch('music', 'current', now)];
    const recommendation = recommendTargets(inputs(recent))[0]!;
    expect(recommendation.targetId).toBe('editor');
    expect(recommendation.evidence.contextTargetIds).toEqual(['music']);
    expect(recommendation.evidence.sharedUses).toBe(3);
  });
  it('one click burst or batch on one day cannot manufacture a recurring routine', () => {
    const history = Array.from({ length: 5 }, (_, index) => [launch('editor', `ed-${index}`, now - day), launch('music', `mu-${index}`, now - day + 5 * minute)]).flat();
    expect(recommendTargets(inputs(history)).every(row => row.routineSuggestion.length === 0)).toBe(true);
  });
  it('is independent of source iteration order, tie breaks by stable target ID; never suggests recently opened targets', () => {
    const history = [...repeated('editor', [1, 2, 7]), ...repeated('browser', [1, 2, 7]), ...repeated('music', [1, 2, 7])];
    expect(recommendTargets(inputs(history))).toEqual(recommendTargets(inputs([...history].reverse(), { targets: [...inputs([]).targets].reverse() })));
    expect(recommendTargets(inputs(history)).map(row => row.targetId)).toEqual(['browser', 'editor']);
    expect(recommendTargets(inputs([...history, launch('browser', 'current', now)] )).map(row => row.targetId)).not.toContain('browser');
  });
  it('rejects malformed, duplicate authority metadata and unbounded history; future events do not count', () => {
    expect(() => recommendTargets(inputs([], { targets: [target('editor'), target('editor')] }))).toThrow();
    expect(() => recommendTargets(inputs([launch('editor', 'bad', now + 1)]))).toThrow();
    expect(() => recommendTargets(inputs(Array.from({ length: 1001 }, () => launch('editor', 'same', now))))).toThrow();
    expect(recommendTargets(inputs([...repeated('editor', [1, 2]), launch('editor', 'future', now + day)]))).toEqual([]);
  });
});
