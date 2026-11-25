import type { ResolvedPack, ResolvedPackVariant } from '../../shared/resolve-character-pack';
import { ActionController, type AnimationClip } from './action-controller';
import type {
  ActionRequest, ActionResult, HitRegion, MouthSample, PetRenderer, RenderPose, RenderProfile,
} from './contract';
import { backingStoreSize, calculateModelGeometry, hitTestModel, type Size } from './geometry';
import { authoredMouthPatch, type AuthoredMouthPatch } from './authored-mouth';

export type BitmapDecoder = (bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<ImageBitmap>;
export interface CanvasRendererOptions {
  /** Injection point for deterministic tests. Production decodes verified PNG bytes. */
  decode?: BitmapDecoder;
  /** Per-variant deadline. A timed-out sprite may still use the static fallback. */
  decodeTimeoutMs?: number;
}

interface LoadedVariant {
  readonly pack: ResolvedPack;
  readonly variant: Exclude<ResolvedPackVariant, { renderer: 'cubism' }>;
  readonly bitmap: ImageBitmap;
  readonly actions: ActionController;
}

interface Frame {
  readonly key: string;
  readonly rect: readonly [number, number, number, number];
  readonly mouth?: AuthoredMouthPatch;
}

const DEFAULT_POSE: RenderPose = { x: 0, y: 0, scale: 1, facing: 1 };
// The fallback must never allocate an unbounded browser surface from resize.
const MAX_BACKING_EDGE = 4096;
const MAX_BACKING_PIXELS = 4 * 1024 * 1024; // 16 MiB of RGBA pixels
const DEFAULT_DECODE_TIMEOUT_MS = 8_000;

function assertProfile(profile: RenderProfile): void {
  if ((profile.maxFps !== 15 && profile.maxFps !== 30) || !Number.isFinite(profile.resolutionScale)
    || profile.resolutionScale <= 0 || profile.resolutionScale > 1
    || typeof profile.reducedMotion !== 'boolean') throw new RangeError('Invalid Canvas2D render profile');
}

function closeBitmap(bitmap: ImageBitmap): void {
  // Browser teardown should not prevent disposal of the other owned objects.
  try { bitmap.close(); } catch { /* already invalid/disposed */ }
}

async function browserDecode(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
  signal.throwIfAborted();
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

/**
 * createImageBitmap has no AbortSignal. Reject promptly when cancelled and
 * release a bitmap from a late decode instead of leaving its GPU/CPU storage
 * alive or letting it overwrite a newer request.
 */
function decodeAbortable(
  decoder: BitmapDecoder, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal,
): Promise<ImageBitmap> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<ImageBitmap>((resolve, reject) => {
    let pending = true;
    const finish = (): void => {
      pending = false;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (!pending) return;
      finish();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return decoder(bytes, signal);
    }).then((bitmap) => {
      if (!pending) { closeBitmap(bitmap); return; }
      finish();
      resolve(bitmap);
    }, (error: unknown) => {
      if (!pending) return;
      finish();
      reject(error);
    });
  });
}

function actionController(pack: ResolvedPack, variant: ResolvedPackVariant): ActionController {
  const clips: Readonly<Record<string, AnimationClip>> = variant.renderer === 'sprite'
    ? variant.atlas.clips
    : { idle: { frames: [{ durationMs: 1000 }] } };
  const actions = Object.fromEntries(Object.entries(pack.manifest.actions).flatMap(([semantic, variants]) => {
    const clip = variants[variant.id];
    return clip === undefined ? [] : [[semantic, clip]];
  }));
  return new ActionController(clips, actions);
}

/**
 * Canvas2D fallback adapter. It renders the verified full-frame atlas or a
 * still PNG, not a PixiJS/WebGL renderer. No RAF, domain writes, IPC, external
 * assets or audio clock are owned here; the window owns tick/resize timing.
 */
export class CanvasRenderer implements PetRenderer {
  private readonly decode: BitmapDecoder;
  private readonly decodeTimeoutMs: number;
  private canvas: HTMLCanvasElement | undefined;
  private ctx: CanvasRenderingContext2D | undefined;
  private profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };
  private pose: RenderPose = { ...DEFAULT_POSE };
  private viewport: Size = { w: 0, h: 0 };
  private dpr = 1;
  private active: LoadedVariant | undefined;
  private pending: AbortController | undefined;
  private baseAction = 'idle';
  private paused = false;
  private destroyed = false;
  private lastDrawn: string | null = null;
  private elapsedDrawMs = 0;
  private mouth: MouthSample | null = null;
  private mouthGeneration = -1;

  constructor(options: CanvasRendererOptions = {}) {
    this.decode = options.decode ?? browserDecode;
    this.decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    if (!Number.isInteger(this.decodeTimeoutMs) || this.decodeTimeoutMs < 1 || this.decodeTimeoutMs > 120_000) {
      throw new RangeError('Invalid decode deadline');
    }
  }

  get activeVariant(): ResolvedPackVariant | null { return this.active?.variant ?? null; }
  get activeCharacterId(): string | null { return this.active?.pack.manifest.characterId ?? null; }

  async init(canvas: HTMLCanvasElement, profile: RenderProfile): Promise<void> {
    if (this.destroyed || this.canvas) throw new Error('Canvas renderer cannot be initialized twice');
    assertProfile(profile);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas2D unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.profile = { ...profile };
    this.updateBackingStore();
  }

  /**
   * Prepare/validate the candidate before drawing anything. A failed, aborted,
   * or superseded load leaves the current character and controller untouched.
   * Each candidate bitmap is owned until its synchronous promotion or disposal.
   */
  async loadPack(pack: ResolvedPack, signal: AbortSignal): Promise<void> {
    if (!this.canvas || !this.ctx || this.destroyed) throw new Error('Canvas renderer not initialized');
    signal.throwIfAborted();
    // A character resource replacement is a visual identity boundary. Never
    // paint a new avatar using the previous avatar's speech projection.
    this.clearMouth();
    this.pending?.abort(new DOMException('Superseded character load', 'AbortError'));
    const pending = new AbortController();
    this.pending = pending;
    const onAbort = (): void => pending.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    // Preserve declaration order within sprite and static types; prefer motion.
    const variants = [
      ...pack.variants.filter((variant) => variant.renderer === 'sprite'),
      ...pack.variants.filter((variant) => variant.renderer === 'static'),
    ];
    let failure: unknown;
    try {
      for (const variant of variants) {
        let bitmap: ImageBitmap | undefined;
        let actions: ActionController | undefined;
        try {
          pending.signal.throwIfAborted();
          const bytes = pack.readAsset(variant.imagePath);
          if (!bytes) throw new Error('Verified image unavailable');
          bitmap = await this.decodeVariant(bytes, pending.signal);
          pending.signal.throwIfAborted();
          if (bitmap.width !== variant.imageSize.w || bitmap.height !== variant.imageSize.h) {
            throw new Error('Decoded image dimensions differ from verified PNG');
          }
          actions = actionController(pack, variant);
          actions.setBaseAction(this.baseAction);
          actions.setPaused(this.paused);
          const next: LoadedVariant = { pack, variant, bitmap, actions };
          // Re-check ownership after asynchronous decode, before touching canvas.
          if (this.destroyed || this.pending !== pending) {
            throw new DOMException('Superseded character load', 'AbortError');
          }
          // drawImage is synchronous. If a context-level draw error occurs,
          // restore the prior frame before trying another variant, if possible.
          let drawn: string | null;
          try { drawn = this.paint(next); }
          catch (error) {
            if (this.active) this.refresh(true);
            else this.clearSurface();
            throw error;
          }
          const old = this.active;
          this.active = next;
          this.lastDrawn = drawn;
          this.elapsedDrawMs = 0;
          bitmap = undefined;
          actions = undefined;
          if (old) { old.actions.destroy(); closeBitmap(old.bitmap); }
          return;
        } catch (error) {
          actions?.destroy();
          if (bitmap) closeBitmap(bitmap);
          pending.signal.throwIfAborted();
          failure = error;
        }
      }
      throw new Error('No usable Canvas2D character variant', { cause: failure });
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  resize(wCss: number, hCss: number, dpr: number): void {
    if (this.destroyed) return;
    this.viewport = { w: wCss, h: hCss };
    this.dpr = dpr;
    this.updateBackingStore();
    this.refresh(true);
  }

  setPose(pose: RenderPose): void {
    if (this.destroyed) return;
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.scale)
      || pose.scale <= 0 || (pose.facing !== 1 && pose.facing !== -1)) throw new RangeError('Invalid render pose');
    this.pose = { ...pose };
    this.refresh(true);
  }

  /** Only maps visual base loops; independent from authority/command results. */
  setBaseAction(semanticId: string): void {
    if (this.destroyed) return;
    this.baseAction = semanticId;
    this.active?.actions.setBaseAction(semanticId);
    this.refresh(false);
  }

  play(action: ActionRequest): Promise<ActionResult> {
    if (this.destroyed || !this.active) {
      return Promise.resolve({ requestId: action.requestId, status: 'failed' });
    }
    const result = this.active.actions.play(action);
    this.refresh(false);
    return result;
  }

  // Expressions remain unsupported. The exact pinned engineering atlases
  // have authored mouth pixels in their TALK/IDLE clips. An actual-audio
  // scalar may select those pixels; never invent a generic mouth on unknown
  // art or advance a talk frame solely from rendering elapsed time.
  setExpression(_id: string, _weight: number): void {}
  setMouth(sample: MouthSample): void {
    if (this.destroyed || this.paused || this.profile.reducedMotion || !this.active || !Number.isSafeInteger(sample.generation) || sample.generation < 0
      || !Number.isFinite(sample.open) || sample.open < 0 || sample.open > 1 || !Number.isFinite(sample.atMs) || sample.atMs < 0
      || sample.generation < this.mouthGeneration || (sample.generation === this.mouthGeneration && (!this.mouth || sample.atMs <= this.mouth.atMs))) return;
    this.mouthGeneration = sample.generation;
    this.mouth = { ...sample };
    this.refresh(false);
  }

  /** Idempotent cancellation barrier. The retired generation cannot reopen
   * the mouth even if a sample was already in the renderer's event queue. */
  clearMouth(): void {
    if (!this.mouth) return;
    this.mouth = null;
    this.refresh(false);
  }

  tick(dtSeconds: number): void {
    if (this.destroyed || this.paused || !Number.isFinite(dtSeconds) || dtSeconds <= 0 || !this.active) return;
    this.active.actions.tick(dtSeconds);
    const interval = 1000 / this.profile.maxFps;
    this.elapsedDrawMs = Math.min(interval, this.elapsedDrawMs + dtSeconds * 1000);
    if (this.elapsedDrawMs >= interval) this.refresh(false);
  }

  hitTest(xLocal: number, yLocal: number): HitRegion | null {
    const active = this.active;
    if (this.destroyed || !active || this.lastDrawn === null
      || xLocal < 0 || yLocal < 0 || xLocal >= this.viewport.w || yLocal >= this.viewport.h) return null;
    const manifest = active.pack.manifest;
    return hitTestModel(this.geometry(active), { x: xLocal, y: yLocal }, manifest.hitRegions);
  }

  setQuality(profile: RenderProfile): void {
    if (this.destroyed) return;
    assertProfile(profile);
    if (profile.reducedMotion) this.clearMouth();
    this.profile = { ...profile };
    this.updateBackingStore();
    this.refresh(true);
  }

  setPaused(paused: boolean): void {
    if (this.destroyed) return;
    this.paused = paused;
    this.active?.actions.setPaused(paused);
    if (paused) this.clearMouth();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mouth = null;
    this.pending?.abort(new DOMException('Canvas renderer destroyed', 'AbortError'));
    this.pending = undefined;
    const active = this.active;
    this.active = undefined;
    if (active) { active.actions.destroy(); closeBitmap(active.bitmap); }
    // Resetting the backing buffer clears pixels and releases the surface; it
    // does not change the DOM CSS layout. Repeated destroy is harmless.
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.lastDrawn = null;
    this.ctx = undefined;
    this.canvas = undefined;
  }

  private geometry(active: LoadedVariant) {
    const { logicalSize, anchor } = active.pack.manifest;
    return calculateModelGeometry(this.viewport, logicalSize, anchor, this.pose);
  }

  private async decodeVariant(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
    signal.throwIfAborted();
    const attempt = new AbortController();
    const onAbort = (): void => attempt.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => attempt.abort(new DOMException('Image decode timed out', 'TimeoutError')),
      this.decodeTimeoutMs);
    try {
      return await decodeAbortable(this.decode, bytes, attempt.signal);
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private updateBackingStore(): void {
    if (!this.canvas) return;
    const size = backingStoreSize(this.viewport, this.dpr, this.profile.resolutionScale);
    const usable = size !== null && size.w <= MAX_BACKING_EDGE && size.h <= MAX_BACKING_EDGE
      && size.w * size.h <= MAX_BACKING_PIXELS;
    const w = usable ? size.w : 0;
    const h = usable ? size.h : 0;
    // HTMLCanvasElement clears its bitmap and context state even when width
    // is assigned its existing value. Avoid unnecessary resets.
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private frame(active: LoadedVariant): Frame | null {
    const playing = active.actions.current;
    if (playing === null) return null;
    if (active.variant.renderer === 'static') {
      return { key: 'still', rect: [0, 0, active.bitmap.width, active.bitmap.height] };
    }
    // Reduced motion displays a clip's first frame. The pure action controller
    // still advances time so a finite one-shot can settle and return to base.
    const index = this.profile.reducedMotion ? 0 : playing.frameIndex;
    const selected = active.variant.atlas.clips[playing.clipId]?.frames[index];
    if (!selected) return null;
    const scalar = this.mouth && !this.paused && !this.profile.reducedMotion ? this.mouth.open : null;
    // A semantic CHAT/TALK motion without audible samples remains an
    // expressive pose with closed mouth, not fabricated speech animation.
    const mouth = scalar !== null || playing.semanticId === 'talk'
      ? authoredMouthPatch(active.pack, active.variant, playing.clipId, index, scalar ?? 0) : null;
    return { key: `${playing.clipId}:${index}${mouth ? `:mouth-${mouth.level}` : ''}`, rect: selected.rect, ...(mouth ? { mouth } : {}) };
  }

  private paint(active: LoadedVariant): string | null {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return null;
    const geometry = this.geometry(active);
    const frame = this.frame(active);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!geometry || !frame || canvas.width === 0 || canvas.height === 0) return null;
    // Draw in logical pixels using the same anchor/pose as CSS hit testing.
    // Effective physical scale accounts for rounded backing-buffer dimensions.
    const rx = canvas.width / this.viewport.w;
    const ry = canvas.height / this.viewport.h;
    const scaleX = geometry.scale * geometry.facing;
    const scaleY = geometry.scale;
    const translateX = geometry.anchorCss.x - geometry.modelAnchor.x * scaleX;
    const translateY = geometry.anchorCss.y - geometry.modelAnchor.y * scaleY;
    const transform = [rx * scaleX, 0, 0, ry * scaleY, rx * translateX, ry * translateY] as const;
    if (transform.some((value) => !Number.isFinite(value))) return null;
    ctx.setTransform(...transform);
    ctx.drawImage(active.bitmap, ...frame.rect, 0, 0, geometry.logicalSize.w, geometry.logicalSize.h);
    if (frame.mouth) ctx.drawImage(active.bitmap, ...frame.mouth.source, ...frame.mouth.destination);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return frame.key;
  }

  private refresh(force: boolean): void {
    const active = this.active;
    if (!active) { this.lastDrawn = null; return; }
    if (!force && this.lastDrawn !== null && this.frame(active)?.key === this.lastDrawn) return;
    try {
      this.lastDrawn = this.paint(active);
      this.elapsedDrawMs = 0;
    } catch {
      // Drawing/context failure: a stale logical region must not intercept
      // input. A future resize/tick may recover the same verified bitmap.
      this.lastDrawn = null;
    }
  }

  private clearSurface(): void {
    if (!this.ctx || !this.canvas) return;
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } catch { /* context is unavailable; do not mark an input region as ready */ }
    this.lastDrawn = null;
  }
}
