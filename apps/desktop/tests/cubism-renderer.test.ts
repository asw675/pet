import { describe, expect, it, vi } from 'vitest';
import { AdaptiveRendererHost, type RenderBackend, type VisualRenderer } from '../src/renderer/rendering/adaptive-renderer-host';
import { CubismRenderer } from '../src/renderer/rendering/cubism-renderer';
import { createCubismRuntime, type CubismRuntime, type CubismSdkBindings, type CubismSession } from '../src/renderer/rendering/cubism-runtime';
import { calculateModelGeometry } from '../src/renderer/rendering/geometry';
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

  it('plays an authored body hit, suppresses gaze during the drag entrance and restores the idle base', async () => {
    const { surface } = canvas();
    const { load, session } = mockRuntime();
    const interactionPack = { ...pack, manifest: { ...pack.manifest, actions: {
      ...pack.manifest.actions,
      'tap.body': { live2d: 'tap-body' },
      drag: { live2d: 'drag-motion' },
    } } };
    const renderer = new CubismRenderer({ load }, vi.fn());
    await renderer.init(surface, profile);
    renderer.resize(100, 120, 1);
    await renderer.loadPack(interactionPack, new AbortController().signal);
    renderer.setLook(0.7, -0.6);
    renderer.tick(0.125);
    const action = renderer.play({ requestId: 'body', semanticId: 'tap.body', loop: false, priority: 10, blendMs: 0 });
    expect(session.play).toHaveBeenLastCalledWith('tap-body', false);
    renderer.setBaseAction('drag');
    expect(session.play).toHaveBeenLastCalledWith('drag-motion', true);
    await expect(action).resolves.toEqual({ requestId: 'body', status: 'interrupted' });
    renderer.tick(0.125);
    expect(session.draw.mock.lastCall?.[3]).toMatchObject({ look: { x: 0, y: 0 } });
    renderer.setBaseAction('idle');
    expect(session.play).toHaveBeenLastCalledWith('idle', true);
    renderer.destroy();
  });

  it('uses bounded parameter feedback when an authored tap is absent', async () => {
    const { surface } = canvas();
    const { load, session } = mockRuntime();
    const renderer = new CubismRenderer({ load }, vi.fn());
    await renderer.init(surface, profile);
    renderer.resize(100, 120, 1);
    await renderer.loadPack(pack, new AbortController().signal);
    const action = renderer.play({ requestId: 'tap', semanticId: 'tap.body', loop: false, priority: 10, blendMs: 0 });
    renderer.tick(0.18);
    expect(session.draw.mock.lastCall?.[3]?.tap).toEqual({ area: 'body', strength: 1 });
    renderer.tick(0.20);
    await expect(action).resolves.toEqual({ requestId: 'tap', status: 'completed' });
    expect(session.draw.mock.lastCall?.[3]?.tap).toBeUndefined();
    renderer.destroy();
  });

  it('applies mouse gaze over an authored idle pose and fades tap changes back to it', async () => {
    const ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamBodyAngleX', 'ParamMouthForm'];
    const values = ids.map(() => 0);
    const noop = () => {};
    const model = {
      getModel: () => ({ canvasinfo: { CanvasWidth: 4, CanvasHeight: 4, PixelsPerUnit: 1 }, parameters: { ids } }),
      getParameterCount: () => ids.length, getParameterValueByIndex: (index: number) => values[index]!,
      getParameterMinimumValue: () => -30, getParameterMaximumValue: () => 30,
      getDrawableCount: () => 1, getDrawableVertexCount: () => 3,
      setParameterValueByIndex: (index: number, value: number) => { values[index] = value; },
      loadParameters: () => { values.fill(0); }, saveParameters: noop, update: noop,
    };
    const sdk: CubismSdkBindings = {
      framework: { isStarted: () => true, isInitialized: () => true, startUp: () => true, initialize: noop },
      moc: { create: () => ({ createModel: () => model, deleteModel: noop, release: noop }) },
      Renderer: class {
        initialize = noop; startUp = noop; bindTexture = noop; setIsPremultipliedAlpha = noop;
        setRenderTargetSize = noop; setMvpMatrix = noop; setRenderState = noop; loadShaders = noop;
        drawModel = noop; release = noop;
      },
      Matrix: class { getArray = () => new Float32Array(16); },
      shaders: { getInstance: () => ({ getShader: () => ({ _isShaderLoaded: true, release: noop }), _shaderMap: new Map() }) },
      physics: { create: () => null }, pose: { create: () => null }, motion: { create: () => null },
      MotionManager: class {
        startMotionPriority = noop;
        updateMotion = () => { values[0] = 6; values[1] = 4; values[4] = 1; return true; };
        stopAllMotions = noop; release = noop;
      },
      expression: { create: () => null },
      ExpressionManager: class { startMotion = noop; updateMotion = () => false; stopAllMotions = noop; release = noop; },
    };
    const gl = {
      isContextLost: () => false, bindFramebuffer: noop, viewport: noop, clearColor: noop, clear: noop,
      readPixels: (_x: number, _y: number, _w: number, _h: number, _format: number, _type: number, row: Uint8Array) => row.fill(255),
    } as unknown as WebGL2RenderingContext;
    const session = await createCubismRuntime(sdk, 'test-shaders').load(gl,
      { ...pack, readAsset: () => new Uint8Array(64) }, variant, new AbortController().signal);
    const geometry = calculateModelGeometry({ w: 120, h: 120 }, pack.manifest.logicalSize, pack.manifest.anchor,
      { x: 0, y: 0, scale: 1, facing: 1 })!;
    const frame = { seconds: 0.5, dt: 0.1, look: { x: 0.5, y: -0.25 }, mouth: 0, sleep: false, still: false };
    session.draw(geometry, 120, 120, { ...frame, tap: { area: 'body', strength: 0.5 } });
    expect(values).toEqual([15, 1, -2.5, 0.5, 4, 0.325]);
    session.draw(geometry, 120, 120, { ...frame, look: { x: 0, y: 0 } });
    expect(values).toEqual([6, 4, 0, 0, 1, 0]);
    session.destroy();
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
