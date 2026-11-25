/** Packaged AudioWorklet module: no imports, network, DOM or device access.
 * The trusted renderer creates it only after a microphone grant. This module
 * downmixes/decimates render quanta without ever retaining a full recording. */
export const CAPTURE_OUTPUT_RATE = 16_000;
export const CAPTURE_BATCH_FRAMES = 320;
const MAX_CAPTURE_FRAMES = CAPTURE_OUTPUT_RATE * 30;
const MAX_INPUT_RATE = 192_000;
const MAX_CHANNELS = 8;
const MAX_QUANTUM_FRAMES = 4096;

function lowpass(sourceRate: number): Float64Array {
  if (sourceRate === CAPTURE_OUTPUT_RATE) return new Float64Array([1]);
  // Windowed-sinc low pass before decimation. Keep transition below the new
  // Nyquist frequency; this is a modest bounded FIR, not a quality SLA.
  const taps = 63;
  const middle = (taps - 1) / 2;
  const cutoff = .85 * CAPTURE_OUTPUT_RATE / (2 * sourceRate);
  const coefficients = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = .5 - .5 * Math.cos(2 * Math.PI * i / (taps - 1));
    coefficients[i] = sinc * window;
    sum += coefficients[i]!;
  }
  for (let i = 0; i < taps; i++) coefficients[i] = coefficients[i]! / sum;
  return coefficients;
}

/** Streaming mono PCM16 conversion. Filter history, interpolation phase and
 * partial output batch survive arbitrary AudioWorklet render quantum splits. */
export class Pcm16CaptureResampler {
  private readonly ratio: number;
  private readonly coefficients: Float64Array;
  private readonly history: Float64Array;
  private ring = 0;
  private inputIndex = -1;
  private previous = 0;
  private produced = 0;
  private batch = new Int16Array(CAPTURE_BATCH_FRAMES);
  private batchSize = 0;
  private finished = false;

  constructor(sourceRate: number, private readonly maxFrames: number, private readonly emit: (batch: Int16Array) => void) {
    if (!Number.isSafeInteger(sourceRate) || sourceRate < CAPTURE_OUTPUT_RATE || sourceRate > MAX_INPUT_RATE
      || !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_CAPTURE_FRAMES) throw new RangeError('Invalid capture bounds');
    this.ratio = sourceRate / CAPTURE_OUTPUT_RATE;
    this.coefficients = lowpass(sourceRate);
    this.history = new Float64Array(this.coefficients.length);
  }

  get frames(): number { return this.produced; }
  get limitReached(): boolean { return this.produced >= this.maxFrames; }

  push(channels: readonly Float32Array[]): void {
    if (this.finished || this.limitReached) return;
    const frames = channels[0]?.length ?? 0;
    if (channels.length === 0 || frames === 0) return;
    if (channels.length > MAX_CHANNELS || frames > MAX_QUANTUM_FRAMES
      || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) throw new RangeError('Invalid capture quantum');
    for (let input = 0; input < frames && !this.limitReached; input++) {
      let mono = 0;
      for (const channel of channels) {
        const sample = channel[input]!;
        if (!Number.isFinite(sample)) throw new RangeError('Invalid capture sample');
        mono += Math.max(-1, Math.min(1, sample));
      }
      mono /= channels.length;
      this.inputIndex++;
      const filtered = this.filter(mono);
      // Use an integer output index times the rational rate ratio rather
      // than a cumulatively rounded phase; at most one output/input sample.
      const outputAt = this.produced * this.ratio;
      if (outputAt <= this.inputIndex + 1e-9) {
        const fraction = this.inputIndex === 0 ? 1 : Math.max(0, Math.min(1, outputAt - (this.inputIndex - 1)));
        this.write(this.previous + (filtered - this.previous) * fraction);
      }
      this.previous = filtered;
    }
    if (this.limitReached) this.finish();
  }

  /** Retain no extra frames or invented silence on stop. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flushBatch();
  }

  private filter(value: number): number {
    this.history[this.ring] = value;
    let sum = 0, read = this.ring;
    for (const coefficient of this.coefficients) {
      sum += coefficient * this.history[read]!;
      read = read === 0 ? this.history.length - 1 : read - 1;
    }
    this.ring = (this.ring + 1) % this.history.length;
    return sum;
  }

  private write(value: number): void {
    const bounded = Math.max(-1, Math.min(1, value));
    this.batch[this.batchSize++] = Math.round(bounded < 0 ? bounded * 32768 : bounded * 32767);
    this.produced++;
    if (this.batchSize === this.batch.length) this.flushBatch();
  }

  private flushBatch(): void {
    if (this.batchSize === 0) return;
    const completed = this.batchSize === this.batch.length ? this.batch : this.batch.slice(0, this.batchSize);
    this.batch = new Int16Array(CAPTURE_BATCH_FRAMES);
    this.batchSize = 0;
    this.emit(completed);
  }
}

// AudioWorkletGlobalScope types are deliberately structural; the same pure
// resampler is imported by Node mock tests, where these globals don't exist.
interface ProcessorOptions { processorOptions?: { maxFrames?: number } }
declare const sampleRate: number;
declare const AudioWorkletProcessor: { new(options?: ProcessorOptions): { readonly port: MessagePort } };
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function' && typeof sampleRate === 'number') {
  class PetCaptureProcessor extends AudioWorkletProcessor {
    private resampler: Pcm16CaptureResampler | null = null;
    private sentLimit = false;
    private failed = false;

    constructor(options?: ProcessorOptions) {
      super(options);
      try {
        this.resampler = new Pcm16CaptureResampler(sampleRate, options?.processorOptions?.maxFrames ?? 0, samples => {
          this.port.postMessage({ type: 'PCM16', samples }, [samples.buffer as ArrayBuffer]);
        });
      } catch { this.fail(); }
      this.port.onmessage = event => {
        if (event.data?.type !== 'FLUSH' || this.failed) return;
        this.resampler?.finish();
        this.port.postMessage({ type: 'FLUSHED' });
      };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      // Never send microphone audio to speakers. The downstream actual gain
      // is also zero; a connected silent graph keeps the worklet processing.
      for (const output of outputs) for (const channel of output) channel.fill(0);
      if (!this.failed && this.resampler) {
        try {
          this.resampler.push(inputs[0] ?? []);
          if (this.resampler.limitReached && !this.sentLimit) {
            this.sentLimit = true;
            this.port.postMessage({ type: 'LIMIT_REACHED' });
          }
        } catch { this.fail(); }
      }
      return true; // bounded owner closes/disconnects the silent graph
    }

    private fail(): void {
      if (this.failed) return;
      this.failed = true;
      this.resampler = null;
      this.port.postMessage({ type: 'ERROR' });
    }
  }
  registerProcessor('pet-desktop-capture-v1', PetCaptureProcessor);
}
