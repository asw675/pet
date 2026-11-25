import { describe, expect, it, vi } from 'vitest';
import { AdaptiveRendererHost, type RenderBackend, type VisualRenderer } from '../src/renderer/rendering/adaptive-renderer-host';
import { CubismRenderer } from '../src/renderer/rendering/cubism-renderer';
import type { CubismRuntime, CubismSession } from '../src/renderer/rendering/cubism-runtime';
import type { ResolvedPack, ResolvedPackVariant } from '../src/shared/resolve-character-pack';

const profile = { resolutionScale: 1, reducedMotion: false, maxFps: 30 } as const;
const variant: Extract<ResolvedPackVariant, { renderer: 'cubism' }> = {
  renderer: 'cubism', id: 'live2d', entry: 'assets/live2d/test.model3.json', textures: [],
  model: { moc: 'assets/live2d/test.moc3', textures: [], eyeBlink: [], lipSync: [], expressions: {}, motions: {}, dependencies: [] },
};
const fallback: Extract<ResolvedPackVariant, { renderer: 'static' }> = {
  renderer: 'static', id: 'still', entry: 'assets/still.png', imagePath: 'assets/still.png', imageSize: { w: 4, h: 4 },
};
const pack: ResolvedPack = {
  variants: [variant, fallback], readAsset: () => undefined,
  manifest: { schemaVersion: 1, characterId: 'star-singer', packVersion: '1.2.0', minAppVersion: '0.0.0',
    displayName: { 'zh-CN': '星咏' }, thumbnail: fallback.imagePath, anchor: { x: 0.5, y: 1 }, logicalSize: { w: 4, h: 4 },
    hitRegions: [{ id: 'head', rect: [0, 0, 1, 1] }],
    actions: { idle: { still: 'idle', live2d: 'idle' }, 'tap.head': { live2d: 'tap-head' } }, cgIds: [],
    variants: [{ id: variant.id, renderer: 'cubism', entry: variant.entry }, { id: fallback.id, renderer: 'static', entry: fallback.entry }],
    files: [], license: { owner: 'Local tests', reference: 'Synthetic model' } },
};

function canvas() {
  const gl = {} as WebGL2RenderingContext;
  const surface = Object.assign(new EventTarget(), { getContext: vi.fn(() => gl), width: 0, height: 0 });
  return { gl, surface: surface as unknown as HTMLCanvasElement };
}

function mockRuntime() {
  const session = {
    draw: vi.fn<CubismSession['draw']>(), play: vi.fn<CubismSession['play']>(group => group === 'idle' ? null : 0.30),
    stopMotions: vi.fn(), expression: vi.fn(), destroy: vi.fn(),
  };
  const load = vi.fn<CubismRuntime['load']>().mockResolvedValue(session);
  return { load, session };
}

describe('Cubism renderer', () => {
  it('draws an isolated surface and advances look, lip-sync, reduced motion and actions', async () => {
    const { surface, gl } = canvas();
    const { load, session } = mockRuntime();
    const health = vi.fn();
    const renderer = new CubismRenderer({ load }, health);
    await renderer.init(surface, profile);
    renderer.resize(100, 120, 2);
    const request = new AbortController();
    await renderer.loadPack(pack, request.signal);
    expect(surface.getContext).toHaveBeenCalledWith('webgl2', { alpha: true, premultipliedAlpha: true });
    expect(load).toHaveBeenCalledWith(gl, pack, variant, expect.any(AbortSignal));
    expect(renderer.hasDrawnFrame).toBe(true);
    expect(surface.width).toBe(200);
    expect(surface.height).toBe(240);

    renderer.setLook(2, -0.5);
    renderer.setMouth({ generation: 3, open: 0.7, atMs: 100 });
    renderer.setMouth({ generation: 2, open: 0.9, atMs: 110 });
    renderer.tick(0.125);
    expect(session.draw.mock.lastCall?.[3]).toMatchObject({ look: { x: 1, y: -0.5 }, mouth: 0.7 });
    renderer.tick(0.075);
    expect(session.draw.mock.lastCall?.[3]?.mouth).toBe(0);
    const action = renderer.play({ requestId: 'tap', semanticId: 'tap.head', loop: false, priority: 1, blendMs: 0 });
    renderer.tick(0.20);
    renderer.tick(0.15);
    await expect(action).resolves.toEqual({ requestId: 'tap', status: 'completed' });
    expect(session.play).toHaveBeenCalledWith('tap-head', false);
    expect(session.stopMotions).toHaveBeenCalled();

    const loop = renderer.play({ requestId: 'loop', semanticId: 'tap.head', loop: true, priority: 1, blendMs: 0 });
    renderer.setQuality({ ...profile, reducedMotion: true });
    await expect(loop).resolves.toEqual({ requestId: 'loop', status: 'interrupted' });
    expect(session.draw.mock.lastCall?.[3]).toMatchObject({ still: true, mouth: 0 });

    const loss = new Event('webglcontextlost', { cancelable: true });
    surface.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true);
    expect(health).toHaveBeenCalledWith('context-lost');
    expect(renderer.hasDrawnFrame).toBe(false);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    surface.dispatchEvent(new Event('webglcontextrestored'));
    expect(health).toHaveBeenCalledWith('context-restored');
    renderer.destroy();
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back on Core failure using a separate canvas and preserves character identity', async () => {
    const surfaces = new Map<RenderBackend, HTMLCanvasElement>();
    const state = vi.fn();
    const createRenderer = vi.fn((backend: RenderBackend): VisualRenderer => {
      if (backend === 'cubism-webgl') throw new Error('Core unavailable');
      if (backend === 'pixi-webgl') throw new Error('GPU unavailable');
      return { init: vi.fn(async () => {}), loadPack: vi.fn(async () => {}), activeVariant: fallback,
        activeCharacterId: 'star-singer', hasDrawnFrame: true, setBaseAction: vi.fn(), clearMouth: vi.fn(),
        resize: vi.fn(), setPose: vi.fn(), play: vi.fn(), setExpression: vi.fn(), setMouth: vi.fn(),
        tick: vi.fn(), hitTest: vi.fn(), setQuality: vi.fn(), setPaused: vi.fn(), destroy: vi.fn(),
      };
    });
    const host = new AdaptiveRendererHost({
      createSurface(backend) {
        const { surface } = canvas();
        surfaces.set(backend, surface);
        return { canvas: surface, show: vi.fn(), destroy: vi.fn() };
      },
      createRenderer,
      onState: state,
    });
    host.resize(100, 120, 1);
    await host.loadPack(pack, new AbortController().signal);
    expect(createRenderer.mock.calls.map(([backend]) => backend)).toEqual(['cubism-webgl', 'pixi-webgl', 'canvas2d']);
    expect(new Set(surfaces.values()).size).toBe(3);
    expect(state).toHaveBeenLastCalledWith({ characterId: 'star-singer', stage: 'ready', backend: 'canvas2d', hasFrame: true });
    expect(host.interactive).toBe(true);
    host.destroy();
  });
});
