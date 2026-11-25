import { describe, expect, it, vi } from 'vitest';
import { inspectVoiceAudio } from '../../../packages/contracts/src/voice.js';
import type { VoiceAudio, VoiceEvent, VoiceJob } from '../../../packages/contracts/src/voice.js';
import { CAPTURE_BATCH_FRAMES, Pcm16CaptureResampler } from '../src/renderer/voice/audio-capture-worklet';
import { encodeRecordedPcm, WebAudioVoiceAdapter } from '../src/renderer/voice/audio-adapter';
import type { VoiceAudioDependencies, VoiceAudioTimerPort, VoiceMicrophoneGrant } from '../src/renderer/voice/audio-adapter';
import type { VoiceEffect } from '../src/renderer/voice/voice-session';

const job = (generation = 1, petId = 'pet-a') => ({ petId, conversationId: `conv-${petId}`, turnId: `voice-${generation}`, requestId: `chat-${generation}`, generation });
const capture = (id = job(), maxDurationMs = 30_000): Extract<VoiceEffect, { type: 'START_CAPTURE' }> =>
  ({ type: 'START_CAPTURE', job: id, sampleRate: 16000, channels: 1, codec: 'wav', maxDurationMs });
const oneSecond = () => encodeRecordedPcm(new Int16Array(16_000).fill(8_000));
const playable = (id = job(), audio: VoiceAudio = oneSecond(), volume = .7): Extract<VoiceEffect, { type: 'PREPARE_PLAYBACK' }> =>
  ({ type: 'PREPARE_PLAYBACK', job: id, audio, volume, visemes: [] });
const gesture = { isTrusted: true, type: 'pointerdown' } as Event;
const notGesture = { isTrusted: false, type: 'pointerdown' } as Event;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

class FakeTimers implements VoiceAudioTimerPort {
  private sequence = 0;
  readonly timeouts = new Map<number, { callback: () => void; ms: number }>();
  readonly intervals = new Map<number, { callback: () => void; ms: number }>();
  after(callback: () => void, ms: number) { const id = ++this.sequence; this.timeouts.set(id, { callback, ms }); return id; }
  clearAfter(handle: unknown) { this.timeouts.delete(handle as number); }
  every(callback: () => void, ms: number) { const id = ++this.sequence; this.intervals.set(id, { callback, ms }); return id; }
  clearEvery(handle: unknown) { this.intervals.delete(handle as number); }
  fireAfter(ms: number) { for (const [id, timer] of [...this.timeouts]) if (timer.ms === ms && this.timeouts.delete(id)) timer.callback(); }
  tick() { for (const timer of [...this.intervals.values()]) timer.callback(); }
}

class FakeNode {
  readonly links: FakeNode[] = [];
  readonly connect = vi.fn((node: FakeNode) => { this.links.push(node); return node; });
  readonly disconnect = vi.fn(() => { this.links.length = 0; });
}
class FakeTrack {
  readyState = 'live';
  channelCount = 2;
  sampleRate = 48_000;
  readonly ended = new Set<() => void>();
  getSettings() { return { channelCount: this.channelCount, sampleRate: this.sampleRate }; }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.ended.add(listener); }
  removeEventListener(type: string, listener: () => void) { if (type === 'ended') this.ended.delete(listener); }
  readonly stop = vi.fn(() => { this.readyState = 'ended'; });
  end() { this.readyState = 'ended'; for (const callback of [...this.ended]) callback(); }
}
class FakeStream {
  readonly track = new FakeTrack();
  readonly extraTracks: FakeTrack[] = [];
  getAudioTracks() { return [this.track]; }
  getVideoTracks() { return this.extraTracks; }
  getTracks() { return [this.track, ...this.extraTracks]; }
}
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent = vi.fn();
  readonly postMessage = (data: unknown) => this.sent(data);
  readonly close = vi.fn();
  emit(data: unknown) { this.onmessage?.({ data }); }
}
class FakeWorklet extends FakeNode {
  readonly port = new FakePort();
  onprocessorerror: (() => void) | null = null;
}
class FakeGain extends FakeNode { readonly gain = { value: 1 }; }
class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  readonly start = vi.fn((_at: number) => {});
  readonly stop = vi.fn();
  end() { this.onended?.(); }
}
class FakeAnalyser extends FakeNode {
  fftSize = 1024;
  waveform = .25;
  readonly getFloatTimeDomainData = vi.fn((target: Float32Array) => target.fill(this.waveform));
}
function fakeBuffer(duration = 1, numberOfChannels = 1): AudioBuffer {
  return { duration, numberOfChannels, sampleRate: 48_000, length: Math.round(duration * 48_000) } as AudioBuffer;
}
class FakeContext {
  sampleRate = 48_000;
  currentTime = 10;
  state = 'running';
  destination = new FakeNode();
  onstatechange: (() => void) | null = null;
  readonly media = new FakeNode();
  readonly source = new FakeSource();
  readonly analyser = new FakeAnalyser();
  readonly gains: FakeGain[] = [];
  readonly resume = vi.fn(async () => { this.state = 'running'; });
  readonly close = vi.fn(async () => { this.state = 'closed'; });
  readonly createMediaStreamSource = vi.fn(() => this.media);
  readonly createBufferSource = vi.fn(() => this.source);
  readonly createAnalyser = vi.fn(() => this.analyser);
  readonly createGain = vi.fn(() => { const node = new FakeGain(); this.gains.push(node); return node; });
  readonly decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => fakeBuffer());
  suspend() { this.state = 'suspended'; this.onstatechange?.(); }
}

function harness(overrides: {
  grant?: (id: VoiceJob) => Promise<VoiceMicrophoneGrant | null>;
  media?: () => Promise<MediaStream>;
  worklet?: () => Promise<AudioWorkletNode>;
  configure?: (kind: 'capture' | 'playback', context: FakeContext) => void;
} = {}) {
  const events: VoiceEvent[] = [], timers = new FakeTimers(), streams: FakeStream[] = [], worklets: FakeWorklet[] = [];
  const contexts: Record<'capture' | 'playback', FakeContext[]> = { capture: [], playback: [] };
  const request = vi.fn(overrides.grant ?? (async (id: VoiceJob) => ({ grantId: `grant-${id.generation}`, job: id })));
  const revoke = vi.fn(async (_grant: VoiceMicrophoneGrant) => {});
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (overrides.media) return overrides.media();
    const stream = new FakeStream(); streams.push(stream); return stream as unknown as MediaStream;
  });
  const createCaptureWorklet = vi.fn(async (_context: AudioContext, _maxFrames: number) => {
    if (overrides.worklet) return overrides.worklet();
    const worklet = new FakeWorklet(); worklets.push(worklet); return worklet as unknown as AudioWorkletNode;
  });
  const createContext = vi.fn((kind: 'capture' | 'playback') => {
    const context = new FakeContext(); overrides.configure?.(kind, context); contexts[kind].push(context); return context as unknown as AudioContext;
  });
  const dependencies: VoiceAudioDependencies = { isExplicitGesture: action => action.isTrusted && action.type === 'pointerdown',
    getUserMedia, createCaptureWorklet, createContext, timers };
  const adapter = new WebAudioVoiceAdapter({ broker: { request, revoke }, emit: event => events.push(event), dependencies });
  return { adapter, events, timers, streams, worklets, contexts, request, revoke, getUserMedia, createCaptureWorklet, createContext };
}
const eventTypes = (events: readonly VoiceEvent[]) => events.map(event => event.type);
async function start(h = harness(), id = job(), maxMs = 30_000) {
  expect(h.adapter.beginCapture(capture(id, maxMs), gesture)).toBe(true);
  await settle();
  expect(h.events.at(-1)).toMatchObject({ type: 'CAPTURE_STARTED', job: id });
  return h;
}
function pcm(worklet: FakeWorklet, fill = 7_500, frames = CAPTURE_BATCH_FRAMES) { worklet.port.emit({ type: 'PCM16', samples: new Int16Array(frames).fill(fill) }); }
async function startPlaying(h = harness(), id = job()) {
  expect(h.adapter.primePlaybackFromGesture(id, gesture)).toBe(true);
  expect(h.adapter.preparePlayback(playable(id))).toBe(true);
  await settle();
  expect(h.events.at(-1)).toMatchObject({ type: 'PLAYBACK_STARTED', job: id, durationMs: 1000 });
  return h;
}

describe('Bounded capture worklet resampling and WAV encoding', () => {
  it('downmixes actual channels, clips to PCM16 and flushes only captured frames', () => {
    const batches: Int16Array[] = [];
    const resampler = new Pcm16CaptureResampler(16_000, 100, frames => batches.push(frames));
    resampler.push([new Float32Array([1, -1, .5, 2]), new Float32Array([1, -1, -.5, 1])]);
    resampler.finish(); resampler.finish();
    expect(resampler.frames).toBe(4);
    expect([...batches[0]!]).toEqual([32767, -32768, 0, 32767]);
    expect(batches).toHaveLength(1);
  });

  it('produces an identical bounded output across noninteger-rate quantum splits', () => {
    const samples = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 44_100));
    const run = (quantum: number) => {
      const output: number[] = [], resampler = new Pcm16CaptureResampler(44_100, 1600, frames => output.push(...frames));
      for (let at = 0; at < samples.length; at += quantum) resampler.push([samples.subarray(at, at + quantum)]);
      resampler.finish(); return output;
    };
    expect(run(128)).toEqual(run(101));
    expect(run(128)).toHaveLength(1600);
  });

  it('suppresses high-frequency alias energy before 48 kHz to 16 kHz decimation', () => {
    const rms = (frequency: number) => {
      const result: number[] = [];
      const resampler = new Pcm16CaptureResampler(48_000, 1600, frames => result.push(...frames));
      for (let i = 0; i < 4800; i += 128) resampler.push([Float32Array.from({ length: Math.min(128, 4800 - i) }, (_, j) => Math.sin(2 * Math.PI * frequency * (i + j) / 48_000))]);
      resampler.finish();
      const stable = result.slice(128);
      return Math.sqrt(stable.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / stable.length);
    };
    expect(rms(2000)).toBeGreaterThan(.55);
    expect(rms(12000)).toBeLessThan(rms(2000) * .15);
  });

  it('stops exactly at the frame budget, emits bounded batches and refuses invalid samples/rates', () => {
    const sizes: number[] = [];
    const limited = new Pcm16CaptureResampler(48_000, 1000, frames => sizes.push(frames.length));
    limited.push([new Float32Array(4096).fill(.5)]); limited.push([new Float32Array(128).fill(.5)]);
    limited.finish();
    expect(limited.frames).toBe(1000); expect(limited.limitReached).toBe(true);
    expect(sizes).toEqual([320, 320, 320, 40]);
    expect(() => new Pcm16CaptureResampler(8_000, 100, () => {})).toThrow();
    const invalid = new Pcm16CaptureResampler(16_000, 100, () => {});
    expect(() => invalid.push([new Float32Array([NaN])])).toThrow();
    expect(() => invalid.push([new Float32Array(1), new Float32Array(2)])).toThrow();
  });

  it('encodes exact signed little-endian PCM16 mono WAV with bounded length', () => {
    const audio = encodeRecordedPcm(new Int16Array([-32768, -1, 0, 32767]));
    expect(inspectVoiceAudio(audio)).toMatchObject({ frames: 4, sampleRate: 16_000, channels: 1, pcmOffset: 44 });
    expect([...audio.bytes.subarray(44)]).toEqual([0, 128, 255, 255, 0, 0, 255, 127]);
    expect(() => encodeRecordedPcm(new Int16Array(0))).toThrow();
    expect(() => encodeRecordedPcm(new Int16Array(480001))).toThrow();
  });
});

describe('Explicit microphone activation, bounded capture and stale resource cleanup', () => {
  it('does not even request authorization or hardware without a trusted gesture', () => {
    const h = harness();
    expect(h.adapter.beginCapture(capture(), notGesture)).toBe(false);
    expect(h.request).not.toHaveBeenCalled(); expect(h.getUserMedia).not.toHaveBeenCalled(); expect(h.createContext).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ type: 'FAILED', job: job(), phase: 'RECORDING', code: 'permission_denied' }]);
  });

  it('waits for exact grant before requesting mono microphone and constructs a silent output worklet graph', async () => {
    const waiting = deferred<VoiceMicrophoneGrant | null>();
    const h = harness({ grant: () => waiting.promise });
    expect(h.adapter.beginCapture(capture(), gesture)).toBe(true);
    expect(h.request).toHaveBeenCalledWith(job());
    expect(h.getUserMedia).not.toHaveBeenCalled();
    waiting.resolve({ grantId: 'grant-1', job: job() }); await settle();
    expect(h.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    expect(h.createCaptureWorklet).toHaveBeenCalledWith(h.contexts.capture[0], 480000);
    const ctx = h.contexts.capture[0]!, worklet = h.worklets[0]!;
    expect(ctx.media.links).toEqual([worklet]); expect(worklet.links).toEqual([ctx.gains[0]]);
    expect(ctx.gains[0]?.gain.value).toBe(0); expect(ctx.gains[0]?.links).toEqual([ctx.destination]);
    expect(eventTypes(h.events)).toEqual(['CAPTURE_STARTED']);
    h.adapter.dispose();
  });

  it('drops denied/mismatched grants and never requests getUserMedia before broker success', async () => {
    for (const grant of [null, { grantId: 'wrong', job: job(2) }]) {
      const h = harness({ grant: async () => grant });
      h.adapter.beginCapture(capture(), gesture); await settle();
      expect(h.getUserMedia).not.toHaveBeenCalled();
      expect(h.contexts.capture[0]?.close).toHaveBeenCalledOnce();
      expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', code: 'permission_denied' });
      if (grant) expect(h.revoke).toHaveBeenCalledWith(grant);
    }
  });

  it('stops every capture track and revokes immediately, then flushes bounded WAV without losing queued final PCM', async () => {
    const h = await start(), worklet = h.worklets[0]!, stream = h.streams[0]!, ctx = h.contexts.capture[0]!;
    pcm(worklet); pcm(worklet, -6000, 64);
    expect(h.adapter.stopCapture(job())).toBe(true);
    expect(stream.track.stop).toHaveBeenCalledOnce(); expect(h.revoke).toHaveBeenCalledOnce();
    expect(ctx.media.disconnect).toHaveBeenCalledOnce();
    expect(worklet.port.sent).toHaveBeenCalledWith({ type: 'FLUSH' });
    expect(ctx.close).not.toHaveBeenCalled();
    h.adapter.releaseCapture(job()); // coordinator's paired hardware release must not discard flush
    pcm(worklet, 7000, 32); worklet.port.emit({ type: 'FLUSHED' });
    const finished = h.events.at(-1);
    if (finished?.type !== 'RECORDING_DONE') throw new Error('Expected confirmed recording');
    expect(inspectVoiceAudio(finished.audio)).toMatchObject({ frames: 416, channels: 1, sampleRate: 16_000 });
    expect(ctx.close).toHaveBeenCalledOnce(); expect(worklet.port.close).toHaveBeenCalledOnce(); expect(h.timers.timeouts.size).toBe(0);
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('enforces a frame cap without waiting for a coordinator reply and exactly finalizes the allowed recording', async () => {
    const h = await start(harness(), job(), 100), worklet = h.worklets[0]!;
    for (let i = 0; i < 5; i++) pcm(worklet);
    expect(eventTypes(h.events)).toEqual(['CAPTURE_STARTED', 'RECORDING_LIMIT_REACHED']);
    expect(h.streams[0]?.track.stop).toHaveBeenCalledOnce();
    worklet.port.emit({ type: 'LIMIT_REACHED' }); worklet.port.emit({ type: 'FLUSHED' });
    const result = h.events.at(-1);
    if (result?.type !== 'RECORDING_DONE') throw new Error('Expected capped recording');
    expect(inspectVoiceAudio(result.audio).durationMs).toBe(100);
    expect(eventTypes(h.events)).toEqual(['CAPTURE_STARTED', 'RECORDING_LIMIT_REACHED', 'RECORDING_DONE']);
  });

  it('uses a separate ownership deadline for stalled worklet and rejects silent/empty recordings', async () => {
    const h = await start(harness(), job(), 100);
    h.timers.fireAfter(100);
    expect(h.streams[0]?.track.stop).toHaveBeenCalledOnce(); expect(h.events.at(-1)?.type).toBe('RECORDING_LIMIT_REACHED');
    h.worklets[0]!.port.emit({ type: 'FLUSHED' });
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'TRANSCRIBING', code: 'no_speech' });
    const silent = await start(harness()); pcm(silent.worklets[0]!, 0); silent.adapter.stopCapture(job()); silent.worklets[0]!.port.emit({ type: 'FLUSHED' });
    expect(silent.events.at(-1)).toMatchObject({ type: 'FAILED', code: 'no_speech' });
  });

  it('fails on malformed PCM batches, device loss or AudioContext suspension and cleans all handles', async () => {
    for (const failure of ['malformed', 'track', 'context'] as const) {
      const h = await start();
      if (failure === 'malformed') h.worklets[0]!.port.emit({ type: 'PCM16', samples: new Int16Array(321) });
      else if (failure === 'track') h.streams[0]!.track.end(); else h.contexts.capture[0]!.suspend();
      expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'RECORDING', code: failure === 'malformed' ? 'invalid_audio' : 'device_lost' });
      expect(h.streams[0]?.track.stop).toHaveBeenCalledOnce(); expect(h.worklets[0]?.port.close).toHaveBeenCalledOnce();
      expect(h.contexts.capture[0]?.close).toHaveBeenCalledOnce(); expect(h.timers.timeouts.size).toBe(0);
    }
  });

  it('clears a timeout or cancellation during worklet flush without transmitting truncated audio', async () => {
    for (const cancel of [false, true]) {
      const h = await start(); const port = h.worklets[0]!.port; pcm(h.worklets[0]!);
      h.adapter.stopCapture(job()); const oldCallback = port.onmessage!;
      if (cancel) h.adapter.stopPlayback(job()); else h.timers.fireAfter(250);
      oldCallback({ data: { type: 'FLUSHED' } });
      expect(h.events.some(event => event.type === 'RECORDING_DONE')).toBe(false);
      expect(h.contexts.capture[0]?.close).toHaveBeenCalledOnce(); expect(h.streams[0]?.track.stop).toHaveBeenCalledOnce();
      if (!cancel) expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'TRANSCRIBING', code: 'timeout' });
    }
  });

  it('cancels a pending grant immediately; late approval is revoked and cannot open a microphone', async () => {
    const waiting = deferred<VoiceMicrophoneGrant | null>(), h = harness({ grant: () => waiting.promise });
    h.adapter.beginCapture(capture(), gesture); h.adapter.stopPlayback(job());
    expect(h.contexts.capture[0]?.close).toHaveBeenCalledOnce();
    waiting.resolve({ grantId: 'late', job: job() }); await settle();
    expect(h.revoke).toHaveBeenCalledWith({ grantId: 'late', job: job() }); expect(h.getUserMedia).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    expect(h.adapter.beginCapture(capture(), gesture)).toBe(false);
  });

  it('releases a stream returned after cancellation of getUserMedia without connecting any graph', async () => {
    const waiting = deferred<MediaStream>(), h = harness({ media: () => waiting.promise });
    h.adapter.beginCapture(capture(), gesture); await settle();
    expect(h.getUserMedia).toHaveBeenCalledOnce();
    h.adapter.cancelJob(job()); const stream = new FakeStream(); waiting.resolve(stream as unknown as MediaStream); await settle();
    expect(stream.track.stop).toHaveBeenCalledOnce(); expect(h.revoke).toHaveBeenCalledOnce();
    expect(h.createCaptureWorklet).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
  });

  it('bounds even invalidated permission/device calls and never opens additional hardware until the old browser promise settles', async () => {
    const waiting = deferred<MediaStream>();
    let pendingFirst = true;
    const h = harness({ media: async () => {
      if (pendingFirst) { pendingFirst = false; return waiting.promise; }
      return new FakeStream() as unknown as MediaStream;
    }});
    h.adapter.beginCapture(capture(), gesture); await settle();
    h.adapter.cancelJob(job());
    expect(h.adapter.beginCapture(capture(job(2)), gesture)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', job: job(2), code: 'unavailable' });
    expect(h.getUserMedia).toHaveBeenCalledOnce(); expect(h.contexts.capture).toHaveLength(1);
    const stale = new FakeStream(); waiting.resolve(stale as unknown as MediaStream); await settle();
    expect(stale.track.stop).toHaveBeenCalledOnce();
    expect(h.adapter.beginCapture(capture(job(3)), gesture)).toBe(true); await settle();
    expect(h.events.at(-1)).toMatchObject({ type: 'CAPTURE_STARTED', job: job(3) });
    h.adapter.dispose();
  });

  it('disconnects a worklet that finishes loading after stale capture teardown', async () => {
    const waiting = deferred<AudioWorkletNode>(), h = harness({ worklet: () => waiting.promise });
    h.adapter.beginCapture(capture(), gesture); await settle();
    expect(h.createCaptureWorklet).toHaveBeenCalledOnce(); h.adapter.cancelJob(job());
    const node = new FakeWorklet(); waiting.resolve(node as unknown as AudioWorkletNode); await settle();
    expect(node.disconnect).toHaveBeenCalledOnce(); expect(node.port.close).toHaveBeenCalledOnce(); expect(h.events).toEqual([]);
    expect(h.streams[0]?.track.stop).toHaveBeenCalledOnce();
  });

  it('sanitizes browser permission failures and releases unused grant/context on timeout', async () => {
    const denied = harness({ media: async () => { throw { name: 'NotAllowedError', stack: 'private-device-stack' }; } });
    denied.adapter.beginCapture(capture(), gesture); await settle();
    expect(denied.events).toEqual([{ type: 'FAILED', job: job(), phase: 'RECORDING', code: 'permission_denied' }]);
    expect(denied.revoke).toHaveBeenCalledOnce(); expect(denied.contexts.capture[0]?.close).toHaveBeenCalledOnce();
    const waiting = deferred<VoiceMicrophoneGrant | null>(), timeout = harness({ grant: () => waiting.promise });
    timeout.adapter.beginCapture(capture(), gesture); timeout.timers.fireAfter(20_000);
    expect(timeout.events.at(-1)).toMatchObject({ type: 'FAILED', code: 'timeout' });
    waiting.resolve({ grantId: 'late', job: job() }); await settle();
    expect(timeout.revoke).toHaveBeenCalledOnce(); expect(timeout.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('Complete bounded Web Audio playback and actual-clock mouth samples', () => {
  it('requires explicit prior playback priming; async prepare cannot unlock autoplay on its own', async () => {
    const h = await start(); pcm(h.worklets[0]!); h.adapter.stopCapture(job()); h.worklets[0]!.port.emit({ type: 'FLUSHED' });
    expect(h.adapter.primePlaybackFromGesture(job(), notGesture)).toBe(false);
    expect(h.adapter.preparePlayback(playable())).toBe(false);
    expect(h.contexts.playback).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'TTS_PENDING', code: 'playback_failed' });
  });

  it('decodes a complete validated WAV and connects source → gain → analyser → destination', async () => {
    const h = await startPlaying(), ctx = h.contexts.playback[0]!;
    expect(ctx.decodeAudioData).toHaveBeenCalledOnce(); expect(ctx.createBufferSource).toHaveBeenCalledOnce();
    expect(ctx.source.links).toEqual([ctx.gains[0]]); expect(ctx.gains[0]?.gain.value).toBe(.7);
    expect(ctx.gains[0]?.links).toEqual([ctx.analyser]); expect(ctx.analyser.links).toEqual([ctx.destination]);
    expect(ctx.source.start).toHaveBeenCalledWith(10);
    expect(h.adapter.preparePlayback(playable())).toBe(false);
    h.adapter.dispose();
  });

  it('uses actual absolute context clock deltas, not scheduling wall time, for normalized post-gain mouth samples', async () => {
    const h = await startPlaying(), ctx = h.contexts.playback[0]!;
    ctx.currentTime = 10.05; h.timers.tick();
    const first = h.events.at(-1);
    if (first?.type !== 'PLAYBACK_SAMPLE') throw new Error('Expected analyser-derived scalar');
    expect(first.atMs).toBeCloseTo(50); expect(first.mouthOpen).toBeGreaterThan(0); expect(first.mouthOpen).toBeLessThanOrEqual(1);
    expect(ctx.analyser.getFloatTimeDomainData).toHaveBeenCalledOnce();
    const count = h.events.length; h.timers.tick(); expect(h.events).toHaveLength(count);
    ctx.currentTime = 10.1; h.timers.tick(); expect(h.events.at(-1)).toMatchObject({ type: 'PLAYBACK_SAMPLE', job: job() });
    h.adapter.dispose();
  });

  it('wraps raw validated PCM into complete RIFF before decode and rejects malformed audio before decoder', async () => {
    const raw: VoiceAudio = { bytes: new Uint8Array(32_000), codec: 'pcm_s16le', sampleRate: 16_000, channels: 1 };
    const h = harness(); h.adapter.primePlaybackFromGesture(job(), gesture); h.adapter.preparePlayback(playable(job(), raw)); await settle();
    const input = h.contexts.playback[0]!.decodeAudioData.mock.calls[0]![0];
    expect(inspectVoiceAudio({ bytes: new Uint8Array(input), codec: 'wav', sampleRate: 16_000, channels: 1 }).frames).toBe(16_000);
    h.adapter.dispose();
    const invalid = harness(); invalid.adapter.primePlaybackFromGesture(job(), gesture);
    expect(invalid.adapter.preparePlayback(playable(job(), { ...raw, bytes: new Uint8Array(3) }))).toBe(false);
    expect(invalid.contexts.playback[0]?.decodeAudioData).not.toHaveBeenCalled();
    expect(invalid.events.at(-1)).toMatchObject({ type: 'FAILED', code: 'invalid_audio' });
  });

  it('clears source/gain/analyser/context and mouth timer on natural completion, ignoring late callbacks', async () => {
    const h = await startPlaying(), ctx = h.contexts.playback[0]!;
    const late = ctx.source.onended!, timer = [...h.timers.intervals.values()][0]!.callback;
    ctx.source.end(); late(); timer();
    expect(eventTypes(h.events)).toEqual(['PLAYBACK_STARTED', 'PLAYBACK_ENDED']);
    expect(ctx.source.stop).toHaveBeenCalledOnce(); expect(ctx.source.disconnect).toHaveBeenCalledOnce();
    expect(ctx.gains[0]?.disconnect).toHaveBeenCalledOnce(); expect(ctx.analyser.disconnect).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce(); expect(h.timers.intervals.size).toBe(0); expect(h.timers.timeouts.size).toBe(0);
  });

  it('rejects decode duration/channel mismatch and a thrown source.start as a TTS-pending failure', async () => {
    for (const error of ['duration', 'channels', 'start'] as const) {
      const h = harness({ configure(kind, ctx) {
        if (kind !== 'playback') return;
        if (error === 'duration') ctx.decodeAudioData.mockResolvedValue(fakeBuffer(2));
        else if (error === 'channels') ctx.decodeAudioData.mockResolvedValue(fakeBuffer(1, 2));
        else ctx.source.start.mockImplementation(() => { throw new Error('raw browser error'); });
      }});
      h.adapter.primePlaybackFromGesture(job(), gesture); h.adapter.preparePlayback(playable()); await settle();
      expect(h.events).toEqual([{ type: 'FAILED', job: job(), phase: 'TTS_PENDING', code: error === 'start' ? 'playback_failed' : 'invalid_audio' }]);
      expect(h.contexts.playback[0]?.close).toHaveBeenCalledOnce();
    }
  });

  it('cancels a pending decode; a late AudioBuffer never starts any source', async () => {
    const decode = deferred<AudioBuffer>();
    const h = harness({ configure(kind, ctx) { if (kind === 'playback') ctx.decodeAudioData.mockReturnValue(decode.promise); } });
    h.adapter.primePlaybackFromGesture(job(), gesture); h.adapter.preparePlayback(playable()); await settle();
    h.adapter.stopPlayback(job()); decode.resolve(fakeBuffer()); await settle();
    expect(h.contexts.playback[0]?.createBufferSource).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    expect(h.contexts.playback[0]?.close).toHaveBeenCalledOnce();
  });

  it('does not enqueue another decode buffer while a stale browser decode promise is unresolved', async () => {
    const decode = deferred<AudioBuffer>();
    let first = true;
    const h = harness({ configure(kind, ctx) { if (kind === 'playback' && first) { first = false; ctx.decodeAudioData.mockReturnValue(decode.promise); } } });
    h.adapter.primePlaybackFromGesture(job(), gesture); h.adapter.preparePlayback(playable()); await settle();
    h.adapter.cancelJob(job());
    const next = job(2, 'pet-b'); h.adapter.primePlaybackFromGesture(next, gesture);
    expect(h.adapter.preparePlayback(playable(next))).toBe(false);
    expect(h.contexts.playback[1]?.decodeAudioData).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', job: next, code: 'unavailable' });
    decode.resolve(fakeBuffer()); await settle();
    const last = job(3, 'pet-c'); expect(h.adapter.primePlaybackFromGesture(last, gesture)).toBe(true);
    expect(h.adapter.preparePlayback(playable(last))).toBe(true); await settle();
    expect(h.events.at(-1)).toMatchObject({ type: 'PLAYBACK_STARTED', job: last });
    h.adapter.dispose();
  });

  it('new gesture stops old audio before new capture/prime, and old cancellation or sample callback cannot affect the new pet', async () => {
    const h = await startPlaying(), oldContext = h.contexts.playback[0]!, late = oldContext.source.onended!;
    const oldTimer = [...h.timers.intervals.values()][0]!.callback;
    const next = job(2, 'pet-b');
    expect(h.adapter.primePlaybackFromGesture(next, gesture)).toBe(true);
    expect(oldContext.source.stop).toHaveBeenCalledOnce(); expect(oldContext.close).toHaveBeenCalledOnce();
    expect(h.adapter.preparePlayback(playable(next))).toBe(true); await settle();
    h.adapter.cancelJob(job()); late(); oldTimer();
    const newContext = h.contexts.playback[1]!;
    expect(newContext.source.stop).not.toHaveBeenCalled(); expect(newContext.close).not.toHaveBeenCalled();
    expect(h.events.filter(event => event.type === 'PLAYBACK_ENDED')).toHaveLength(0);
    newContext.source.end(); expect(h.events.at(-1)).toMatchObject({ type: 'PLAYBACK_ENDED', job: next });
  });

  it('bounds prime lifetime and playback completion timeout and fails a suspended playing context', async () => {
    const unused = harness(); unused.adapter.primePlaybackFromGesture(job(), gesture); unused.timers.fireAfter(120_000);
    expect(unused.contexts.playback[0]?.close).toHaveBeenCalledOnce(); expect(unused.adapter.preparePlayback(playable())).toBe(false);
    const h = await startPlaying(); h.timers.fireAfter(3000);
    expect(h.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'PLAYING', code: 'timeout' });
    const suspended = await startPlaying(); suspended.contexts.playback[0]!.suspend();
    expect(suspended.events.at(-1)).toMatchObject({ type: 'FAILED', phase: 'PLAYING', code: 'playback_failed' });
    expect(suspended.timers.intervals.size).toBe(0);
  });
});
