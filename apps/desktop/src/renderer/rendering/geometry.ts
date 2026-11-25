import type { HitRegion, RenderPose } from './contract';

export interface Size { readonly w: number; readonly h: number }
export interface Point { readonly x: number; readonly y: number }
export interface NormalizedHitRegion {
  readonly id: string;
  readonly rect: readonly [number, number, number, number];
}

export interface ModelGeometry {
  /** CSS viewport clipping rectangle starts at (0, 0). */
  readonly viewport: Size;
  /** CSS-pixel anchor, including the pose translation. */
  readonly anchorCss: Point;
  /** Anchor in the resource's logical pixels. */
  readonly modelAnchor: Point;
  /** Positive CSS pixels per logical pixel, independent of DPR. */
  readonly scale: number;
  readonly facing: -1 | 1;
  readonly logicalSize: Size;
}

const finite = (value: number): boolean => Number.isFinite(value);
const positive = (value: number): boolean => finite(value) && value > 0;
const unit = (value: number): boolean => finite(value) && value >= 0 && value <= 1;

/**
 * Letterbox the logical model into a CSS viewport before applying the pose.
 * `pose.x/y` are CSS-pixel offsets from the fitted model's unposed anchor.
 * Scale and horizontal mirroring pivot around that anchor. This computation
 * deliberately contains no devicePixelRatio: hit testing stays in CSS space.
 * Zero-size or otherwise invalid surfaces fail closed instead of intercepting input.
 */
export function calculateModelGeometry(
  viewport: Size,
  logicalSize: Size,
  anchor: Point,
  pose: RenderPose,
): ModelGeometry | null {
  if (!positive(viewport.w) || !positive(viewport.h) || !positive(logicalSize.w) || !positive(logicalSize.h)
    || !unit(anchor.x) || !unit(anchor.y) || !finite(pose.x) || !finite(pose.y) || !positive(pose.scale)
    || (pose.facing !== 1 && pose.facing !== -1)) return null;

  const fit = Math.min(viewport.w / logicalSize.w, viewport.h / logicalSize.h);
  const modelAnchor = { x: logicalSize.w * anchor.x, y: logicalSize.h * anchor.y };
  const anchorCss = {
    x: (viewport.w - logicalSize.w * fit) / 2 + modelAnchor.x * fit + pose.x,
    y: (viewport.h - logicalSize.h * fit) / 2 + modelAnchor.y * fit + pose.y,
  };
  const scale = fit * pose.scale;
  if (!positive(scale) || !finite(anchorCss.x) || !finite(anchorCss.y)) return null;
  return { viewport: { ...viewport }, anchorCss, modelAnchor, scale, facing: pose.facing, logicalSize: { ...logicalSize } };
}

/** Logical model pixels -> CSS-local point; an adapter draws with this same pivot. */
export function modelToCss(geometry: ModelGeometry, point: Point): Point {
  return {
    x: geometry.anchorCss.x + (point.x - geometry.modelAnchor.x) * geometry.scale * geometry.facing,
    y: geometry.anchorCss.y + (point.y - geometry.modelAnchor.y) * geometry.scale,
  };
}

/** CSS-local point -> normalized model coordinates. The model bounds are half-open. */
export function cssToNormalizedModel(geometry: ModelGeometry, point: Point): Point | null {
  if (!finite(point.x) || !finite(point.y)) return null;
  const model = {
    x: (geometry.modelAnchor.x + (point.x - geometry.anchorCss.x) / (geometry.scale * geometry.facing)) / geometry.logicalSize.w,
    y: (geometry.modelAnchor.y + (point.y - geometry.anchorCss.y) / geometry.scale) / geometry.logicalSize.h,
  };
  return finite(model.x) && finite(model.y) && model.x >= 0 && model.x < 1 && model.y >= 0 && model.y < 1
    ? model : null;
}

/** First matching normalized region wins; no catch-all rectangle is synthesized. */
export function hitTestModel(
  geometry: ModelGeometry | null,
  point: Point,
  regions: readonly NormalizedHitRegion[],
): HitRegion | null {
  if (!geometry || !finite(point.x) || !finite(point.y) || point.x < 0 || point.y < 0
    || point.x >= geometry.viewport.w || point.y >= geometry.viewport.h) return null;
  const model = cssToNormalizedModel(geometry, point);
  if (!model) return null;
  for (const { id, rect: [x, y, w, h] } of regions) {
    if (!unit(x) || !unit(y) || !positive(w) || !positive(h) || x + w > 1 || y + h > 1) continue;
    if (model.x >= x && model.x < x + w && model.y >= y && model.y < y + h) return { id };
  }
  return null;
}

/** Physical backing-buffer dimensions only. Never use these for semantic hit testing. */
export function backingStoreSize(viewport: Size, dpr: number, resolutionScale = 1): Size | null {
  if (!positive(viewport.w) || !positive(viewport.h) || !positive(dpr) || !positive(resolutionScale)) return null;
  const factor = dpr * resolutionScale;
  const w = Math.max(1, Math.round(viewport.w * factor));
  const h = Math.max(1, Math.round(viewport.h * factor));
  // Conservative pet-surface allocation guard (at most 64 MiB of RGBA8 pixels).
  return Number.isSafeInteger(w) && Number.isSafeInteger(h) && w <= 8192 && h <= 8192 && w * h <= 16_777_216
    ? { w, h } : null;
}
