import { describe, expect, it } from 'vitest';
import { canContinueWindowWalk, createWindowWalkPlan, walkPositionAt } from '../src/main/walk-window-policy';

const area = { x: -1920, y: -100, width: 1920, height: 1000 };
const bounds = { x: -500, y: 600, width: 260, height: 295 };

describe('bounded native companion walking (DIP only)', () => {
  it('uses a deterministic, small displacement in a negative-coordinate display', () => {
    const plan = createWindowWalkPlan(bounds, area, -1, 100)!;
    expect(plan.targetX).toBe(-596);
    expect(plan.durationMs).toBe(4000);
    expect(walkPositionAt(plan, 2100)).toEqual({ position: { x: -548, y: 600 }, done: false });
    expect(walkPositionAt(plan, 5100)).toEqual({ position: { x: -596, y: 600 }, done: true });
  });
  it('reverses away from an edge rather than moving off-screen', () => {
    const edge = { ...bounds, x: area.x };
    const plan = createWindowWalkPlan(edge, area, -1, 0)!;
    expect(plan.targetX).toBe(area.x + 96);
  });
  it('declines to move if the area is too narrow or bounds need reflow', () => {
    expect(createWindowWalkPlan({ ...bounds, x: 0, width: 260 }, { x: 0, y: 0, width: 260, height: 1000 }, 1, 0)).toBeNull();
    expect(createWindowWalkPlan({ ...bounds, x: 100 }, area, 1, 0)).toBeNull();
    expect(createWindowWalkPlan(bounds, area, 1, Number.NaN)).toBeNull();
  });
  it('clamps a backward clock and never overshoots', () => {
    const plan = createWindowWalkPlan(bounds, area, 1, 100)!;
    expect(walkPositionAt(plan, 1)).toEqual({ position: { x: -500, y: 600 }, done: false });
    expect(walkPositionAt(plan, Number.NaN)).toEqual({ position: { x: -500, y: 600 }, done: true });
    expect(walkPositionAt(plan, 100000).done).toBe(true);
  });
  it('cancels when the user moves the window, approaches its input area or changes display geometry', () => {
    const plan = createWindowWalkPlan(bounds, area, 1, 0)!;
    const expected = { x: bounds.x, y: bounds.y };
    const far = { x: -1700, y: 10 };
    expect(canContinueWindowWalk(plan, bounds, expected, area, far)).toBe(true);
    expect(canContinueWindowWalk(plan, { ...bounds, x: bounds.x + 10 }, expected, area, far)).toBe(false);
    expect(canContinueWindowWalk(plan, bounds, expected, area, { x: bounds.x - 5, y: bounds.y })).toBe(false);
    expect(canContinueWindowWalk(plan, bounds, expected, { ...area, width: 1600 }, far)).toBe(false);
    expect(canContinueWindowWalk(plan, bounds, expected, area, { x: NaN, y: 0 })).toBe(false);
  });
  it('does not move under a cursor in the swept destination after a delayed timer', () => {
    const plan = createWindowWalkPlan(bounds, area, -1, 0)!;
    const expected = { x: bounds.x, y: bounds.y };
    const cursor = { x: -570, y: 700 };
    expect(canContinueWindowWalk(plan, bounds, expected, area, cursor)).toBe(true);
    expect(canContinueWindowWalk(plan, bounds, expected, area, cursor, walkPositionAt(plan, 5000).position)).toBe(false);
  });
});
