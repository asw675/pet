import { describe, expect, it } from 'vitest';
import type { RenderPose } from '../src/renderer/rendering/contract';
import {
  backingStoreSize, calculateModelGeometry, cssToNormalizedModel, hitTestModel, modelToCss,
} from '../src/renderer/rendering/geometry';

const neutral: RenderPose = { x: 0, y: 0, scale: 1, facing: 1 };
const logical = { w: 100, h: 200 };
const anchor = { x: 0.5, y: 1 };
const viewport = { w: 400, h: 300 };
const regions = [
  { id: 'head', rect: [0.25, 0.1, 0.5, 0.3] as const },
  { id: 'body', rect: [0.1, 0.3, 0.8, 0.6] as const },
];

describe('CSS-local character rendering geometry', () => {
  it('contains and centers the model in a horizontal letterbox', () => {
    const geometry = calculateModelGeometry(viewport, logical, anchor, neutral)!;
    expect(geometry.scale).toBe(1.5);
    expect(geometry.anchorCss).toEqual({ x: 200, y: 300 });
    expect(modelToCss(geometry, { x: 0, y: 0 })).toEqual({ x: 125, y: 0 });
    expect(modelToCss(geometry, { x: 100, y: 200 })).toEqual({ x: 275, y: 300 });
    expect(hitTestModel(geometry, { x: 100, y: 150 }, regions)).toBeNull();
    expect(cssToNormalizedModel(geometry, { x: 300, y: 200 })).toBeNull();
  });

  it('contains the model vertically and preserves a noncenter anchor', () => {
    const geometry = calculateModelGeometry({ w: 100, h: 300 }, { w: 200, h: 100 }, { x: 0.25, y: 0.2 }, neutral)!;
    expect(geometry.scale).toBe(0.5);
    expect(geometry.anchorCss).toEqual({ x: 25, y: 135 });
    expect(modelToCss(geometry, { x: 0, y: 0 })).toEqual({ x: 0, y: 125 });
  });

  it('pivots scaling around the fitted anchor, then offsets in CSS pixels', () => {
    const geometry = calculateModelGeometry(viewport, logical, anchor, { ...neutral, x: -30, y: 20, scale: 0.5 })!;
    expect(geometry.anchorCss).toEqual({ x: 170, y: 320 });
    expect(geometry.scale).toBe(0.75);
    const point = modelToCss(geometry, { x: 50, y: 20 });
    expect(point).toEqual({ x: 170, y: 185 });
    expect(hitTestModel(geometry, point, regions)).toEqual({ id: 'head' });
  });

  it('mirrors horizontally around a noncenter anchor, not around the canvas center', () => {
    const normal = calculateModelGeometry({ w: 200, h: 200 }, { w: 100, h: 100 }, { x: 0.25, y: 0.5 }, neutral)!;
    const mirrored = calculateModelGeometry({ w: 200, h: 200 }, { w: 100, h: 100 }, { x: 0.25, y: 0.5 }, { ...neutral, facing: -1 })!;
    expect(mirrored.anchorCss).toEqual(normal.anchorCss);
    expect(modelToCss(normal, { x: 50, y: 20 })).toEqual({ x: 100, y: 40 });
    expect(modelToCss(mirrored, { x: 50, y: 20 })).toEqual({ x: 0, y: 40 });
    expect(cssToNormalizedModel(mirrored, { x: 0, y: 40 })).toEqual({ x: 0.5, y: 0.2 });
  });

  it('round-trips multiple logical positions under offset and fractional scale', () => {
    for (const facing of [1, -1] as const) {
      const geometry = calculateModelGeometry(viewport, logical, { x: 0.27, y: 0.83 }, { x: 10, y: -12, scale: 1.23, facing })!;
      for (const point of [{ x: 1, y: 1 }, { x: 50, y: 100 }, { x: 99, y: 199 }]) {
        const normalized = cssToNormalizedModel(geometry, modelToCss(geometry, point));
        expect(normalized?.x).toBeCloseTo(point.x / logical.w, 10);
        expect(normalized?.y).toBeCloseTo(point.y / logical.h, 10);
      }
    }
  });

  it('uses manifest order for overlapping regions and does not synthesize a body region', () => {
    const geometry = calculateModelGeometry(viewport, logical, anchor, neutral)!;
    const overlap = modelToCss(geometry, { x: 50, y: 70 });
    expect(hitTestModel(geometry, overlap, regions)).toEqual({ id: 'head' });
    expect(hitTestModel(geometry, overlap, [...regions].reverse())).toEqual({ id: 'body' });
    expect(hitTestModel(geometry, modelToCss(geometry, { x: 5, y: 5 }), regions)).toBeNull();
    expect(hitTestModel(geometry, overlap, [])).toBeNull();
  });

  it('includes left/top but excludes right/bottom edges in model and region coordinates', () => {
    const geometry = calculateModelGeometry({ w: 100, h: 100 }, { w: 100, h: 100 }, { x: 0, y: 0 }, neutral)!;
    const square = [{ id: 'half', rect: [0, 0, 0.5, 0.5] as const }];
    expect(cssToNormalizedModel(geometry, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(hitTestModel(geometry, { x: 0, y: 0 }, square)).toEqual({ id: 'half' });
    expect(hitTestModel(geometry, { x: 50, y: 0 }, square)).toBeNull();
    expect(hitTestModel(geometry, { x: 0, y: 50 }, square)).toBeNull();
    expect(cssToNormalizedModel(geometry, { x: 100, y: 25 })).toBeNull();
    expect(cssToNormalizedModel(geometry, { x: 25, y: 100 })).toBeNull();
  });

  it('keeps CSS hit coordinates identical at 100, 150 and 200 percent DPR', () => {
    const geometry = calculateModelGeometry(viewport, logical, anchor, neutral)!;
    const point = modelToCss(geometry, { x: 50, y: 30 });
    for (const dpr of [1, 1.5, 2]) {
      expect(backingStoreSize(viewport, dpr)).toEqual({ w: 400 * dpr, h: 300 * dpr });
      expect(hitTestModel(geometry, point, regions)).toEqual({ id: 'head' });
    }
    expect(backingStoreSize(viewport, 2, 0.5)).toEqual(viewport);
    expect(backingStoreSize({ w: 101.5, h: 99.2 }, 1.5)).toEqual({ w: 152, h: 149 });
  });

  it('fails closed for zero, invalid and overflowed geometry or buffers', () => {
    expect(calculateModelGeometry({ w: 0, h: 300 }, logical, anchor, neutral)).toBeNull();
    expect(calculateModelGeometry(viewport, { w: Infinity, h: 1 }, anchor, neutral)).toBeNull();
    expect(calculateModelGeometry(viewport, logical, { x: 1.1, y: 0 }, neutral)).toBeNull();
    expect(calculateModelGeometry(viewport, logical, anchor, { ...neutral, scale: 0 })).toBeNull();
    expect(calculateModelGeometry(viewport, logical, anchor, { ...neutral, x: NaN })).toBeNull();
    expect(hitTestModel(null, { x: 100, y: 100 }, regions)).toBeNull();
    expect(backingStoreSize(viewport, NaN)).toBeNull();
    expect(backingStoreSize(viewport, Number.MAX_VALUE)).toBeNull();
    expect(backingStoreSize({ w: 10_000, h: 1 }, 1)).toBeNull();
  });

  it('never accepts a hit beyond the actual canvas when an expanded model is clipped', () => {
    const geometry = calculateModelGeometry({ w: 100, h: 100 }, { w: 100, h: 100 }, { x: 0.5, y: 0.5 }, { ...neutral, scale: 2 })!;
    const full = [{ id: 'model', rect: [0, 0, 1, 1] as const }];
    expect(cssToNormalizedModel(geometry, { x: -5, y: 50 })).not.toBeNull();
    expect(hitTestModel(geometry, { x: -5, y: 50 }, full)).toBeNull();
    expect(hitTestModel(geometry, { x: 50, y: 50 }, full)).toEqual({ id: 'model' });
  });

  it('ignores malformed regions and invalid coordinates instead of intercepting canvas input', () => {
    const geometry = calculateModelGeometry(viewport, logical, anchor, neutral)!;
    const point = modelToCss(geometry, { x: 50, y: 50 });
    const malformed = [{ id: 'invalid-full', rect: [-1, -1, 5, 5] as const }];
    expect(hitTestModel(geometry, point, malformed)).toBeNull();
    expect(hitTestModel(geometry, { x: NaN, y: 0 }, regions)).toBeNull();
  });
});
