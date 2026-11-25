import { describe, expect, it } from 'vitest';
import { ActionController, semanticIdForActivity } from '../src/renderer/rendering/action-controller';
import type { ActionRequest } from '../src/renderer/rendering/contract';

function clip(...durationMs: number[]) {
  return { frames: durationMs.map((durationMs) => ({ durationMs })) };
}

function fixture() {
  return new ActionController({ neutral: clip(100, 200), pace: clip(70, 130), grin: clip(100, 150), nap: clip(200, 300) }, {
    idle: 'neutral', walk: 'pace', happy: 'grin', sleep: 'nap',
  });
}

function action(requestId: string, semanticId: string, priority = 10, loop = false): ActionRequest {
  return { requestId, semanticId, priority, loop, blendMs: 0 };
}

describe('renderer action timeline', () => {
  it('uses authored uneven frame durations with exclusive boundaries and wraparound', () => {
    const controller = fixture();
    expect(controller.current).toEqual({ semanticId: 'idle', clipId: 'neutral', frameIndex: 0,
      elapsedInFrameMs: 0, requestId: null, loop: true });
    controller.tick(0.099);
    expect(controller.current).toMatchObject({ frameIndex: 0, elapsedInFrameMs: 99 });
    controller.tick(0.001);
    expect(controller.current).toMatchObject({ frameIndex: 1, elapsedInFrameMs: 0 });
    controller.tick(0.199);
    expect(controller.current).toMatchObject({ frameIndex: 1, elapsedInFrameMs: 199 });
    controller.tick(0.001);
    expect(controller.current).toMatchObject({ frameIndex: 0, elapsedInFrameMs: 0 });
    controller.tick(0.6);
    expect(controller.current).toMatchObject({ frameIndex: 0, elapsedInFrameMs: 0 });
  });

  it('repeated authoritative projection does not restart the current base loop', () => {
    const controller = fixture();
    controller.setBaseAction('walk');
    controller.tick(0.08);
    controller.setBaseAction('walk');
    expect(controller.current).toMatchObject({ semanticId: 'walk', clipId: 'pace', frameIndex: 1, elapsedInFrameMs: 10 });
    controller.setBaseAction('sleep');
    expect(controller.current).toMatchObject({ semanticId: 'sleep', clipId: 'nap', frameIndex: 0, elapsedInFrameMs: 0 });
  });

  it('finishes a one-shot once and resumes the latest base, including tick remainder', async () => {
    const controller = fixture();
    controller.setBaseAction('walk');
    const happy = controller.play(action('tap-1', 'happy'));
    controller.tick(0.12);
    expect(controller.current).toMatchObject({ semanticId: 'happy', frameIndex: 1, requestId: 'tap-1' });
    controller.setBaseAction('sleep');
    expect(controller.current?.semanticId).toBe('happy');
    controller.tick(0.18); // 130ms to finish the one-shot, 50ms of sleep
    expect(await happy).toEqual({ requestId: 'tap-1', status: 'completed' });
    expect(controller.current).toMatchObject({ semanticId: 'sleep', frameIndex: 0, requestId: null });
    expect(controller.current?.elapsedInFrameMs).toBeCloseTo(50);
  });

  it('preserves the base phase while a one-shot temporarily overrides it', async () => {
    const controller = fixture();
    controller.setBaseAction('walk');
    controller.tick(0.075);
    const pending = controller.play(action('tap-2', 'happy'));
    controller.tick(0.25);
    expect(await pending).toMatchObject({ status: 'completed' });
    expect(controller.current).toMatchObject({ semanticId: 'walk', frameIndex: 1, elapsedInFrameMs: 5 });
  });

  it('does not let lower-priority requests interrupt; equal and greater priority supersede', async () => {
    const controller = fixture();
    const first = controller.play(action('a', 'happy', 3));
    expect(await controller.play(action('b', 'walk', 2))).toEqual({ requestId: 'b', status: 'interrupted' });
    expect(controller.current?.requestId).toBe('a');
    const next = controller.play(action('c', 'walk', 3));
    expect(await first).toEqual({ requestId: 'a', status: 'interrupted' });
    expect(controller.current?.requestId).toBe('c');
    const strongest = controller.play(action('d', 'sleep', 4));
    expect(await next).toEqual({ requestId: 'c', status: 'interrupted' });
    controller.tick(0.5);
    expect(await strongest).toEqual({ requestId: 'd', status: 'completed' });
  });

  it('runs loop overrides until matching-request cancellation or replacement', async () => {
    const controller = fixture();
    let settled = false;
    const loop = controller.play(action('loop', 'walk', 5, true));
    void loop.then(() => { settled = true; });
    controller.tick(43200.11);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(controller.current).toMatchObject({ requestId: 'loop', loop: true, frameIndex: 1 });
    expect(controller.cancel('stale')).toBe(false);
    expect(controller.cancel('loop')).toBe(true);
    expect(controller.cancel('loop')).toBe(false);
    expect(await loop).toEqual({ requestId: 'loop', status: 'interrupted' });
    expect(controller.current?.semanticId).toBe('idle');
  });

  it('pauses both base and transient ticks, then resumes without catch-up', async () => {
    const controller = fixture();
    controller.tick(0.15);
    const base = controller.current;
    controller.setPaused(true);
    controller.tick(1000000);
    expect(controller.current).toEqual(base);
    const pending = controller.play(action('paused', 'happy'));
    let settled = false;
    void pending.then(() => { settled = true; });
    controller.tick(1000000);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(controller.current).toMatchObject({ frameIndex: 0, elapsedInFrameMs: 0 });
    controller.setPaused(false);
    controller.tick(0.25);
    expect(await pending).toMatchObject({ status: 'completed' });
    expect(controller.current).toEqual(base);
  });

  it('de-duplicates requestId and never replays a previously interrupted request', async () => {
    const controller = fixture();
    const request = action('duplicate', 'happy');
    const first = controller.play(request);
    controller.tick(0.11);
    expect(controller.play(request)).toBe(first);
    expect(controller.current?.frameIndex).toBe(1);
    const replacement = controller.play(action('replacement', 'sleep', 11));
    expect(await first).toMatchObject({ status: 'interrupted' });
    expect(controller.play({ ...request, priority: 999 })).toBe(first);
    expect(controller.cancel('duplicate')).toBe(false);
    expect(controller.current?.requestId).toBe('replacement');
    controller.tick(0.5);
    expect(await replacement).toMatchObject({ status: 'completed' });
  });

  it('has a bounded idle fallback for unknown semantics, even when loop was requested', async () => {
    const controller = fixture();
    controller.setBaseAction('nonexistent');
    expect(controller.current?.semanticId).toBe('idle');
    controller.setBaseAction('sleep');
    const missing = controller.play(action('missing', 'unknown.action', 4, true));
    expect(controller.current).toMatchObject({ semanticId: 'idle', clipId: 'neutral', loop: false });
    controller.tick(0.3);
    expect(await missing).toEqual({ requestId: 'missing', status: 'unsupported' });
    expect(controller.current?.semanticId).toBe('sleep');
  });

  it('invalid time inputs do not change playback, and huge finite deltas stay bounded', async () => {
    const controller = fixture();
    const before = controller.current;
    for (const dt of [0, -5, -Infinity, Infinity, NaN]) controller.tick(dt);
    expect(controller.current).toEqual(before);
    const pending = controller.play(action('huge', 'happy'));
    controller.tick(Number.MAX_VALUE);
    expect(await pending).toMatchObject({ status: 'completed' });
    expect(controller.current?.semanticId).toBe('idle');
    expect([0, 1]).toContain(controller.current?.frameIndex);
    expect(Number.isFinite(controller.current?.elapsedInFrameMs)).toBe(true);
    expect(controller.current!.elapsedInFrameMs).toBeGreaterThanOrEqual(0);
  });

  it('validates durations, idle and clip references and ignores malformed visual requests', async () => {
    expect(() => new ActionController({ empty: clip() }, { idle: 'empty' })).toThrow();
    for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new ActionController({ invalid: clip(bad) }, { idle: 'invalid' })).toThrow();
    }
    expect(() => new ActionController({ neutral: clip(100) }, { idle: 'missing' })).toThrow();
    expect(() => new ActionController({ neutral: clip(100) }, { walk: 'neutral' })).toThrow();
    const controller = fixture();
    const pending = controller.play(action('good', 'happy'));
    expect(await controller.play(action('bad', 'sleep', NaN))).toEqual({ requestId: 'bad', status: 'failed' });
    expect(await controller.play({ ...action('bad2', 'happy'), blendMs: -10 })).toMatchObject({ status: 'failed' });
    expect(controller.current?.requestId).toBe('good');
    controller.tick(0.25);
    expect(await pending).toMatchObject({ status: 'completed' });
  });

  it('isolates instances and takes a copy of the timing and semantic definitions', () => {
    const authored = clip(100, 200);
    const clips = { neutral: authored };
    const mappings = { idle: 'neutral' };
    const left = new ActionController(clips, mappings);
    const right = new ActionController(clips, mappings);
    authored.frames[0]!.durationMs = 20000;
    mappings.idle = 'missing';
    left.tick(0.1);
    expect(left.current).toMatchObject({ frameIndex: 1, elapsedInFrameMs: 0 });
    expect(right.current).toMatchObject({ frameIndex: 0, elapsedInFrameMs: 0 });
  });

  it('destruction settles an active request and renders future requests inert', async () => {
    const controller = fixture();
    const pending = controller.play(action('destroy', 'happy', 2, true));
    let completions = 0;
    void pending.then(() => { completions += 1; });
    controller.destroy();
    controller.destroy();
    controller.tick(2);
    controller.setBaseAction('sleep');
    expect(await pending).toEqual({ requestId: 'destroy', status: 'interrupted' });
    expect(completions).toBe(1);
    expect(controller.current).toBeNull();
    expect(await controller.play(action('later', 'walk'))).toMatchObject({ status: 'failed' });
  });

  it('maps authoritative activities to visual request names without defining gameplay', () => {
    expect(semanticIdForActivity(null)).toBe('idle');
    expect(semanticIdForActivity('IDLE')).toBe('idle');
    expect(semanticIdForActivity('WALK')).toBe('walk');
    expect(semanticIdForActivity('DRAG')).toBe('drag');
    expect(semanticIdForActivity('INTERACT')).toBe('happy');
    expect(semanticIdForActivity('CHAT')).toBe('talk');
    expect(semanticIdForActivity('EAT')).toBe('eat');
    expect(semanticIdForActivity('REST')).toBe('sleep');
    expect(semanticIdForActivity('SLEEP')).toBe('sleep');
    expect(semanticIdForActivity('CELEBRATE')).toBe('celebrate');
  });
});
