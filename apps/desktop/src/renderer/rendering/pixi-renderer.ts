import type { ResolvedPack, ResolvedPackVariant } from '../../shared/resolve-character-pack';
import { ActionController, type AnimationClip } from './action-controller';
import { authoredMouthPatch } from './authored-mouth';
import type { ActionRequest, ActionResult, HitRegion, MouthSample, PetRenderer, RenderPose, RenderProfile } from './contract';
import { backingStoreSize, calculateModelGeometry, hitTestModel, type Size } from './geometry';
import type { PixiAtlasResource, PixiContextEvent, PixiFrame, PixiRuntime, PixiSurface } from './pixi-v8-runtime';

export type PixiBitmapDecoder = (bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<ImageBitmap>;
export type PixiHealth = PixiContextEvent | 'render-error';
export interface PixiRendererOptions {
  runtime: PixiRuntime;
  decode?: PixiBitmapDecoder;
  decodeTimeoutMs?: number;
  initTimeoutMs?: number;
  /** Owner can stage a fresh Canvas2D fallback surface on loss/error and
   * reload a verified pack on a new WebGL surface upon recovery. */
  onHealth?: (health: PixiHealth) => void;
}
interface Active {
  pack: ResolvedPack;
  variant: Exclude<ResolvedPackVariant, { renderer: 'cubism' }>;
  bitmap: ImageBitmap;
  resource: PixiAtlasResource;
  actions: ActionController;
}
interface Frame extends PixiFrame { key: string }
function validateProfile(profile: RenderProfile) {
  if ((profile.maxFps !== 15 && profile.maxFps !== 30) || !Number.isFinite(profile.resolutionScale)
    || profile.resolutionScale <= 0 || profile.resolutionScale > 1 || typeof profile.reducedMotion !== 'boolean') throw new RangeError('Invalid Pixi render profile');
}
function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new RangeError('Invalid Pixi deadline');
  return value;
}
function safe(action: () => void) { try { action(); } catch { /* finish other independent cleanup */ } }
function interrupted(message: string) { return new DOMException(message, 'AbortError'); }
/** Reject promptly even if an SDK init/browser decode ignores cancellation;
 * release a later successful resource rather than promoting it. */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal, disposeLate: (value: T) => void): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let pending = true;
    const finish = () => { pending = false; signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { if (pending) { finish(); reject(signal.reason); } };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return start(); }).then(value => {
      if (pending) { finish(); resolve(value); } else safe(() => disposeLate(value));
    }, error => { if (pending) { finish(); reject(error); } });
  });
}
async function decodeBitmap(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
  signal.throwIfAborted();
  // Runtime ImageSource declares premultiplied-alpha. Decode accordingly;
  // actual alpha visual correctness is part of the Windows GPU POC.
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'premultiply' });
}
function makeActions(pack: ResolvedPack, variant: ResolvedPackVariant): ActionController {
  const clips: Readonly<Record<string, AnimationClip>> = variant.renderer === 'sprite' ? variant.atlas.clips : { idle: { frames: [{ durationMs: 1000 }] } };
  return new ActionController(clips, Object.fromEntries(Object.entries(pack.manifest.actions).flatMap(([semantic, variants]) => {
    const clip = variants[variant.id]; return clip === undefined ? [] : [[semantic, clip]];
  })));
}
function release(active: Active): void {
  active.actions.destroy(); safe(() => active.resource.destroy()); safe(() => active.bitmap.close());
}

/** Pixi WebGL adapter (actual pinned SDK runtime or test injection). It
 * uses the same pure actions, geometry and actual-audio authored mouth as
 * the independent Canvas2D fallback. No ticker/IPC/game state owned here. */
export class PixiRenderer implements PetRenderer {
  private readonly runtime: PixiRuntime;
  private readonly decode: PixiBitmapDecoder;
  private readonly decodeDeadline: number;
  private readonly initDeadline: number;
  private readonly onHealth: (health: PixiHealth) => void;
  private surface: PixiSurface | undefined;
  private initializing: AbortController | undefined;
  private pending: AbortController | undefined;
  private active: Active | undefined;
  private surfaceEpoch = 0;
  private destroyed = false;
  private lost = false;
  private drawFault = false;
  private profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };
  private pose: RenderPose = { x: 0, y: 0, scale: 1, facing: 1 };
  private viewport: Size = { w: 0, h: 0 };
  private dpr = 1;
  private backing: Size | null = null;
  private baseAction = 'idle';
  private paused = false;
  private lastFrame: string | null = null;
  private elapsedMs = 0;
  private mouth: MouthSample | null = null;
  private mouthGeneration = -1;

  constructor(options: PixiRendererOptions) {
    this.runtime = options.runtime; this.decode = options.decode ?? decodeBitmap;
    this.decodeDeadline = validateTimeout(options.decodeTimeoutMs ?? 8_000);
    this.initDeadline = validateTimeout(options.initTimeoutMs ?? 8_000);
    this.onHealth = options.onHealth ?? (() => {});
  }
  get activeVariant(): ResolvedPackVariant | null { return this.active?.variant ?? null; }
  get activeCharacterId(): string | null { return this.active?.pack.manifest.characterId ?? null; }
  get hasDrawnFrame(): boolean { return !this.destroyed && !this.lost && !this.drawFault && this.lastFrame !== null; }

  async init(canvas: HTMLCanvasElement, profile: RenderProfile): Promise<void> {
    if (this.destroyed || this.surface || this.initializing) throw new Error('Pixi renderer cannot initialize twice');
    validateProfile(profile); this.profile = { ...profile };
    const controller = new AbortController();
    const epoch = ++this.surfaceEpoch;
    this.initializing = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Pixi init timed out', 'TimeoutError')), this.initDeadline);
    let candidate: PixiSurface | undefined;
    try {
      candidate = await abortable(() => this.runtime.createSurface(canvas, event => {
        if (this.surfaceEpoch === epoch) this.contextEvent(event);
      }), controller.signal, value => value.destroy());
      controller.signal.throwIfAborted();
      if (this.destroyed || this.lost || this.initializing !== controller) throw interrupted('Pixi initialization superseded');
      this.surface = candidate; this.updateBacking(); candidate = undefined;
    } catch (error) {
      if (candidate) safe(() => candidate!.destroy());
      if (this.surfaceEpoch === epoch) this.surfaceEpoch++;
      this.surface = undefined; throw error;
    } finally {
      clearTimeout(timer); if (this.initializing === controller) this.initializing = undefined;
    }
  }
  async loadPack(pack: ResolvedPack, signal: AbortSignal): Promise<void> {
    if (!this.surface || this.destroyed || this.lost) throw new Error('Pixi WebGL renderer unavailable');
    signal.throwIfAborted();
    this.clearMouth();
    if (!this.surface || this.destroyed || this.lost) throw new Error('Pixi WebGL renderer unavailable');
    this.pending?.abort(interrupted('Superseded character load'));
    const current = new AbortController(); this.pending = current;
    const relay = () => current.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    const variants = [...pack.variants.filter(v => v.renderer === 'sprite'), ...pack.variants.filter(v => v.renderer === 'static')];
    let failure: unknown;
    try {
      for (const variant of variants) {
        let bitmap: ImageBitmap | undefined, resource: PixiAtlasResource | undefined, actions: ActionController | undefined;
        try {
          current.signal.throwIfAborted();
          const bytes = pack.readAsset(variant.imagePath);
          if (!bytes) throw new Error('Verified image unavailable');
          bitmap = await this.decodeAttempt(bytes, current.signal);
          current.signal.throwIfAborted();
          if (bitmap.width !== variant.imageSize.w || bitmap.height !== variant.imageSize.h) throw new Error('Decoded dimensions differ from verified PNG');
          if (this.destroyed || this.lost || this.pending !== current || !this.surface) throw interrupted('Pixi load superseded');
          resource = this.surface.createResource(bitmap);
          actions = makeActions(pack, variant);
          actions.setBaseAction(this.baseAction); actions.setPaused(this.paused);
          const next = { pack, variant, bitmap, resource, actions };
          let frame: string | null;
          try {
            frame = this.paint(next);
            current.signal.throwIfAborted();
            if (this.destroyed || this.lost || this.pending !== current) throw interrupted('Pixi load superseded');
          }
          catch (error) {
            // A bad candidate must not overwrite the prior visible frame.
            // Restore it if the same context is still healthy.
            if (this.active && !this.lost && !this.destroyed) this.refresh(true);
            else if (!this.lost) safe(() => this.surface?.clear());
            throw error;
          }
          const old = this.active;
          this.active = next; this.lastFrame = frame; this.drawFault = false; this.elapsedMs = 0;
          bitmap = undefined; resource = undefined; actions = undefined;
          if (old) release(old);
          return;
        } catch (error) {
          actions?.destroy();
          if (resource) safe(() => resource!.destroy());
          if (bitmap) safe(() => bitmap!.close());
          current.signal.throwIfAborted(); failure = error;
        }
      }
      throw new Error('No usable Pixi character variant', { cause: failure });
    } finally { signal.removeEventListener('abort', relay); if (this.pending === current) this.pending = undefined; }
  }
  resize(wCss: number, hCss: number, dpr: number): void {
    if (this.destroyed) return;
    this.viewport = { w: wCss, h: hCss }; this.dpr = dpr;
    try { this.updateBacking(); this.refresh(true); } catch { this.flagFault(); }
  }
  setPose(pose: RenderPose): void {
    if (this.destroyed) return;
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.scale) || pose.scale <= 0
      || (pose.facing !== 1 && pose.facing !== -1)) throw new RangeError('Invalid Pixi pose');
    this.pose = { ...pose }; this.refresh(true);
  }
  setBaseAction(semanticId: string): void {
    if (this.destroyed) return;
    this.baseAction = semanticId; this.active?.actions.setBaseAction(semanticId); this.refresh(false);
  }
  play(action: ActionRequest): Promise<ActionResult> {
    if (this.destroyed || this.lost || this.drawFault || !this.active) return Promise.resolve({ requestId: action.requestId, status: 'failed' });
    const result = this.active.actions.play(action); this.refresh(false); return result;
  }
  setExpression(_id: string, _weight: number): void { /* no authored expression channel in these packs */ }
  setMouth(sample: MouthSample): void {
    if (this.destroyed || this.lost || this.paused || this.profile.reducedMotion || !this.active
      || !Number.isSafeInteger(sample.generation) || sample.generation < 0 || !Number.isFinite(sample.open) || sample.open < 0 || sample.open > 1
      || !Number.isFinite(sample.atMs) || sample.atMs < 0 || sample.generation < this.mouthGeneration
      || (sample.generation === this.mouthGeneration && (!this.mouth || sample.atMs <= this.mouth.atMs))) return;
    this.mouthGeneration = sample.generation; this.mouth = { ...sample }; this.refresh(false);
  }
  clearMouth(): void { if (this.mouth) { this.mouth = null; this.refresh(false); } }
  tick(dtSeconds: number): void {
    if (this.destroyed || this.lost || this.paused || !this.active || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    this.active.actions.tick(dtSeconds);
    const interval = 1000 / this.profile.maxFps;
    this.elapsedMs = Math.min(interval, this.elapsedMs + dtSeconds * 1000);
    if (this.elapsedMs >= interval) this.refresh(false);
  }
  hitTest(xLocal: number, yLocal: number): HitRegion | null {
    const active = this.active;
    if (!active || !this.hasDrawnFrame) return null;
    return hitTestModel(this.geometry(active), { x: xLocal, y: yLocal }, active.pack.manifest.hitRegions);
  }
  setQuality(profile: RenderProfile): void {
    if (this.destroyed) return;
    validateProfile(profile); if (profile.reducedMotion) this.clearMouth();
    this.profile = { ...profile };
    try { this.updateBacking(); this.refresh(true); } catch { this.flagFault(); }
  }
  setPaused(paused: boolean): void {
    if (this.destroyed) return;
    this.paused = paused; this.active?.actions.setPaused(paused); if (paused) this.clearMouth();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.surfaceEpoch++; this.mouth = null; this.lastFrame = null;
    this.initializing?.abort(interrupted('Pixi renderer destroyed'));
    this.pending?.abort(interrupted('Pixi renderer destroyed')); this.pending = undefined;
    const active = this.active; this.active = undefined;
    if (active) release(active);
    const surface = this.surface; this.surface = undefined;
    if (surface) safe(() => surface.destroy());
  }
  private contextEvent(event: PixiContextEvent): void {
    if (this.destroyed || (event === 'context-lost' && this.lost) || (event === 'context-restored' && !this.lost)) return;
    this.lost = event === 'context-lost'; this.lastFrame = null; this.mouth = null; this.drawFault = false;
    if (this.lost) {
      this.initializing?.abort(interrupted('WebGL context lost'));
      this.pending?.abort(interrupted('WebGL context lost'));
      const active = this.active; this.active = undefined;
      if (active) release(active);
    } else {
      // Recovery is not "ready" until a fresh verified pack loads. In case
      // the host kept the surface, reapply physical size but never replay
      // old actions, speech samples or unverified resource state.
      try { this.updateBacking(); } catch { this.flagFault(); }
    }
    safe(() => this.onHealth(event));
  }
  private flagFault(): void {
    this.lastFrame = null;
    if (!this.drawFault && !this.lost && !this.destroyed) {
      this.drawFault = true;
      safe(() => this.onHealth('render-error'));
    }
  }
  private updateBacking(): void {
    if (!this.surface || this.lost) return;
    const next = backingStoreSize(this.viewport, this.dpr, this.profile.resolutionScale);
    this.backing = next && next.w <= 4096 && next.h <= 4096 && next.w * next.h <= 4 * 1024 * 1024 ? next : null;
    this.surface.resize(this.backing ?? { w: 1, h: 1 });
    if (!this.backing) { this.surface.clear(); this.lastFrame = null; }
  }
  private geometry(active: Active) {
    return calculateModelGeometry(this.viewport, active.pack.manifest.logicalSize, active.pack.manifest.anchor, this.pose);
  }
  private frame(active: Active): Frame | null {
    const playing = active.actions.current;
    if (!playing) return null;
    if (active.variant.renderer === 'static') return { key: 'still', rect: [0, 0, active.bitmap.width, active.bitmap.height] };
    const index = this.profile.reducedMotion ? 0 : playing.frameIndex;
    const frame = active.variant.atlas.clips[playing.clipId]?.frames[index];
    if (!frame) return null;
    const scalar = this.mouth && !this.paused && !this.profile.reducedMotion ? this.mouth.open : null;
    const mouth = scalar !== null || playing.semanticId === 'talk'
      ? authoredMouthPatch(active.pack, active.variant, playing.clipId, index, scalar ?? 0) : null;
    return { rect: frame.rect, key: `${playing.clipId}:${index}${mouth ? `:mouth-${mouth.level}` : ''}`, ...(mouth ? { mouth } : {}) };
  }
  private paint(active: Active): string | null {
    if (!this.surface || this.lost) throw new Error('Pixi WebGL surface unavailable');
    const geometry = this.geometry(active), frame = this.frame(active);
    if (!this.backing || !geometry || !frame) { this.surface.clear(); return null; }
    this.surface.draw(active.resource, frame, geometry); return frame.key;
  }
  private refresh(force: boolean): void {
    const active = this.active;
    if (!active || this.lost || this.destroyed) return;
    if (!force && this.lastFrame !== null && this.frame(active)?.key === this.lastFrame) return;
    try { this.lastFrame = this.paint(active); this.elapsedMs = 0; this.drawFault = false; }
    catch { this.flagFault(); }
  }
  private async decodeAttempt(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<ImageBitmap> {
    signal.throwIfAborted();
    const attempt = new AbortController(), relay = () => attempt.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => attempt.abort(new DOMException('Pixi image decode timed out', 'TimeoutError')), this.decodeDeadline);
    try { return await abortable(() => this.decode(bytes, attempt.signal), attempt.signal, value => value.close()); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', relay); }
  }
}
