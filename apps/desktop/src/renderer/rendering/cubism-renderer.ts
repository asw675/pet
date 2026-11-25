import type { ResolvedPack, ResolvedPackVariant } from '../../shared/resolve-character-pack';
import type { VisualRenderer } from './adaptive-renderer-host';
import type { ActionRequest, ActionResult, HitRegion, MouthSample, RenderPose, RenderProfile } from './contract';
import type { CubismRuntime, CubismSession } from './cubism-runtime';
import { backingStoreSize, calculateModelGeometry, hitTestModel } from './geometry';
import type { PixiHealth } from './pixi-renderer';

type Variant = Extract<ResolvedPackVariant, { renderer: 'cubism' }>;
const tapDuration = 0.36;
interface Active { readonly pack: ResolvedPack; readonly variant: Variant; readonly session: CubismSession }
interface Override {
  readonly request: ActionRequest;
  readonly end: number;
  readonly finish: (value: ActionResult) => void;
  readonly tap?: { readonly area: 'head' | 'body'; readonly start: number };
}

/** One canvas/context is owned by one independent, cancelable Cubism slot. */
export class CubismRenderer implements VisualRenderer {
  private canvas: HTMLCanvasElement | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private active: Active | undefined;
  private pending: AbortController | undefined;
  private override: Override | undefined;
  private destroyed = false;
  private lost = false;
  private frame = false;
  private paused = false;
  private viewport = { w: 0, h: 0 };
  private dpr = 1;
  private time = 0;
  private profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };
  private pose: RenderPose = { x: 0, y: 0, scale: 1, facing: 1 };
  private base = 'idle';
  private lookTarget = { x: 0, y: 0 };
  private look = { x: 0, y: 0 };
  private mouth: MouthSample | undefined;
  private mouthGeneration = -1;
  private mouthUntil = 0;

  constructor(private readonly runtime: CubismRuntime, private readonly onHealth: (event: PixiHealth) => void) {}

  get activeCharacterId(): string | null { return this.active?.pack.manifest.characterId ?? null; }
  get activeVariant(): Variant | null { return this.active?.variant ?? null; }
  get hasDrawnFrame(): boolean { return this.frame; }

  async init(canvas: HTMLCanvasElement, profile: RenderProfile): Promise<void> {
    if (this.destroyed || this.canvas) throw new Error('Cubism surface cannot initialize');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('Cubism requires WebGL2');
    this.canvas = canvas;
    this.gl = gl;
    this.profile = { ...profile };
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
  }

  async loadPack(pack: ResolvedPack, signal: AbortSignal): Promise<void> {
    if (this.destroyed || this.lost || !this.gl) throw new Error('Cubism surface unavailable');
    signal.throwIfAborted();
    const variant = pack.variants.find(v => v.renderer === 'cubism');
    if (!variant) throw new Error('Cubism variant missing');
    this.pending?.abort();
    const job = new AbortController();
    const relay = () => job.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    this.pending = job;
    this.releaseModel();
    let session: CubismSession | undefined;
    try {
      session = await this.runtime.load(this.gl, pack, variant, job.signal);
      job.signal.throwIfAborted();
      if (this.destroyed || this.lost || this.pending !== job) throw new Error('Cubism load superseded');
      this.active = { pack, variant, session };
      this.time = 0;
      this.look = { x: 0, y: 0 };
      this.mouth = undefined;
      this.startBase();
      this.draw(0);
      if (!this.frame) throw new Error('Cubism first frame unavailable');
    } catch (error) {
      if (session && this.active?.session === session) this.releaseModel();
      else session?.destroy();
      throw error;
    } finally {
      signal.removeEventListener('abort', relay);
      if (this.pending === job) this.pending = undefined;
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.viewport = { w, h };
    this.dpr = dpr;
    this.refresh();
  }
  setPose(pose: RenderPose): void { this.pose = { ...pose }; this.refresh(); }
  setLook(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.lookTarget = { x: clampLook(x), y: clampLook(y) };
  }
  setBaseAction(semanticId: string): void {
    if (this.base === semanticId) return;
    this.base = semanticId;
    if (semanticId === 'drag') {
      this.resetLook();
      this.finish('interrupted');
    }
    if (!this.override) this.startBase();
  }
  setExpression(id: string, weight: number): void {
    if (Number.isFinite(weight)) this.active?.session.expression(id, Math.max(0, Math.min(1, weight)));
  }
  setMouth(sample: MouthSample): void {
    if (!this.active || this.paused || this.profile.reducedMotion || !Number.isSafeInteger(sample.generation)
      || sample.generation < 0 || sample.generation < this.mouthGeneration || !Number.isFinite(sample.atMs) || sample.atMs < 0
      || !Number.isFinite(sample.open) || sample.open < 0 || sample.open > 1
      || (sample.generation === this.mouthGeneration && (!this.mouth || sample.atMs <= this.mouth.atMs))) return;
    this.mouth = { ...sample };
    this.mouthGeneration = sample.generation;
    this.mouthUntil = this.time + 0.15;
  }
  clearMouth(): void { if (this.mouth) { this.mouth = undefined; this.refresh(); } }
  setQuality(profile: RenderProfile): void {
    if (this.profile.reducedMotion === profile.reducedMotion && this.profile.maxFps === profile.maxFps
      && this.profile.resolutionScale === profile.resolutionScale) return;
    this.profile = { ...profile };
    if (profile.reducedMotion) {
      this.finish('interrupted');
      this.active?.session.stopMotions();
      this.clearMouth();
    }
    else if (!this.override) this.startBase();
    this.refresh();
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.resetLook();
      this.clearMouth();
    }
  }
  play(request: ActionRequest): Promise<ActionResult> {
    const reply = (status: ActionResult['status']) => Promise.resolve({ requestId: request.requestId, status });
    if (!this.active || this.destroyed || this.lost || this.paused) return reply('failed');
    if (this.profile.reducedMotion || this.override && request.priority < this.override.request.priority) return reply('interrupted');
    const duration = this.playSemantic(request.semanticId, request.loop);
    const area = request.semanticId === 'tap.head' ? 'head' : request.semanticId === 'tap.body' ? 'body' : undefined;
    const tap: Override['tap'] = duration === null && !request.loop && area ? { area, start: this.time } : undefined;
    if (duration === null && !tap) return reply('unsupported');
    const restoreBase = tap && this.override && !this.override.tap;
    this.finish('interrupted');
    if (restoreBase) this.startBase();
    const end = request.loop ? Infinity : this.time + (duration ?? tapDuration);
    return new Promise(finish => { this.override = { request, end, finish, ...(tap ? { tap } : {}) }; });
  }
  tick(dtSeconds: number): void {
    if (!this.active || this.paused || this.profile.reducedMotion || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const dt = Math.min(dtSeconds, 0.25);
    this.time += dt;
    const response = Math.min(1, dt * 8);
    this.look.x += (this.lookTarget.x - this.look.x) * response;
    this.look.y += (this.lookTarget.y - this.look.y) * response;
    if (this.override && this.time >= this.override.end) { this.finish('completed'); this.startBase(); }
    this.refresh(dt);
  }
  hitTest(x: number, y: number): HitRegion | null {
    if (!this.active || !this.frame) return null;
    return hitTestModel(this.geometry(), { x, y }, this.active.pack.manifest.hitRegions);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pending?.abort();
    this.releaseModel();
    this.canvas?.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.contextRestored);
    this.canvas = undefined;
    this.gl = undefined;
  }

  private contextLost = (event: Event): void => {
    event.preventDefault();
    if (this.destroyed || this.lost) return;
    this.lost = true;
    this.pending?.abort();
    this.releaseModel();
    this.onHealth('context-lost');
  };
  private contextRestored = (): void => {
    if (!this.lost || this.destroyed) return;
    this.lost = false;
    this.onHealth('context-restored');
  };
  private releaseModel(): void {
    this.finish('interrupted');
    this.frame = false;
    const previous = this.active;
    this.active = undefined;
    previous?.session.destroy();
  }
  private resetLook(): void {
    this.lookTarget = { x: 0, y: 0 };
    this.look = { ...this.lookTarget };
  }
  private playSemantic(semantic: string, loop: boolean): number | null {
    const active = this.active;
    const group = active?.pack.manifest.actions[semantic]?.[active.variant.id];
    return active && group ? active.session.play(group, loop) : null;
  }
  private startBase(): void {
    if (this.profile.reducedMotion) return;
    if (this.playSemantic(this.base, true) !== null || this.base !== 'idle' && this.playSemantic('idle', true) !== null) return;
    this.active?.session.stopMotions();
  }
  private finish(status: ActionResult['status']): void {
    const previous = this.override;
    this.override = undefined;
    if (previous) previous.finish({ requestId: previous.request.requestId, status });
  }
  private geometry() {
    const manifest = this.active?.pack.manifest;
    return manifest ? calculateModelGeometry(this.viewport, manifest.logicalSize, manifest.anchor, this.pose) : null;
  }
  private draw(dt: number): void {
    const canvas = this.canvas, geometry = this.geometry(), active = this.active;
    const size = backingStoreSize(this.viewport, this.dpr, this.profile.resolutionScale);
    if (!canvas || !geometry || !size || !active || this.lost || this.destroyed
      || size.w > 4096 || size.h > 4096 || size.w * size.h > 4 * 1024 * 1024) {
      this.frame = false;
      return;
    }
    if (canvas.width !== size.w) canvas.width = size.w;
    if (canvas.height !== size.h) canvas.height = size.h;
    const tap = this.override?.tap;
    active.session.draw(geometry, size.w, size.h, { seconds: this.time, dt,
      look: this.look, still: this.profile.reducedMotion,
      mouth: !this.paused && this.mouth && this.time < this.mouthUntil ? this.mouth.open : 0,
      sleep: this.base === 'sleep',
      ...(tap ? { tap: { area: tap.area, strength: Math.sin(Math.PI * (this.time - tap.start) / tapDuration) } } : {}),
    });
    this.frame = true;
  }
  private refresh(dt = 0): void {
    if (!this.active || this.destroyed || this.lost) return;
    try { this.draw(dt); }
    catch { this.releaseModel(); this.onHealth('render-error'); }
  }
}

function clampLook(value: number) { return Math.max(-1, Math.min(1, value)); }
