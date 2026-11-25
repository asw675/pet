import type { MouthSample } from './contract';

export interface MouthPose { readonly open: number; readonly viseme?: string }
export interface MouthTimelineOptions {
  /** Upper bound on unconsumed samples; never evict an earlier due sample for a later one. */
  readonly maxSamples?: number;
  /** A sample cannot be held beyond this many milliseconds of audio time. */
  readonly expiryMs?: number;
  /** Linear, short transition of the normalized openness; 0 disables smoothing. */
  readonly smoothingMs?: number;
}

const CLOSED: MouthPose = Object.freeze({ open: 0 });

/**
 * A visual-only lip-sync queue. The caller supplies the *actual audio playback*
 * relative time; neither wall clock nor renderer frame count is a clock source.
 * Each audio start owns a strictly increasing generation. Rejected, expired,
 * cancelled, or paused messages cannot resurrect previous mouth motion.
 */
export class MouthTimeline {
  private readonly maxSamples: number;
  private readonly expiryMs: number;
  private readonly smoothingMs: number;
  private generation = -1;
  private active = false;
  private paused = false;
  private closed = false;
  private lastPushedAtMs = -1;
  private lastClockAtMs = -1;
  private queue: MouthSample[] = [];
  private held: MouthSample | undefined;
  private currentPose: MouthPose = CLOSED;
  private transitionFromOpen = 0;

  constructor(options: MouthTimelineOptions = {}) {
    this.maxSamples = options.maxSamples ?? 256;
    this.expiryMs = options.expiryMs ?? 150;
    this.smoothingMs = options.smoothingMs ?? 40;
    if (!Number.isSafeInteger(this.maxSamples) || this.maxSamples < 1 || this.maxSamples > 4096
      || !Number.isFinite(this.expiryMs) || this.expiryMs <= 0
      || !Number.isFinite(this.smoothingMs) || this.smoothingMs < 0) {
      throw new RangeError('Invalid mouth timeline limits');
    }
  }

  get current(): MouthPose { return { ...this.currentPose }; }

  /** A fresh generation always resets both queue and mouth. */
  begin(generation: number): boolean {
    if (this.closed || !Number.isSafeInteger(generation) || generation < 0 || generation <= this.generation) return false;
    this.generation = generation;
    this.active = true;
    this.paused = false;
    this.lastPushedAtMs = -1;
    this.lastClockAtMs = -1;
    this.clearMotion();
    return true;
  }

  /** Accept one ordered, finite and normalized sample of the current generation. */
  push(sample: MouthSample): boolean {
    if (this.closed || !this.active || this.paused || sample.generation !== this.generation
      || !Number.isFinite(sample.atMs) || sample.atMs < 0 || sample.atMs <= this.lastPushedAtMs
      || sample.atMs < this.lastClockAtMs || !Number.isFinite(sample.open) || sample.open < 0 || sample.open > 1
      || (sample.viseme !== undefined && (typeof sample.viseme !== 'string' || sample.viseme.length === 0 || sample.viseme.length > 64))
      || this.queue.length >= this.maxSamples) return false;
    this.queue.push({ ...sample }); // Never retain a mutable object from the producer.
    this.lastPushedAtMs = sample.atMs;
    return true;
  }

  /** Render at the supplied audio position. Future samples are not consumed early. */
  sampleAt(atMs: number): MouthPose {
    if (!this.active || this.closed) return this.current;
    if (!Number.isFinite(atMs) || atMs < 0 || atMs < this.lastClockAtMs) {
      this.currentPose = CLOSED;
      return this.current;
    }

    this.lastClockAtMs = atMs;
    if (this.paused) return this.current;
    while (this.queue.length > 0 && this.queue[0]!.atMs <= atMs) {
      const next = this.queue.shift()!;
      // Anchor each short transition to the audio timestamp, rather than
      // integrating a per-render-frame lerp. Dense/sparse render ticks then
      // produce the same openness at a given audio position.
      this.transitionFromOpen = this.held && next.atMs - this.held.atMs < this.expiryMs
        ? this.openAt(next.atMs) : next.open;
      this.held = next;
    }
    if (!this.held || atMs - this.held.atMs >= this.expiryMs) {
      this.held = undefined;
      this.currentPose = CLOSED;
      return this.current;
    }

    const open = this.openAt(atMs);
    this.currentPose = this.held.viseme === undefined ? { open } : { open, viseme: this.held.viseme };
    return this.current;
  }

  /** Pause is an immediate closed-mouth transition, not a frozen-open pose. */
  pause(): void {
    if (!this.active || this.closed) return;
    this.paused = true;
    this.clearMotion();
    // Future samples were discarded; resume may refill from the current audio
    // clock rather than waiting for the old prefetch watermark.
    this.lastPushedAtMs = -1;
  }

  /** Fresh monotonically timestamped samples are required after resuming. */
  resume(): void {
    if (this.active && !this.closed) this.paused = false;
  }

  /** End, silence, or cancel a playback. The generation cannot be reopened. */
  cancel(): void {
    this.active = false;
    this.paused = false;
    this.clearMotion();
  }

  /** Disposing an adapter instance is terminal. */
  close(): void {
    this.cancel();
    this.closed = true;
  }

  private openAt(atMs: number): number {
    if (!this.held) return 0;
    const alpha = this.smoothingMs === 0 ? 1 : Math.max(0, Math.min(1, (atMs - this.held.atMs) / this.smoothingMs));
    return Math.max(0, Math.min(1, this.transitionFromOpen + (this.held.open - this.transitionFromOpen) * alpha));
  }

  private clearMotion(): void {
    this.queue = [];
    this.held = undefined;
    this.currentPose = CLOSED;
    this.transitionFromOpen = 0;
  }
}
