import { MAX_VOICE_AUDIO_MS, voiceJobSchema, voiceMouthSampleSchema, voiceVisemeSchema } from '../../../../../packages/contracts/src/voice.js';
import type { VoiceJob, VoiceMouthSample, VoiceViseme } from '../../../../../packages/contracts/src/voice.js';
import type { MouthSample } from '../rendering/contract';

const MAX_ANALYSIS_SAMPLES = 8192;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** RMS only over bounded, finite analyser samples from the actual audio
 * output. This is a visual heuristic, not VAD or a recognition engine. */
export function waveformRms(samples: Float32Array): number | null {
  if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > MAX_ANALYSIS_SAMPLES) return null;
  let square = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.max(-1, Math.min(1, value));
    square += normalized * normalized;
  }
  return Math.sqrt(square / samples.length);
}

export interface PlaybackMouthSamplerOptions {
  readonly noiseFloor?: number;
  readonly gain?: number;
  readonly attackMs?: number;
  readonly releaseMs?: number;
  readonly maxHz?: number;
}

/** No wall-clock, timers, microphone or AudioContext. A production player
 * must supply actual consumed playback position and post-gain analyser
 * samples. The optional viseme timeline is advisory, never a clock source. */
export class PlaybackMouthSampler {
  private readonly noiseFloor: number;
  private readonly gain: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly intervalMs: number;
  private generation = -1;
  private currentJob: VoiceJob | null = null;
  private durationMs = 0;
  private lastAt = -1;
  private open = 0;
  private visemes: readonly VoiceViseme[] = [];

  constructor(options: PlaybackMouthSamplerOptions = {}) {
    this.noiseFloor = options.noiseFloor ?? .015;
    this.gain = options.gain ?? 8;
    this.attackMs = options.attackMs ?? 32;
    this.releaseMs = options.releaseMs ?? 80;
    const maxHz = options.maxHz ?? 30;
    if (!Number.isFinite(this.noiseFloor) || this.noiseFloor < 0 || this.noiseFloor >= 1
      || !Number.isFinite(this.gain) || this.gain <= 0 || this.gain > 100
      || !Number.isFinite(this.attackMs) || this.attackMs < 0 || this.attackMs > 1_000
      || !Number.isFinite(this.releaseMs) || this.releaseMs < 0 || this.releaseMs > 1_000
      || !Number.isFinite(maxHz) || maxHz < 1 || maxHz > 60) throw new RangeError('Invalid mouth sampler settings');
    this.intervalMs = 1000 / maxHz;
  }

  get currentOpen(): number { return this.open; }

  begin(rawJob: VoiceJob, durationMs: number, samples: readonly VoiceViseme[] = []): boolean {
    const job = voiceJobSchema.safeParse(rawJob);
    if (!job.success || job.data.generation <= this.generation || !Number.isFinite(durationMs)
      || durationMs <= 0 || durationMs > MAX_VOICE_AUDIO_MS || samples.length > 4096) return false;
    const checked: VoiceViseme[] = [];
    let last = -1;
    for (const input of samples) {
      const sample = voiceVisemeSchema.safeParse(input);
      if (!sample.success || sample.data.offsetMs <= last || sample.data.offsetMs > durationMs) return false;
      last = sample.data.offsetMs;
      checked.push(sample.data);
    }
    this.clear();
    this.generation = job.data.generation;
    this.currentJob = job.data;
    this.durationMs = durationMs;
    this.visemes = checked;
    return true;
  }

  sample(rawJob: VoiceJob, atMs: number, waveform: Float32Array): VoiceMouthSample | null {
    const job = this.currentJob;
    // The producer must keep its original job. A late analyser callback may
    // not be stamped with whichever new pet happens to own the channel now.
    if (!job || !sameJob(job, rawJob) || !Number.isFinite(atMs) || atMs < 0 || atMs > this.durationMs || atMs <= this.lastAt
      || (this.lastAt >= 0 && atMs - this.lastAt + 1e-9 < this.intervalMs)) return null;
    const rms = waveformRms(waveform);
    if (rms === null) return null;
    const target = clamp((rms - this.noiseFloor) * this.gain);
    const dt = this.lastAt < 0 ? this.intervalMs : atMs - this.lastAt;
    const tau = target > this.open ? this.attackMs : this.releaseMs;
    const alpha = tau === 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.open = clamp(this.open + (target - this.open) * alpha);
    if (target === 0 && this.open < .001) this.open = 0;
    this.lastAt = atMs;
    const speaking = this.open > 0;
    const viseme = speaking ? this.visemeAt(atMs) : undefined;
    return {
      petId: job.petId, turnId: job.turnId, generation: job.generation, atMs,
      mouthOpen: this.open, speaking, ...(viseme === undefined ? {} : { viseme }),
    };
  }

  /** Cancel/end/mute: clear immediately. No future sample from the same
   * generation may reopen the mouth; caller also clears its visual queue. */
  cancel(rawJob: VoiceJob): boolean {
    if (!this.currentJob || !sameJob(this.currentJob, rawJob)) return false;
    this.clear();
    return true;
  }

  private clear(): void {
    this.currentJob = null;
    this.durationMs = 0;
    this.lastAt = -1;
    this.open = 0;
    this.visemes = [];
  }

  private visemeAt(atMs: number): string | undefined {
    // Match only a position already reached on the actual playback clock.
    let lower = 0, upper = this.visemes.length - 1, best: VoiceViseme | undefined;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = this.visemes[middle]!;
      if (candidate.offsetMs <= atMs) { best = candidate; lower = middle + 1; }
      else upper = middle - 1;
    }
    return best && atMs - best.offsetMs <= 250 ? best.id : undefined;
  }
}

function sameJob(current: VoiceJob, input: VoiceJob): boolean {
  const parsed = voiceJobSchema.safeParse(input);
  return parsed.success && parsed.data.generation === current.generation && parsed.data.petId === current.petId
    && parsed.data.conversationId === current.conversationId && parsed.data.turnId === current.turnId
    && parsed.data.requestId === current.requestId;
}

/** The caller still routes the verified identity to the same pet and
 * generation; the model itself receives only this narrow visual contract. */
export function toRendererMouthSample(raw: unknown): MouthSample {
  const sample = voiceMouthSampleSchema.parse(raw);
  return { generation: sample.generation, atMs: sample.atMs, open: sample.mouthOpen,
    ...(sample.viseme === undefined ? {} : { viseme: sample.viseme }) };
}
