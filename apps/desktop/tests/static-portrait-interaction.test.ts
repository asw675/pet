import { describe, expect, it, vi } from 'vitest';
import { loadBuiltinPack } from '../src/renderer/asset-packs/builtin-registry';
import { AdaptiveRendererHost, type VisualRenderer } from '../src/renderer/rendering/adaptive-renderer-host';

describe('static portrait interaction', () => {
  it('uses the real built-in fallback geometry for pointer and tap feedback, and resets it when paused', async () => {
    const pack = await loadBuiltinPack('star-singer');
    const preview = pack.variants.find(variant => variant.renderer === 'static')!;
    const setPose = vi.fn<VisualRenderer['setPose']>();
    const play = vi.fn<VisualRenderer['play']>();
    const host = new AdaptiveRendererHost({
      createSurface: () => ({ canvas: new EventTarget() as unknown as HTMLCanvasElement, show: vi.fn(), destroy: vi.fn() }),
      createRenderer: () => ({
        init: vi.fn(async () => {}), loadPack: vi.fn(async () => {}), activeVariant: preview,
        activeCharacterId: 'star-singer', hasDrawnFrame: true, setBaseAction: vi.fn(), clearMouth: vi.fn(),
        resize: vi.fn(), setPose, play, setExpression: vi.fn(), setMouth: vi.fn(), tick: vi.fn(), hitTest: vi.fn(),
        setQuality: vi.fn(), setPaused: vi.fn(), destroy: vi.fn(),
      }),
      onState: vi.fn(),
    });
    host.resize(120, 180, 1);
    await host.loadPack(pack, new AbortController().signal);
    host.setLook(1, 0);
    host.tick(0.10);
    expect(setPose).toHaveBeenLastCalledWith({ x: 4.5, y: 0, scale: 1, facing: 1 });

    const tap = host.play({ requestId: 'tap', semanticId: 'tap.body', loop: false, priority: 10, blendMs: 0 });
    host.tick(0.10);
    expect(setPose.mock.lastCall?.[0].scale).toBeGreaterThan(1);
    expect(play).not.toHaveBeenCalled();
    host.setLook(0, 0);
    host.tick(0.10); host.tick(0.10); host.tick(0.10);
    await expect(tap).resolves.toEqual({ requestId: 'tap', status: 'completed' });
    expect(setPose).toHaveBeenLastCalledWith({ x: 0, y: 0, scale: 1, facing: 1 });

    const secondTap = host.play({ requestId: 'tap-2', semanticId: 'tap.head', loop: false, priority: 10, blendMs: 0 });
    host.tick(0.10);
    host.setPaused(true);
    await expect(secondTap).resolves.toEqual({ requestId: 'tap-2', status: 'interrupted' });
    expect(setPose).toHaveBeenLastCalledWith({ x: 0, y: 0, scale: 1, facing: 1 });
    host.destroy();
  });
});
