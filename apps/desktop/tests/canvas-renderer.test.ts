import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadBuiltinPack } from '../src/renderer/asset-packs/builtin-registry';
import type { ResolvedPack } from '../src/renderer/asset-packs/resolve-pack';
import { CanvasRenderer, type BitmapDecoder } from '../src/renderer/rendering/canvas-renderer';
import type { ActionRequest, RenderProfile } from '../src/renderer/rendering/contract';
import { calculateModelGeometry, modelToCss } from '../src/renderer/rendering/geometry';

const profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };
let star: ResolvedPack;
let ranger: ResolvedPack;
beforeAll(async () => {
  [star, ranger] = await Promise.all([loadBuiltinPack('star-singer'), loadBuiltinPack('fluffy-ranger')]);
});

function mockBitmap(w: number, h: number) {
  const close = vi.fn();
  const value = { width: w, height: h, close } as ImageBitmap;
  return { value, close };
}

function pngDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

function decoder() {
  const images: ReturnType<typeof mockBitmap>[] = [];
  const decode: BitmapDecoder = async (bytes) => {
    const { w, h } = pngDimensions(bytes);
    const image = mockBitmap(w, h);
    images.push(image);
    return image.value;
  };
  return { decode, images };
}

function mockSurface() {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
  const element = {
    width: 300, height: 150, getContext: vi.fn(() => context),
  };
  return { canvas: element as unknown as HTMLCanvasElement, context, element };
}

async function setup(decode: BitmapDecoder, size = { w: 128, h: 128 }) {
  const renderer = new CanvasRenderer({ decode });
  const surface = mockSurface();
  await renderer.init(surface.canvas, profile);
  renderer.resize(size.w, size.h, 1);
  return { renderer, ...surface };
}

function signal() { return new AbortController().signal; }
function request(semanticId: string, requestId = semanticId): ActionRequest {
  return { requestId, semanticId, loop: false, priority: 1, blendMs: 0 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('Canvas2D verified sprite fallback adapter', () => {
  it('draws actual verified mouth patches from the audio sample levels, preserving body frame and clearing old generations immediately', async () => {
    const { decode, images } = decoder();
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    renderer.setMouth({ generation: 2, atMs: 34, open: .9 });
    expect(context.drawImage.mock.calls.at(-2)).toEqual([images[0]!.value, 0, 0, 128, 128, 0, 0, 128, 128]);
    // Talk frame 2 is the highest authored ellipse, at cell (0,384), dy=-3.
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 59, 447, 10, 11, 59, 66, 10, 11);
    renderer.setMouth({ generation: 2, atMs: 68, open: 0 });
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 59, 66, 10, 11, 59, 66, 10, 11);
    const draws = context.drawImage.mock.calls.length;
    renderer.setMouth({ generation: 2, atMs: 34, open: .9 });
    renderer.setMouth({ generation: 1, atMs: 100, open: .9 });
    expect(context.drawImage).toHaveBeenCalledTimes(draws);
    renderer.clearMouth();
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 0, 0, 128, 128, 0, 0, 128, 128);
    renderer.setMouth({ generation: 2, atMs: 102, open: .9 });
    expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.setMouth({ generation: 3, atMs: 10, open: .65 });
    expect(context.drawImage.mock.lastCall?.[3]).toBe(10);
    renderer.setPaused(true); expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.setPaused(false); renderer.setMouth({ generation: 3, atMs: 40, open: .9 });
    expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.setBaseAction('talk'); // Text-only semantically talking, no fake audio-driven mouth.
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 59, 66, 10, 11, 59, 66, 10, 11);
    renderer.destroy();
  });

  it('reduced motion and pack replacement cannot leave an open speech patch on a new character', async () => {
    const { decode, images } = decoder();
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal()); renderer.setMouth({ generation: 2, atMs: 30, open: .9 });
    renderer.setQuality({ ...profile, reducedMotion: true }); expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.setQuality(profile); renderer.setMouth({ generation: 2, atMs: 60, open: .9 }); expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.setMouth({ generation: 3, atMs: 30, open: .9 }); await renderer.loadPack(ranger, signal());
    expect(context.drawImage).toHaveBeenLastCalledWith(images[1]!.value, 0, 0, 128, 128, 0, 0, 128, 128);
    renderer.setMouth({ generation: 3, atMs: 60, open: .9 }); expect(context.drawImage.mock.lastCall?.[3]).toBe(128);
    renderer.destroy();
  });
  it('decodes the built-in atlas and actually draws changing source rects with frame durations', async () => {
    const { decode, images } = decoder();
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(renderer.activeVariant?.renderer).toBe('sprite');
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 0, 0, 128, 128, 0, 0, 128, 128);
    const draws = context.drawImage.mock.calls.length;
    renderer.tick(0.4); // first idle frame is 420 ms
    expect(context.drawImage).toHaveBeenCalledTimes(draws);
    renderer.tick(0.04);
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 128, 0, 128, 128, 0, 0, 128, 128);

    renderer.setBaseAction('sleep');
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 512, 0, 128, 128, 0, 0, 128, 128);
    const happy = renderer.play(request('happy'));
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 256, 128, 128, 128, 0, 0, 128, 128);
    renderer.tick(0.13);
    expect(context.drawImage).toHaveBeenLastCalledWith(images[0]!.value, 384, 128, 128, 128, 0, 0, 128, 128);
    renderer.setBaseAction('walk'); // new base while once-action plays
    renderer.tick(1);
    await expect(happy).resolves.toEqual({ requestId: 'happy', status: 'completed' });
    // Current base walk frames occupy the last four cells of the atlas.
    const [, sourceX, sourceY] = context.drawImage.mock.lastCall!;
    expect(sourceY).toBe(384);
    expect(sourceX).toBeGreaterThanOrEqual(256);
    renderer.destroy();
    expect(images[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('uses verified PNG bytes through the browser ImageBitmap+Blob decode path by default', async () => {
    const image = mockBitmap(768, 512);
    const create = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe('image/png');
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(star.readAsset('assets/atlas.png'));
      return image.value;
    });
    vi.stubGlobal('createImageBitmap', create);
    try {
      const { canvas, context } = mockSurface();
      const renderer = new CanvasRenderer();
      await renderer.init(canvas, profile);
      renderer.resize(128, 128, 1);
      await renderer.loadPack(star, signal());
      expect(create).toHaveBeenCalledTimes(1);
      expect(context.drawImage).toHaveBeenCalledTimes(1);
      renderer.destroy();
      expect(image.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a mismatched decoded atlas size and falls back to the pack still image', async () => {
    const invalid = mockBitmap(767, 512);
    const still = mockBitmap(128, 128);
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(invalid.value)
      .mockResolvedValueOnce(still.value);
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    expect(invalid.close).toHaveBeenCalledTimes(1);
    expect(renderer.activeVariant?.renderer).toBe('static');
    expect(context.drawImage).toHaveBeenLastCalledWith(still.value, 0, 0, 128, 128, 0, 0, 128, 128);
    const draws = context.drawImage.mock.calls.length;
    const unsupported = renderer.play(request('walk'));
    renderer.setExpression('smile', 1);
    renderer.setMouth({ generation: 1, open: 0.9, atMs: 15 });
    renderer.tick(2);
    await expect(unsupported).resolves.toEqual({ requestId: 'walk', status: 'unsupported' });
    expect(context.drawImage).toHaveBeenCalledTimes(draws);
    renderer.destroy();
    expect(invalid.close).toHaveBeenCalledTimes(1);
    expect(still.close).toHaveBeenCalledTimes(1);
  });

  it('times out an unresponsive sprite decoder, uses the still, then closes any late sprite', async () => {
    vi.useFakeTimers();
    try {
      const late = mockBitmap(768, 512);
      const still = mockBitmap(128, 128);
      const pendingDecode = deferred<ImageBitmap>();
      const started = deferred<void>();
      const decode = vi.fn<BitmapDecoder>()
        .mockImplementationOnce(() => { started.resolve(); return pendingDecode.promise; })
        .mockResolvedValueOnce(still.value);
      const renderer = new CanvasRenderer({ decode, decodeTimeoutMs: 10 });
      const { canvas, context } = mockSurface();
      await renderer.init(canvas, profile);
      renderer.resize(128, 128, 1);
      const pending = renderer.loadPack(star, signal());
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(renderer.activeVariant?.renderer).toBe('static');
      expect(context.drawImage.mock.lastCall?.[0]).toBe(still.value);
      pendingDecode.resolve(late.value);
      await vi.advanceTimersByTimeAsync(1);
      expect(late.close).toHaveBeenCalledTimes(1);
      expect(context.drawImage.mock.calls.some(([image]) => image === late.value)).toBe(false);
      renderer.destroy();
      expect(still.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps A and its live action on a total B decode failure', async () => {
    const first = mockBitmap(768, 512);
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(first.value)
      .mockRejectedValue(new Error('broken image'));
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    const action = renderer.play(request('happy'));
    const oldDraws = context.drawImage.mock.calls.length;
    await expect(renderer.loadPack(ranger, signal())).rejects.toThrow('No usable Canvas2D character variant');
    expect(decode).toHaveBeenCalledTimes(3); // A sprite, B sprite, B static
    expect(context.drawImage).toHaveBeenCalledTimes(oldDraws);
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(first.close).not.toHaveBeenCalled();
    expect(renderer.hitTest(64, 64)).toEqual({ id: 'head' });
    renderer.tick(1);
    await expect(action).resolves.toMatchObject({ status: 'completed' });
    renderer.destroy();
  });

  it('keeps the old rendered frame when candidate drawImage fails', async () => {
    const first = mockBitmap(768, 512);
    const candidate = mockBitmap(768, 512);
    const still = mockBitmap(128, 128);
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(candidate.value)
      .mockResolvedValueOnce(still.value);
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    context.drawImage.mockImplementation((image: ImageBitmap) => {
      if (image !== first.value) throw new Error('draw failed');
    });
    await expect(renderer.loadPack(ranger, signal())).rejects.toThrow();
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(context.drawImage.mock.lastCall?.[0]).toBe(first.value);
    expect(first.close).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(still.close).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('fails closed when no candidate can draw and does not expose a stale hit target', async () => {
    const sprite = mockBitmap(768, 512);
    const still = mockBitmap(128, 128);
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(sprite.value).mockResolvedValueOnce(still.value);
    const { renderer, context } = await setup(decode);
    context.drawImage.mockImplementation(() => { throw new Error('draw failed'); });
    await expect(renderer.loadPack(star, signal())).rejects.toThrow();
    expect(renderer.activeCharacterId).toBeNull();
    expect(renderer.hitTest(64, 64)).toBeNull();
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 128, 128);
    expect(sprite.close).toHaveBeenCalledTimes(1);
    expect(still.close).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('atomically supersedes A→B→A while B decode is pending and releases its late bitmap', async () => {
    const first = mockBitmap(768, 512);
    const late = mockBitmap(768, 512);
    const latest = mockBitmap(768, 512);
    const b = deferred<ImageBitmap>();
    const started = deferred<void>();
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(first.value)
      .mockImplementationOnce(() => { started.resolve(); return b.promise; })
      .mockResolvedValueOnce(latest.value);
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    const oldAction = renderer.play(request('happy'));
    const pending = renderer.loadPack(ranger, signal());
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(first.close).not.toHaveBeenCalled();

    await renderer.loadPack(star, signal());
    await cancelled;
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(context.drawImage.mock.lastCall?.[0]).toBe(latest.value);
    expect(first.close).toHaveBeenCalledTimes(1);
    await expect(oldAction).resolves.toMatchObject({ status: 'interrupted' });
    b.resolve(late.value);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    expect(context.drawImage.mock.calls.some(([image]) => image === late.value)).toBe(false);
    expect(latest.close).not.toHaveBeenCalled();
    renderer.destroy();
    expect(latest.close).toHaveBeenCalledTimes(1);
  });

  it('honors explicit cancellation independently from the decoder and retains prior pixels', async () => {
    const first = mockBitmap(768, 512);
    const late = mockBitmap(768, 512);
    const b = deferred<ImageBitmap>();
    const started = deferred<void>();
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(first.value)
      .mockImplementationOnce(() => { started.resolve(); return b.promise; });
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    const before = context.drawImage.mock.calls.length;
    const controller = new AbortController();
    const pending = renderer.loadPack(ranger, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    await cancelled;
    expect(renderer.activeCharacterId).toBe('star-singer');
    expect(context.drawImage).toHaveBeenCalledTimes(before);
    expect(first.close).not.toHaveBeenCalled();
    b.resolve(late.value);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    renderer.destroy();
  });

  it('destroys active and pending storage, interrupts action, and cannot commit after disposal', async () => {
    const first = mockBitmap(768, 512);
    const late = mockBitmap(768, 512);
    const b = deferred<ImageBitmap>();
    const started = deferred<void>();
    const decode = vi.fn<BitmapDecoder>()
      .mockResolvedValueOnce(first.value)
      .mockImplementationOnce(() => { started.resolve(); return b.promise; });
    const { renderer, context, canvas } = await setup(decode);
    await renderer.loadPack(star, signal());
    const action = renderer.play(request('happy'));
    const pending = renderer.loadPack(ranger, signal());
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    const before = context.drawImage.mock.calls.length;
    renderer.destroy();
    renderer.destroy();
    await cancelled;
    await expect(action).resolves.toMatchObject({ status: 'interrupted' });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(renderer.activeCharacterId).toBeNull();
    expect(renderer.hitTest(64, 64)).toBeNull();
    b.resolve(late.value);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
    expect(context.drawImage).toHaveBeenCalledTimes(before);
    await expect(renderer.loadPack(star, signal())).rejects.toThrow();
  });

  it('renders and hit-tests with the same CSS geometry across DPR and quality changes', async () => {
    const { decode } = decoder();
    const { renderer, context, canvas } = await setup(decode, { w: 240, h: 120 });
    await renderer.loadPack(star, signal());
    renderer.resize(240, 120, 1.5);
    expect(canvas.width).toBe(360);
    expect(canvas.height).toBe(180);
    expect(context.setTransform.mock.calls.at(-2)).toEqual([1.40625, 0, 0, 1.40625, 90, 0]);
    expect(renderer.hitTest(120, 60)).toEqual({ id: 'head' });
    expect(renderer.hitTest(120, 90)).toEqual({ id: 'body' });
    expect(renderer.hitTest(20, 60)).toBeNull();
    renderer.setQuality({ maxFps: 15, resolutionScale: 0.5, reducedMotion: false });
    expect(canvas.width).toBe(180);
    expect(canvas.height).toBe(90);
    expect(renderer.hitTest(120, 60)).toEqual({ id: 'head' });

    const pose = { x: 20, y: -10, scale: 0.5, facing: -1 as const };
    renderer.setPose(pose);
    const geometry = calculateModelGeometry({ w: 240, h: 120 }, star.manifest.logicalSize, star.manifest.anchor, pose)!;
    const point = modelToCss(geometry, { x: 50, y: 60 });
    expect(renderer.hitTest(point.x, point.y)).toEqual({ id: 'head' });
    expect(context.setTransform.mock.calls.at(-2)?.[0]).toBeLessThan(0);
    renderer.setPose({ ...pose, scale: Number.MAX_VALUE }); // transform would overflow
    expect(renderer.hitTest(point.x, point.y)).toBeNull();
    renderer.setPose(pose);
    renderer.resize(0, 120, 1);
    expect(canvas.width).toBe(0);
    expect(renderer.hitTest(0, 60)).toBeNull();
    renderer.resize(100_000, 100_000, 2); // allocation budget fails closed
    expect(canvas.height).toBe(0);
    expect(renderer.hitTest(50000, 50000)).toBeNull();
    renderer.destroy();
  });

  it('pauses time, supports reduced motion, and settles a reduced-motion one shot', async () => {
    const { decode } = decoder();
    const { renderer, context } = await setup(decode);
    await renderer.loadPack(star, signal());
    renderer.setPaused(true);
    const before = context.drawImage.mock.calls.length;
    renderer.tick(10);
    expect(context.drawImage).toHaveBeenCalledTimes(before);
    renderer.setPaused(false);
    renderer.tick(0.45);
    expect(context.drawImage).toHaveBeenCalledTimes(before + 1);

    renderer.setQuality({ ...profile, reducedMotion: true });
    const reduced = context.drawImage.mock.calls.length;
    renderer.tick(0.7);
    expect(context.drawImage).toHaveBeenCalledTimes(reduced);
    const action = renderer.play(request('tap.head'));
    expect(context.drawImage.mock.lastCall?.slice(1, 5)).toEqual([0, 256, 128, 128]);
    const firstFrame = context.drawImage.mock.calls.length;
    renderer.tick(0.2); // would otherwise advance tap.head frame
    expect(context.drawImage).toHaveBeenCalledTimes(firstFrame);
    renderer.tick(1);
    await expect(action).resolves.toMatchObject({ status: 'completed' });
    expect(context.drawImage.mock.lastCall?.slice(1, 5)).toEqual([0, 0, 128, 128]);
    renderer.destroy();
  });
});
