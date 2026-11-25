import { sameVoiceJob, voiceMouthNotificationSchema } from '../../shared/voice-ipc';
import type { VoiceOwnedJob } from '../../shared/voice-ipc';
import { MouthTimeline } from './mouth-timeline';
import type { MouthSample } from './contract';

export const MOUTH_STALE_MS = 180;
export type MouthProjectionResult = { readonly changed: false } | { readonly changed: true; readonly sample: MouthSample | null };
const IGNORED: MouthProjectionResult = Object.freeze({ changed: false });
const CLEAR: MouthProjectionResult = Object.freeze({ changed: true, sample: null });

/** Pet-side visual projection: begin/clear are exact generation barriers;
 * sample.atMs is the monotonically increasing actual AUDIO position, never
 * local animation elapsed time. Receipt time is solely a watchdog to close
 * a mouth if the producer/IPC disappears. */
export class VoiceMouthProjection {
  private readonly timeline = new MouthTimeline({ smoothingMs: 0 }); // analyser already smoothed RMS
  private generation = -1;
  private job: VoiceOwnedJob | null = null;
  private durationMs = 0;
  private lastAudioMs = -1;
  private lastReceiptMs = -1;
  private disposed = false;
  constructor(private readonly petId: string) {}
  get active(): boolean { return this.job !== null; }

  accept(raw: unknown, receiptMs: number, allowed: boolean): MouthProjectionResult {
    if (this.disposed || !Number.isFinite(receiptMs) || receiptMs < 0) return IGNORED;
    const parsed = voiceMouthNotificationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.job.petId !== this.petId) return IGNORED;
    const event = parsed.data;
    if (event.kind === 'begin') {
      if (event.job.generation <= this.generation) return IGNORED;
      this.retire(); this.generation = event.job.generation;
      if (!allowed || !this.timeline.begin(event.job.generation)) return CLEAR;
      this.job = event.job; this.durationMs = event.durationMs; this.lastReceiptMs = receiptMs;
      return CLEAR;
    }
    if (event.kind === 'clear') {
      if (event.job.generation > this.generation) { this.retire(); this.generation = event.job.generation; return CLEAR; }
      return this.job && sameVoiceJob(this.job, event.job) ? this.retire() : IGNORED;
    }
    if (!this.job || !sameVoiceJob(this.job, event.job)) return IGNORED;
    if (!allowed || receiptMs < this.lastReceiptMs || receiptMs - this.lastReceiptMs >= MOUTH_STALE_MS) return this.retire();
    const sample = event.sample;
    if (sample.atMs <= this.lastAudioMs || sample.atMs > this.durationMs) return IGNORED;
    const next: MouthSample = { generation: sample.generation, atMs: sample.atMs, open: sample.speaking ? sample.mouthOpen : 0,
      ...(sample.viseme === undefined ? {} : { viseme: sample.viseme }) };
    if (!this.timeline.push(next)) return IGNORED;
    this.lastAudioMs = sample.atMs; this.lastReceiptMs = receiptMs;
    const pose = this.timeline.sampleAt(sample.atMs);
    return { changed: true, sample: { generation: next.generation, atMs: next.atMs, ...pose } };
  }

  expire(receiptMs: number): MouthProjectionResult {
    return this.job && (!Number.isFinite(receiptMs) || receiptMs < this.lastReceiptMs || receiptMs - this.lastReceiptMs >= MOUTH_STALE_MS)
      ? this.retire() : IGNORED;
  }
  retire(): MouthProjectionResult {
    const hadJob = this.job !== null;
    this.job = null; this.durationMs = 0; this.lastAudioMs = -1; this.lastReceiptMs = -1;
    this.timeline.cancel();
    return hadJob ? CLEAR : IGNORED;
  }
  dispose(): void { this.retire(); this.disposed = true; this.timeline.close(); }
}
