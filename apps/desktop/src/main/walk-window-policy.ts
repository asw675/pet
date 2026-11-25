import { clampBounds, isCursorInBounds } from './window-policy';
import type { Bounds, Point } from './window-policy';

export interface WindowWalkPlan {
  readonly origin: Bounds;
  readonly area: Bounds;
  readonly targetX: number;
  readonly startedAt: number;
  readonly durationMs: number;
}

const maxDistance = 96; // DIP, never a whole-desktop sweep
const minimumDistance = 12;
const speed = 24; // DIP/sec

/** Plan only a small horizontal displacement inside the current display work
 * area. Main owns native geometry; no coordinates originate from an action or
 * AI renderer request. */
export function createWindowWalkPlan(bounds: Bounds, area: Bounds, preferred: -1 | 1, now: number): WindowWalkPlan | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, area.x, area.y, area.width, area.height, now].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || area.width <= 0 || area.height <= 0 || now < 0 || (preferred !== -1 && preferred !== 1)) return null;
  const origin = clampBounds(bounds, area);
  if (origin.x !== bounds.x || origin.y !== bounds.y || origin.width !== bounds.width || origin.height !== bounds.height) return null;
  const left = Math.max(0, origin.x - area.x);
  const right = Math.max(0, area.x + area.width - origin.width - origin.x);
  const available = preferred === 1 ? right : left;
  const other = preferred === 1 ? left : right;
  const direction = available >= minimumDistance ? preferred : -preferred;
  const distance = Math.min(maxDistance, available >= minimumDistance ? available : other);
  if (distance < minimumDistance) return null;
  return { origin: { ...origin }, area: { ...area }, targetX: origin.x + direction * distance,
    startedAt: now, durationMs: distance * 1000 / speed };
}

export function walkPositionAt(plan: WindowWalkPlan, now: number): { position: Point; done: boolean } {
  if (!Number.isFinite(now)) return { position: { x: plan.origin.x, y: plan.origin.y }, done: true };
  const elapsed = Math.max(0, now - plan.startedAt);
  const progress = Math.min(1, elapsed / plan.durationMs);
  const x = Math.round(plan.origin.x + (plan.targetX - plan.origin.x) * progress);
  const bounded = clampBounds({ ...plan.origin, x }, plan.area);
  return { position: { x: bounded.x, y: bounded.y }, done: progress >= 1 };
}

/** Stop if a user moved the window, cursor is near it, or the display/layout
 * changed. A new idle/walk activity can make a new plan later; do not chase. */
export function canContinueWindowWalk(plan: WindowWalkPlan, current: Bounds, expected: Point, area: Bounds, cursor: Point, next: Point = expected): boolean {
  if (![current.x, current.y, expected.x, expected.y, cursor.x, cursor.y].every(Number.isFinite)
    || current.width !== plan.origin.width || current.height !== plan.origin.height
    || Math.abs(current.x - expected.x) > 2 || Math.abs(current.y - expected.y) > 2
    || area.x !== plan.area.x || area.y !== plan.area.y || area.width !== plan.area.width || area.height !== plan.area.height) return false;
  if (!Number.isFinite(next.x) || next.y !== current.y || next.x < area.x || next.x + current.width > area.x + area.width) return false;
  const margin = 12;
  // Test the entire swept rectangle, including a delayed timer's destination.
  return !isCursorInBounds(cursor, { x: Math.min(current.x, next.x) - margin, y: current.y - margin,
    width: current.width + Math.abs(next.x - current.x) + margin * 2, height: current.height + margin * 2 });
}
