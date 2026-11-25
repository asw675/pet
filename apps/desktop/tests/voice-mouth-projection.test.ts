import { inflateSync } from 'node:zlib';
import { describe, expect, it, beforeAll } from 'vitest';
import { loadBuiltinPack } from '../src/renderer/asset-packs/builtin-registry';
import type { ResolvedPack } from '../src/renderer/asset-packs/resolve-pack';
import { authoredMouthPatch } from '../src/renderer/rendering/authored-mouth';
import { VoiceMouthProjection, MOUTH_STALE_MS } from '../src/renderer/rendering/voice-mouth-projection';
import type { VoiceOwnedJob } from '../src/shared/voice-ipc';

const job = (generation = 2, petId = 'pet-a'): VoiceOwnedJob => ({ petId, conversationId: 'conv', turnId: `turn-${generation}`, requestId: `req-${generation}`, generation });
const begin = (owned = job(), durationMs = 1000) => ({ kind: 'begin' as const, job: owned, durationMs });
const clear = (owned = job()) => ({ kind: 'clear' as const, job: owned });
const sample = (owned = job(), atMs = 32, mouthOpen = .5) => ({ kind: 'sample' as const, job: owned,
  sample: { petId: owned.petId, turnId: owned.turnId, generation: owned.generation, atMs, mouthOpen, speaking: mouthOpen > 0 } });

describe('Pet visual-only authoritative audio-clock projection', () => {
  it('requires an exact begin and uses actual relative audio time, not receipt or frame timing', () => {
    const p = new VoiceMouthProjection('pet-a');
    expect(p.accept(sample(), 100, true)).toEqual({ changed: false });
    expect(p.accept(begin(), 300, true)).toEqual({ changed: true, sample: null });
    expect(p.accept(sample(job(), 117, .8), 400, true)).toEqual({ changed: true, sample: { generation: 2, atMs: 117, open: .8 } });
    expect(p.accept(sample(job(), 140, 0), 430, true)).toEqual({ changed: true, sample: { generation: 2, atMs: 140, open: 0 } });
  });
  it('rejects wrong pet, request, conversation, turn, generation or malformed visual fields', () => {
    const p = new VoiceMouthProjection('pet-a'); p.accept(begin(), 0, true);
    for (const owned of [job(2, 'pet-b'), { ...job(), conversationId: 'wrong' }, { ...job(), requestId: 'wrong' }, { ...job(), turnId: 'wrong' }, job(1), job(3)]) {
      expect(p.accept(sample(owned), 30, true)).toEqual({ changed: false });
    }
    expect(p.accept({ ...sample(), sample: { ...sample().sample, speaking: false } }, 40, true)).toEqual({ changed: false });
    expect(p.accept({ ...sample(), rawAudio: 'never' }, 40, true)).toEqual({ changed: false });
    expect(p.accept(sample(job(), 1001), 45, true)).toEqual({ changed: false });
    expect(p.accept(sample(job(), 50), 50, true)).toMatchObject({ changed: true, sample: { open: .5 } });
  });
  it('enforces monotonically increasing audio position and refuses old/duplicate begin', () => {
    const p = new VoiceMouthProjection('pet-a'); p.accept(begin(), 0, true);
    p.accept(sample(job(), 40), 40, true);
    expect(p.accept(sample(job(), 39), 60, true)).toEqual({ changed: false });
    expect(p.accept(sample(job(), 40), 62, true)).toEqual({ changed: false });
    expect(p.accept(begin(), 65, true)).toEqual({ changed: false });
    expect(p.accept(begin(job(1)), 70, true)).toEqual({ changed: false });
    expect(p.accept(sample(job(), 70, .9), 80, true)).toMatchObject({ changed: true, sample: { atMs: 70, open: .9 } });
  });
  it('closes and retires a stale open mouth using receipt watchdog, with no old sample resurrection', () => {
    const p = new VoiceMouthProjection('pet-a'); p.accept(begin(), 0, true); p.accept(sample(job(), 25), 100, true);
    expect(p.expire(100 + MOUTH_STALE_MS - 1)).toEqual({ changed: false });
    expect(p.expire(100 + MOUTH_STALE_MS)).toEqual({ changed: true, sample: null }); expect(p.active).toBe(false);
    expect(p.accept(sample(job(), 900), 300, true)).toEqual({ changed: false });
    expect(p.accept(begin(), 320, true)).toEqual({ changed: false });
    expect(p.accept(begin(job(3)), 350, true)).toMatchObject({ changed: true });
  });
  it('does not reopen after quiet/hidden begin, pause or retirement; fresh generation required', () => {
    const p = new VoiceMouthProjection('pet-a');
    expect(p.accept(begin(), 100, false)).toEqual({ changed: true, sample: null }); expect(p.active).toBe(false);
    expect(p.accept(begin(), 110, true)).toEqual({ changed: false });
    p.accept(begin(job(3)), 130, true); p.accept(sample(job(3)), 140, true);
    expect(p.accept(sample(job(3), 60), 150, false)).toEqual({ changed: true, sample: null });
    expect(p.accept(sample(job(3), 100), 160, true)).toEqual({ changed: false });
    p.accept(begin(job(4)), 170, true); expect(p.retire()).toEqual({ changed: true, sample: null });
    expect(p.accept(begin(job(4)), 180, true)).toEqual({ changed: false });
  });
  it('a stale clear cannot close newer speech; exact clear/newer cancellation retires generation', () => {
    const p = new VoiceMouthProjection('pet-a'); p.accept(begin(), 0, true); p.accept(sample(), 30, true);
    p.accept(begin(job(3)), 40, true); p.accept(sample(job(3)), 50, true);
    expect(p.accept(clear(), 55, true)).toEqual({ changed: false });
    expect(p.accept(clear({ ...job(3), requestId: 'wrong' }), 55, true)).toEqual({ changed: false });
    expect(p.accept(clear(job(3)), 55, true)).toEqual({ changed: true, sample: null });
    expect(p.accept(clear(job(5)), 60, true)).toEqual({ changed: true, sample: null });
    expect(p.accept(begin(job(5)), 65, true)).toEqual({ changed: false });
    expect(p.accept(begin(job(6)), 70, true)).toEqual({ changed: true, sample: null });
    p.dispose(); expect(p.accept(sample(job(6)), 80, true)).toEqual({ changed: false });
  });
});

let packs: ResolvedPack[];
beforeAll(async () => { packs = await Promise.all(['star-singer', 'fluffy-ranger', 'nova'].map(id => loadBuiltinPack(id))); });

// Independent verification of the generated RGBA8/filter-zero engineering
// PNG's actual bytes: this is not a canvas/device/window integration test.
function pixels(pack: ResolvedPack, rect: readonly [number, number, number, number]) {
  const bytes = Buffer.from(pack.readAsset('assets/atlas.png')!), compressed: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at), tag = bytes.subarray(at + 4, at + 8).toString('ascii');
    if (tag === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const decoded = inflateSync(Buffer.concat(compressed)); const stride = 768 * 4 + 1;
  const [x, y, w, h] = rect, result: Buffer[] = [];
  for (let row = y; row < y + h; row++) {
    expect(decoded[row * stride]).toBe(0);
    result.push(decoded.subarray(row * stride + 1 + x * 4, row * stride + 1 + (x + w) * 4));
  }
  return Buffer.concat(result);
}
describe('Authored mouth crop from pinned original heroine assets', () => {
  it('maps each actual RMS level to different real same-character mouth pixels and a true closed idle patch', () => {
    for (const pack of packs) {
      const variant = pack.variants.find(v => v.renderer === 'sprite')!;
      const levels = [0, .15, .35, .65, .9].map(open => authoredMouthPatch(pack, variant, 'idle', 0, open)!);
      expect(levels.map(p => p.level)).toEqual([0, 1, 2, 3, 4]);
      expect(levels[0]?.source).toEqual(levels[0]?.destination);
      const samples = levels.map(patch => pixels(pack, patch.source));
      expect(new Set(samples.map(value => value.toString('hex'))).size).toBe(5);
      for (const data of samples) for (let alpha = 3; alpha < data.length; alpha += 4) expect(data[alpha]).toBe(255);
      expect(levels[4]?.destination).toEqual([59, 66, 10, 11]);
    }
  });
  it('preserves authored per-frame bob/stride and refuses unknown pack/variant/version', () => {
    for (const pack of packs) {
      const sprite = pack.variants.find(v => v.renderer === 'sprite')!;
      expect(authoredMouthPatch(pack, sprite, 'walk', 0, .5)?.destination).toEqual([57, 66, 10, 11]);
      expect(authoredMouthPatch(pack, sprite, 'happy', 2, .5)?.destination).toEqual([59, 61, 10, 11]);
      expect(authoredMouthPatch(pack, sprite, 'tap.head', 2, .5)?.destination).toEqual([59, 69, 10, 11]);
      expect(authoredMouthPatch(pack, sprite, 'unknown', 0, .5)).toBeNull();
      expect(authoredMouthPatch(pack, sprite, 'idle', 10, .5)).toBeNull();
      expect(authoredMouthPatch(pack, pack.variants.find(v => v.renderer === 'static')!, 'idle', 0, .5)).toBeNull();
      expect(authoredMouthPatch({ ...pack, manifest: { ...pack.manifest, packVersion: '9.9.9' } }, sprite, 'idle', 0, .5)).toBeNull();
    }
  });
});
