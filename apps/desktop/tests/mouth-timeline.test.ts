import { describe, expect, it } from 'vitest';
import type { MouthSample } from '../src/renderer/rendering/contract';
import { MouthTimeline } from '../src/renderer/rendering/mouth-timeline';

const sample = (generation: number, atMs: number, open: number, viseme?: string): MouthSample => (
  { generation, atMs, open, ...(viseme === undefined ? {} : { viseme }) }
);

describe('audio-position mouth timeline', () => {
  it('has no motion or accepts samples until an explicit audio generation starts', () => {
    const timeline = new MouthTimeline();
    expect(timeline.current).toEqual({ open: 0 });
    expect(timeline.push(sample(0, 0, 0.9))).toBe(false);
    expect(timeline.sampleAt(10)).toEqual({ open: 0 });
    expect(timeline.begin(0)).toBe(true);
    expect(timeline.current).toEqual({ open: 0 });
  });

  it('consumes samples at external audio positions without reading ahead', () => {
    const timeline = new MouthTimeline({ smoothingMs: 0 });
    timeline.begin(1);
    expect(timeline.push(sample(1, 100, 0.2))).toBe(true);
    expect(timeline.push(sample(1, 160, 0.8, 'aa'))).toBe(true);
    expect(timeline.sampleAt(99)).toEqual({ open: 0 });
    expect(timeline.sampleAt(100)).toEqual({ open: 0.2 });
    expect(timeline.sampleAt(159)).toEqual({ open: 0.2 });
    expect(timeline.sampleAt(160)).toEqual({ open: 0.8, viseme: 'aa' });
  });

  it('rejects both old and unannounced future generations, resetting on a newer begin', () => {
    const timeline = new MouthTimeline();
    timeline.begin(3);
    timeline.push(sample(3, 0, 1, 'aa'));
    expect(timeline.sampleAt(0)).toEqual({ open: 1, viseme: 'aa' });
    expect(timeline.push(sample(4, 10, 1))).toBe(false);
    expect(timeline.begin(4)).toBe(true);
    expect(timeline.current).toEqual({ open: 0 });
    expect(timeline.push(sample(3, 10, 1))).toBe(false);
    expect(timeline.begin(3)).toBe(false);
    expect(timeline.begin(4)).toBe(false);
    expect(timeline.push(sample(4, 0, 0.5))).toBe(true);
    expect(timeline.sampleAt(0)).toEqual({ open: 0.5 });
  });

  it('expires old held samples and never reopens from a backwards clock', () => {
    const timeline = new MouthTimeline({ expiryMs: 100, smoothingMs: 0 });
    timeline.begin(1);
    timeline.push(sample(1, 20, 0.9, 'aa'));
    expect(timeline.sampleAt(119)).toEqual({ open: 0.9, viseme: 'aa' });
    expect(timeline.sampleAt(120)).toEqual({ open: 0 });
    expect(timeline.sampleAt(20)).toEqual({ open: 0 });
    expect(timeline.sampleAt(122)).toEqual({ open: 0 });
    expect(timeline.push(sample(1, 100, 0.5))).toBe(false);
  });

  it('drops duplicate, out-of-order and late samples', () => {
    const timeline = new MouthTimeline({ smoothingMs: 0 });
    timeline.begin(1);
    expect(timeline.push(sample(1, 30, 0.3))).toBe(true);
    expect(timeline.push(sample(1, 30, 1))).toBe(false);
    expect(timeline.push(sample(1, 10, 1))).toBe(false);
    timeline.sampleAt(40);
    expect(timeline.push(sample(1, 35, 1))).toBe(false);
    expect(timeline.push(sample(1, 40, 0.6))).toBe(true);
    expect(timeline.sampleAt(40)).toEqual({ open: 0.6 });
  });

  it('bounds future samples and preserves earlier queued content', () => {
    const timeline = new MouthTimeline({ maxSamples: 2, smoothingMs: 0 });
    timeline.begin(1);
    expect(timeline.push(sample(1, 100, 0.3))).toBe(true);
    expect(timeline.push(sample(1, 150, 0.4))).toBe(true);
    expect(timeline.push(sample(1, 200, 0.5))).toBe(false);
    expect(timeline.sampleAt(100)).toEqual({ open: 0.3 });
    expect(timeline.push(sample(1, 200, 0.5))).toBe(true);
    expect(timeline.sampleAt(150)).toEqual({ open: 0.4 });
    expect(timeline.sampleAt(200)).toEqual({ open: 0.5 });
  });

  it('smooths a transition on audio clock time, not on the number of calls', () => {
    const timeline = new MouthTimeline({ smoothingMs: 40 });
    timeline.begin(1);
    timeline.push(sample(1, 0, 0));
    timeline.push(sample(1, 20, 1, 'aa'));
    expect(timeline.sampleAt(0)).toEqual({ open: 0 });
    expect(timeline.sampleAt(20)).toEqual({ open: 0, viseme: 'aa' });
    expect(timeline.sampleAt(40)).toEqual({ open: 0.5, viseme: 'aa' });
    expect(timeline.sampleAt(40)).toEqual({ open: 0.5, viseme: 'aa' });
    expect(timeline.sampleAt(60)).toEqual({ open: 1, viseme: 'aa' });
  });

  it('is invariant to sparse or dense rendering of the same sample sequence', () => {
    const start = () => {
      const timeline = new MouthTimeline({ smoothingMs: 40 });
      timeline.begin(1);
      timeline.push(sample(1, 0, 0));
      timeline.push(sample(1, 20, 1));
      timeline.push(sample(1, 40, 0.2));
      return timeline;
    };
    const sparse = start();
    const dense = start();
    for (const time of [0, 10, 20, 30, 40, 50]) dense.sampleAt(time);
    expect(dense.sampleAt(60)).toEqual(sparse.sampleAt(60));
    expect(dense.sampleAt(60).open).toBeCloseTo(0.35);
  });

  it('pause immediately closes the mouth, discards queued motion, and resumes with fresh samples only', () => {
    const timeline = new MouthTimeline({ smoothingMs: 0 });
    timeline.begin(1);
    timeline.push(sample(1, 0, 1));
    timeline.push(sample(1, 40, 0.8));
    expect(timeline.sampleAt(0)).toEqual({ open: 1 });
    timeline.pause();
    expect(timeline.current).toEqual({ open: 0 });
    expect(timeline.push(sample(1, 60, 1))).toBe(false);
    expect(timeline.sampleAt(10)).toEqual({ open: 0 });
    timeline.resume();
    expect(timeline.sampleAt(40)).toEqual({ open: 0 });
    expect(timeline.push(sample(1, 39, 0.6))).toBe(false);
    expect(timeline.push(sample(1, 40, 0.6))).toBe(true);
    expect(timeline.sampleAt(40)).toEqual({ open: 0.6 });
    expect(timeline.push(sample(1, 50, 0.6))).toBe(true);
    expect(timeline.sampleAt(50)).toEqual({ open: 0.6 });
  });

  it('cancel and terminal close prevent delayed audio messages from moving the mouth', () => {
    const timeline = new MouthTimeline({ smoothingMs: 0 });
    timeline.begin(1);
    timeline.push(sample(1, 0, 1));
    timeline.sampleAt(0);
    timeline.cancel();
    expect(timeline.current).toEqual({ open: 0 });
    expect(timeline.push(sample(1, 10, 1))).toBe(false);
    expect(timeline.begin(1)).toBe(false);
    expect(timeline.begin(2)).toBe(true);
    timeline.push(sample(2, 0, 1));
    timeline.sampleAt(0);
    timeline.close();
    expect(timeline.current).toEqual({ open: 0 });
    expect(timeline.begin(3)).toBe(false);
    timeline.resume();
    expect(timeline.push(sample(3, 0, 1))).toBe(false);
    expect(timeline.sampleAt(50)).toEqual({ open: 0 });
  });

  it('rejects malformed samples, generations, and positions without mutating accepted content', () => {
    const timeline = new MouthTimeline();
    expect(timeline.begin(1.2)).toBe(false);
    expect(timeline.begin(-1)).toBe(false);
    expect(timeline.begin(1)).toBe(true);
    for (const invalid of [sample(1, -1, 0.5), sample(1, NaN, 0.5), sample(1, Infinity, 0.5), sample(1, 0, -0.1),
      sample(1, 0, 1.1), sample(1, 0, NaN), sample(1, 0, 1, ''), sample(1, 0, 1, 'a'.repeat(65))]) {
      expect(timeline.push(invalid)).toBe(false);
    }
    expect(timeline.push(sample(1, 0, 0.5))).toBe(true);
    expect(timeline.sampleAt(Infinity)).toEqual({ open: 0 });
    expect(timeline.sampleAt(0)).toEqual({ open: 0.5 });
  });

  it('keeps the producer object and exposed current pose isolated from internal state', () => {
    const timeline = new MouthTimeline();
    timeline.begin(1);
    const mutable = sample(1, 0, 0.4);
    expect(timeline.push(mutable)).toBe(true);
    (mutable as { open: number }).open = 1;
    expect(timeline.sampleAt(0)).toEqual({ open: 0.4 });
    const result = timeline.current as { open: number };
    result.open = 1;
    expect(timeline.current).toEqual({ open: 0.4 });
  });

  it('fails early on unbounded or nonsensical queue options', () => {
    expect(() => new MouthTimeline({ maxSamples: 100_000 })).toThrow(RangeError);
    expect(() => new MouthTimeline({ expiryMs: 0 })).toThrow(RangeError);
    expect(() => new MouthTimeline({ smoothingMs: -1 })).toThrow(RangeError);
  });
});
