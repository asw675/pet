import type { ResolvedPack, ResolvedPackVariant } from '../../shared/resolve-character-pack';
import type { PetRenderer, RenderProfile, HitRegion, MouthSample, ActionRequest, ActionResult, RenderPose } from './contract';
import type { PixiHealth } from './pixi-renderer';

export type RenderBackend = 'cubism-webgl' | 'pixi-webgl' | 'canvas2d';
export interface VisualRenderer extends PetRenderer {
  readonly activeCharacterId: string | null;
  readonly activeVariant: ResolvedPackVariant | null;
  readonly hasDrawnFrame?: boolean;
  setBaseAction(semanticId: string): void;
  setLook?(x: number, y: number): void;
  clearMouth(): void;
}
export interface VisualSurface {
  readonly canvas: HTMLCanvasElement;
  show(visible: boolean): void;
  destroy(): void;
}
export interface AdaptiveRendererOptions {
  createSurface(backend: RenderBackend): VisualSurface;
  createRenderer(backend: RenderBackend, onHealth: (event: PixiHealth) => void): Promise<VisualRenderer> | VisualRenderer;
  onState(state: AdaptiveRenderState): void;
  /** Bound the retained, hidden lost WebGL context for possible restoration. */
  recoveryWindowMs?: number;
}
export interface AdaptiveRenderState {
  readonly characterId: string;
  readonly stage: 'loading' | 'ready' | 'fallback';
  readonly backend: RenderBackend | 'portrait' | null;
  /** Previous frame may remain visually visible while loading but is never a
   * hit target until the new requested identity commits. */
  readonly hasFrame: boolean;
}
interface Slot {
  backend: RenderBackend;
  surface: VisualSurface;
  renderer: VisualRenderer | undefined;
  retired: boolean;
}
interface Job { controller: AbortController; pack: ResolvedPack }
interface PortraitTap {
  request: ActionRequest;
  elapsed: number;
  finish(result: ActionResult): void;
}
function abort(message: string) { return new DOMException(message, 'AbortError'); }
function safely(action: () => void) { try { action(); } catch { /* independent teardown */ } }
/** A late factory may still resolve after cancellation; never attach it or
 * leave it undisposed. Renderer.init itself is also bounded by the adapter. */
function cancellable<T>(start: () => PromiseLike<T> | T, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => { done = true; signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { if (!done) { finish(); reject(signal.reason); } };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return start(); }).then(value => {
      if (!done) { finish(); resolve(value); } else if (late) safely(() => late(value));
    }, error => { if (!done) { finish(); reject(error); } });
  });
}
function retire(slot: Slot | undefined): void {
  if (!slot || slot.retired) return;
  slot.retired = true; if (slot.renderer) safely(() => slot.renderer!.destroy()); safely(() => slot.surface.destroy());
}
/** The browser binds a canvas to one context type. This supervisor never
 * calls Canvas2D on a WebGL-owned canvas. Each candidate uses a separate
 * hidden surface, then swaps atomically after one actually loaded frame.
 * The caller owns all RAF/visibility and verified pack resolution. */
export class AdaptiveRendererHost {
  private current: Slot | undefined;
  private staged: Slot | undefined;
  private lostSlot: Slot | undefined;
  private restored = false;
  private retireTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Job | undefined;
  private wanted: ResolvedPack | undefined;
  private requestedCharacterId: string | undefined;
  private disposed = false;
  private loading = false;
  private viewport = { w: 0, h: 0, dpr: 1 };
  private profile: RenderProfile = { maxFps: 30, resolutionScale: 1, reducedMotion: false };
  private pose: RenderPose = { x: 0, y: 0, scale: 1, facing: 1 };
  private paused = false;
  private baseAction = 'idle';
  private look = { x: 0, y: 0 };
  private portraitTap: PortraitTap | undefined;
  private portraitOffset: RenderPose | undefined;
  private readonly recoveryWindowMs: number;

  constructor(private readonly options: AdaptiveRendererOptions) {
    this.recoveryWindowMs = options.recoveryWindowMs ?? 8_000;
    if (!Number.isInteger(this.recoveryWindowMs) || this.recoveryWindowMs < 1 || this.recoveryWindowMs > 60_000) throw new RangeError('Invalid GPU recovery window');
  }
  get activeCharacterId(): string | null { return this.current?.renderer?.activeCharacterId ?? null; }
  get activeVariant(): ResolvedPackVariant | null { return this.current?.renderer?.activeVariant ?? null; }
  get backend(): RenderBackend | null { return this.current?.backend ?? null; }
  get hasFrame(): boolean { return !!this.current?.renderer && this.current.renderer.hasDrawnFrame !== false && this.activeCharacterId !== null; }
  get interactive(): boolean { return !this.disposed && !this.loading && this.hasFrame && this.wanted?.manifest.characterId === this.activeCharacterId; }

  async loadPack(pack: ResolvedPack, signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Render host destroyed');
    signal.throwIfAborted();
    this.resetPortrait();
    this.cancelPending();
    this.retireRecovery();
    this.wanted = pack;
    this.requestedCharacterId = pack.manifest.characterId;
    this.current?.renderer?.clearMouth();
    const internal = new AbortController(), job = { controller: internal, pack };
    const relay = () => internal.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    this.pending = job; this.loading = true; this.emit('loading');
    try {
      const backends: readonly RenderBackend[] = pack.variants.some(variant => variant.renderer === 'cubism')
        ? ['cubism-webgl', 'pixi-webgl', 'canvas2d'] : ['pixi-webgl', 'canvas2d'];
      await this.tryBackends(job, backends);
    } finally {
      signal.removeEventListener('abort', relay);
      this.finishJob(job);
    }
  }
  /** Signal a new requested visual before pack verification finishes; old
   * pixels may remain, but input/voice for the old identity is blocked. */
  invalidate(characterId: string): void {
    if (this.disposed) return;
    this.resetPortrait();
    this.cancelPending(); this.retireRecovery(); this.wanted = undefined;
    this.requestedCharacterId = characterId;
    this.loading = true; this.current?.renderer?.clearMouth(); this.emit('loading');
  }
  showPortrait(characterId: string): void {
    if (this.disposed) return;
    this.resetPortrait();
    this.cancelPending(); this.retireRecovery();
    this.wanted = undefined; this.requestedCharacterId = characterId;
    retire(this.current); this.current = undefined; this.loading = false; this.emit('fallback');
  }
  resize(w: number, h: number, dpr: number): void {
    if (this.disposed) return;
    this.viewport = { w, h, dpr };
    for (const slot of [this.current, this.staged]) slot?.renderer?.resize(w, h, dpr);
  }
  setQuality(profile: RenderProfile): void {
    if (this.disposed) return;
    this.profile = { ...profile };
    if (profile.reducedMotion) this.resetPortrait();
    for (const slot of [this.current, this.staged]) slot?.renderer?.setQuality(profile);
  }
  setPose(pose: RenderPose): void {
    if (this.disposed) return;
    this.pose = { ...pose }; this.portraitOffset = undefined;
    for (const slot of [this.current, this.staged]) slot?.renderer?.setPose(pose);
  }
  setBaseAction(semanticId: string): void {
    this.baseAction = semanticId; for (const slot of [this.current, this.staged]) slot?.renderer?.setBaseAction(semanticId);
  }
  setLook(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.look = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    for (const slot of [this.current, this.staged]) slot?.renderer?.setLook?.(this.look.x, this.look.y);
  }
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    if (paused) this.resetPortrait();
    this.paused = paused; for (const slot of [this.current, this.staged]) slot?.renderer?.setPaused(paused);
  }
  clearMouth(): void { this.current?.renderer?.clearMouth(); }
  setMouth(sample: MouthSample): void { if (this.interactive && !this.paused) this.current?.renderer?.setMouth(sample); }
  tick(dtSeconds: number): void {
    if (this.disposed) return;
    const renderer = this.current?.renderer;
    if (renderer?.activeVariant?.renderer === 'static' && this.interactive && !this.paused && !this.profile.reducedMotion
      && Number.isFinite(dtSeconds) && dtSeconds > 0) this.paintPortraitFeedback(renderer, Math.min(dtSeconds, 0.1));
    renderer?.tick(dtSeconds);
  }
  play(action: ActionRequest): Promise<ActionResult> {
    const renderer = this.current?.renderer;
    if (!this.interactive || !renderer) return Promise.resolve({ requestId: action.requestId, status: 'failed' });
    const variant = renderer.activeVariant;
    // A verified static fallback can acknowledge a tap through its existing
    // geometry. Authored sprite and Cubism actions stay with their adapters.
    if (variant?.renderer !== 'static' || action.loop || (action.semanticId !== 'tap.head' && action.semanticId !== 'tap.body')
      || this.wanted?.manifest.actions[action.semanticId]?.[variant.id]) return renderer.play(action);
    if (this.paused || this.profile.reducedMotion || this.portraitTap && action.priority < this.portraitTap.request.priority) {
      return Promise.resolve({ requestId: action.requestId, status: 'interrupted' });
    }
    this.finishPortraitTap('interrupted');
    return new Promise(finish => { this.portraitTap = { request: action, elapsed: 0, finish }; });
  }
  hitTest(x: number, y: number): HitRegion | null { return this.interactive ? this.current?.renderer?.hitTest(x, y) ?? null : null; }
  destroy(): void {
    if (this.disposed) return;
    this.resetPortrait();
    this.disposed = true; this.cancelPending(); this.retireRecovery(); retire(this.current); this.current = undefined; this.wanted = undefined;
  }

  private finishPortraitTap(status: 'completed' | 'interrupted'): void {
    const tap = this.portraitTap;
    this.portraitTap = undefined;
    tap?.finish({ requestId: tap.request.requestId, status });
  }

  private resetPortrait(): void {
    this.finishPortraitTap('interrupted');
    if (this.portraitOffset) this.current?.renderer?.setPose(this.pose);
    this.portraitOffset = undefined;
  }

  private paintPortraitFeedback(renderer: VisualRenderer, dt: number): void {
    const tap = this.portraitTap;
    if (tap && (tap.elapsed += dt) >= 0.32) this.finishPortraitTap('completed');
    const bounce = this.portraitTap ? Math.sin(Math.PI * this.portraitTap.elapsed / 0.32) : 0;
    const distance = Math.min(5, Math.max(0, this.viewport.h) * 0.025);
    const previous = this.portraitOffset ?? this.pose;
    const blend = Math.min(1, dt * 13);
    const approach = (before: number, target: number, threshold: number): number =>
      Math.abs(before - target) < threshold ? target : before + (target - before) * blend;
    const pose = {
      ...this.pose,
      x: approach(previous.x, this.pose.x + this.look.x * distance, 0.02),
      y: approach(previous.y, this.pose.y - this.look.y * distance - bounce * distance * 0.7, 0.02),
      scale: this.pose.scale * (1 + bounce * 0.035),
    };
    if (previous.x === pose.x && previous.y === pose.y && previous.scale === pose.scale) return;
    this.portraitOffset = pose;
    renderer.setPose(pose);
  }

  private emit(stage: AdaptiveRenderState['stage']): void {
    if (this.disposed || !this.requestedCharacterId) return;
    safely(() => this.options.onState({ characterId: this.requestedCharacterId!, stage,
      backend: stage === 'fallback' && !this.current ? 'portrait' : this.backend, hasFrame: this.hasFrame }));
  }
  private cancelPending(): void {
    const old = this.pending; this.pending = undefined;
    old?.controller.abort(abort('Render host load superseded'));
    retire(this.staged); this.staged = undefined;
  }
  private live(job: Job): boolean { return !this.disposed && this.pending === job && !job.controller.signal.aborted && this.wanted === job.pack; }
  private finishJob(job: Job): void {
    if (this.pending !== job) return;
    this.pending = undefined; this.loading = false;
    // Loss might have restored while the independent Canvas2D was loading.
    // Start one bounded recovery after fallback settles, not a retry loop.
    if (this.restored) this.startRecovery();
  }
  private configure(slot: Slot): void {
    const renderer = slot.renderer!;
    renderer.setQuality(this.profile); renderer.setPose(this.pose); renderer.setBaseAction(this.baseAction);
    renderer.setLook?.(this.look.x, this.look.y);
    renderer.setPaused(this.paused); renderer.resize(this.viewport.w, this.viewport.h, this.viewport.dpr);
  }
  private async build(job: Job, backend: RenderBackend, recovered?: Slot): Promise<Slot> {
    const slot = recovered ?? { backend, surface: this.options.createSurface(backend), renderer: undefined, retired: false };
    this.staged = slot;
    try {
      if (!this.live(job)) throw abort('Obsolete visual load');
      slot.surface.show(false);
      if (!slot.renderer) {
        const renderer = await cancellable(() => this.options.createRenderer(backend, event => this.health(slot, event)),
          job.controller.signal, renderer => renderer.destroy());
        if (slot.retired || !this.live(job)) { renderer.destroy(); throw abort('Obsolete renderer factory'); }
        slot.renderer = renderer;
        await cancellable(() => renderer.init(slot.surface.canvas, this.profile), job.controller.signal);
      }
      if (!this.live(job) || slot.retired) throw abort('Obsolete renderer init');
      this.configure(slot);
      await cancellable(() => slot.renderer!.loadPack(job.pack, job.controller.signal), job.controller.signal);
      if (!this.live(job) || slot.retired) throw abort('Obsolete renderer load');
      // Reapply changed viewport/preferences/activity captured during decode.
      this.configure(slot);
      if (slot.renderer.activeCharacterId !== job.pack.manifest.characterId || slot.renderer.hasDrawnFrame === false) throw new Error('Visual not ready');
      return slot;
    } catch (error) {
      retire(slot); if (this.staged === slot) this.staged = undefined; throw error;
    }
  }
  private promote(job: Job, slot: Slot): void {
    if (!this.live(job) || slot.retired) { retire(slot); throw abort('Obsolete visual promotion'); }
    const old = this.current;
    if (old !== slot) this.resetPortrait();
    this.current = slot; if (this.staged === slot) this.staged = undefined;
    this.loading = false;
    // A previous surface stays visible until the verified candidate is ready.
    slot.surface.show(true);
    if (old && old !== slot) { old.surface.show(false); retire(old); }
    this.emit('ready');
  }
  private async tryBackends(job: Job, backends: readonly RenderBackend[]): Promise<void> {
    for (const backend of backends) {
      if (!this.live(job)) throw job.controller.signal.reason ?? abort('Obsolete visual load');
      try { this.promote(job, await this.build(job, backend)); return; }
      catch (error) { if (!this.live(job)) throw job.controller.signal.reason ?? error; }
    }
    // No actual render adapter succeeded. Do not masquerade a different
    // character as this one. The caller may show a non-interactive portrait.
    if (this.live(job)) {
      retire(this.current); this.current = undefined; this.loading = false; this.emit('fallback');
    }
  }
  private health(slot: Slot, event: PixiHealth): void {
    if (this.disposed || slot.retired) return;
    if (event === 'context-restored') {
      if (slot === this.lostSlot && !this.restored) {
        this.restored = true;
        if (this.retireTimer !== undefined) clearTimeout(this.retireTimer);
        this.retireTimer = undefined;
        if (!this.pending) this.startRecovery();
      }
      return;
    }
    // Candidate renderers own their own failure/abort; never let a stale
    // candidate's GPU event degrade a different already active surface.
    if (slot !== this.current) return;
    this.finishPortraitTap('interrupted');
    this.portraitOffset = undefined;
    if (!this.wanted) {
      // A new requested pack is being verified outside this host.
      this.current = undefined; slot.surface.show(false); retire(slot); this.emit('loading'); return;
    }
    const pack = this.wanted;
    if (this.pending && slot.renderer?.activeCharacterId !== pack.manifest.characterId) {
      // Another character is already being prepared. The retiring old GPU
      // cannot cancel or replace that newer request.
      this.current = undefined; slot.surface.show(false); retire(slot); this.emit('loading'); return;
    }
    this.cancelPending(); this.retireRecovery();
    this.current = undefined; slot.surface.show(false); slot.renderer?.clearMouth();
    if (event === 'context-lost') {
      this.lostSlot = slot; this.restored = false;
      this.retireTimer = setTimeout(() => this.retireRecovery(), this.recoveryWindowMs);
    } else retire(slot);
    const job = { controller: new AbortController(), pack };
    this.pending = job; this.loading = true; this.emit('loading');
    void this.tryBackends(job, ['canvas2d']).catch(() => {}).finally(() => this.finishJob(job));
  }
  private retireRecovery(): void {
    if (this.retireTimer !== undefined) clearTimeout(this.retireTimer);
    this.retireTimer = undefined; this.restored = false; retire(this.lostSlot); this.lostSlot = undefined;
  }
  private startRecovery(): void {
    if (this.disposed || this.pending || !this.wanted || !this.lostSlot || !this.restored) return;
    const slot = this.lostSlot, pack = this.wanted; this.lostSlot = undefined; this.restored = false;
    const job = { controller: new AbortController(), pack }; this.pending = job;
    // Existing verified Canvas2D remains interactive while recovery is staged
    // (same character). No visual identity change or new message authority.
    this.loading = !this.current;
    void this.build(job, slot.backend, slot).then(candidate => this.promote(job, candidate), () => {
      if (this.live(job) && !this.current) { this.loading = false; this.emit('fallback'); }
    }).catch(() => {}).finally(() => this.finishJob(job));
  }
}
