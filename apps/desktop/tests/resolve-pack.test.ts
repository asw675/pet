import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { resolvePack } from '../src/shared/resolve-character-pack';
import type { PackSource, ResolvePackOptions } from '../src/shared/resolve-character-pack';

const thumbnailPath = 'assets/thumbnail.png';
const atlasPath = 'assets/atlas.json';
const texturePath = 'assets/atlas.png';
const stillPath = 'assets/idle.png';
const options: ResolvePackOptions = {
  characterId: 'star-singer', packVersion: '1.0.0', appVersion: '0.1.0',
};

function checksum(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, payload: Uint8Array): Buffer {
  const contents = Buffer.concat([Buffer.from(name, 'ascii'), payload]);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  crc.writeUInt32BE(checksum(contents));
  return Buffer.concat([length, contents, crc]);
}

/** Minimal valid PNG made independently of production inspector using zlib. */
function png(w = 4, h = 4, colorType = 6, fakeCompressed = false): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = colorType;
  const raw = fakeCompressed ? Buffer.from([5]) : deflateSync(Buffer.alloc((w * 4 + 1) * h));
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', raw), chunk('IEND', new Uint8Array()),
  ]));
}

function describeFiles(data: ReadonlyMap<string, Uint8Array>) {
  return [...data].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }));
}

function atlas() {
  return {
    schemaVersion: 1,
    image: texturePath,
    size: { w: 4, h: 4 },
    clips: { idle: { frames: [{ rect: [0, 0, 2, 2], durationMs: 100 }, { rect: [2, 0, 2, 2], durationMs: 120 }] } },
  };
}

function fixture() {
  const data = new Map<string, Uint8Array>([
    [thumbnailPath, png()], [atlasPath, new TextEncoder().encode(JSON.stringify(atlas()))],
    [texturePath, png()], [stillPath, png()],
  ]);
  const manifest = {
    schemaVersion: 1, characterId: options.characterId, packVersion: options.packVersion,
    minAppVersion: '0.0.0', displayName: { 'zh-CN': '星咏' }, thumbnail: thumbnailPath,
    variants: [
      { id: 'sprite', renderer: 'sprite', entry: atlasPath },
      { id: 'still', renderer: 'static', entry: stillPath },
    ],
    anchor: { x: 0.5, y: 1 }, logicalSize: { w: 128, h: 128 },
    hitRegions: [{ id: 'head', rect: [0.2, 0.1, 0.6, 0.4] }],
    actions: { idle: { sprite: 'idle', still: 'idle' } }, cgIds: [],
    license: { owner: 'Project', reference: 'self-created-test' },
    files: describeFiles(data),
  };
  const source: PackSource = {
    paths: vi.fn(() => [...data.keys()]),
    read: vi.fn(async path => {
      const bytes = data.get(path);
      if (!bytes) throw new Error('missing');
      return bytes;
    }),
  };
  return {
    data, manifest, source,
    setFile(path: string, bytes: Uint8Array) { data.set(path, bytes); manifest.files = describeFiles(data); },
    setAtlas(value: unknown) { this.setFile(atlasPath, new TextEncoder().encode(JSON.stringify(value))); },
  };
}

const modelPath = 'assets/live2d/test.model3.json';
const mocPath = 'assets/live2d/test.moc3';
const modelTexture = 'assets/live2d/textures/base.png';
const modelFile = (extra: Record<string, unknown> = {}) => ({
  Version: 3, FileReferences: { Moc: 'test.moc3', Textures: ['textures/base.png'], ...extra },
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }],
});
const encode = (data: unknown) => new TextEncoder().encode(JSON.stringify(data));

function cubismFixture(model: ReturnType<typeof modelFile> = modelFile()) {
  const f = fixture();
  const moc = new Uint8Array(64); // Only the outer signature is validated without licensed Core.
  moc.set(new Uint8Array([0x4d, 0x4f, 0x43, 0x33]));
  f.setFile(modelPath, encode(model));
  f.setFile(mocPath, moc);
  f.setFile(modelTexture, png());
  f.manifest.variants.unshift({ renderer: 'cubism', id: 'live2d', entry: modelPath });
  Object.assign(f.manifest.actions.idle, { live2d: 'idle' });
  return f;
}

describe('Cubism pack data', () => {
  it('projects verified model references and keeps an independent static fallback', async () => {
    const f = cubismFixture(modelFile({ Motions: { idle: [{ File: 'idle.motion3.json' }] } }));
    f.setFile('assets/live2d/idle.motion3.json', encode({
      Version: 3, Meta: { Duration: 1, Fps: 30, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 },
      Curves: [{ Target: 'Parameter', Id: 'ParamEyeLOpen', Segments: [0, 1, 0, 1, 0] }],
    }));
    const result = await resolvePack(f.manifest, f.source, options);
    expect(result.variants[0]).toMatchObject({ renderer: 'cubism', entry: modelPath,
      textures: [{ path: modelTexture, size: { w: 4, h: 4 } }], model: {
        moc: mocPath, eyeBlink: ['ParamEyeLOpen', 'ParamEyeROpen'],
        motions: { idle: [{ path: 'assets/live2d/idle.motion3.json' }] },
      } });
    expect(result.variants.some(item => item.renderer === 'static')).toBe(true);
  });

  it.each([
    { Moc: '../test.moc3' }, { Moc: 'https://other.test/model.moc3' },
    { Textures: ['textures/base.png', 'textures/base.png'] }, { Script: 'start.js' },
    { Physics: 'missing.physics3.json' }, { Motions: { idle: [{ File: 'idle.motion3.json', Sound: 'audio.ogg' }] } },
  ])('rejects unauthorized or unresolved model references %o', async extra => {
    const f = cubismFixture(modelFile(extra));
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'INVALID_CUBISM' });
  });

  it('rejects a forged MOC3 signature and giant physics allocation counters', async () => {
    const invalidMoc = cubismFixture();
    invalidMoc.setFile(mocPath, new Uint8Array(64));
    await expect(resolvePack(invalidMoc.manifest, invalidMoc.source, options)).rejects.toMatchObject({ code: 'INVALID_CUBISM' });

    const invalidPhysics = cubismFixture(modelFile({ Physics: 'bad.physics3.json' }));
    invalidPhysics.setFile('assets/live2d/bad.physics3.json', encode({
      Version: 3, Meta: { PhysicsSettingCount: 1, TotalInputCount: 8_000_000, TotalOutputCount: 0, VertexCount: 0 },
      PhysicsSettings: [{ Input: [], Output: [], Vertices: [] }],
    }));
    await expect(resolvePack(invalidPhysics.manifest, invalidPhysics.source, options)).rejects.toMatchObject({ code: 'INVALID_CUBISM' });
  });

  it('requires a verified fallback and refuses auxiliary files absent from the model', async () => {
    const f = cubismFixture();
    f.setFile('assets/live2d/extra.exp3.json', encode({ Parameters: [] }));
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    f.manifest.variants = f.manifest.variants.filter(v => v.renderer !== 'static');
    Reflect.deleteProperty(f.manifest.actions.idle, 'still');
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'NO_STATIC_FALLBACK' });
  });
});

describe('local pack preparation', () => {
  it('validates bytes, exact source paths, atlas references and static fallback; returns detached verified copies', async () => {
    const f = fixture();
    const expected = f.data.get(stillPath)?.slice();
    const result = await resolvePack(f.manifest, f.source, options);
    expect(result.manifest.characterId).toBe(options.characterId);
    expect(result.variants).toEqual([
      { id: 'sprite', renderer: 'sprite', entry: atlasPath, imagePath: texturePath, imageSize: { w: 4, h: 4 }, atlas: atlas() },
      { id: 'still', renderer: 'static', entry: stillPath, imagePath: stillPath, imageSize: { w: 4, h: 4 } },
    ]);
    expect(f.source.read).toHaveBeenCalledTimes(f.manifest.files.length);
    f.data.get(stillPath)?.fill(0); // source and returned byte views are not authoritative
    const exposed = result.readAsset(stillPath);
    expect(exposed).toEqual(expected);
    exposed?.fill(0);
    expect(result.readAsset(stillPath)).toEqual(expected);
    expect(result.readAsset('assets/not-listed.png')).toBeUndefined();
    expect(f.source.read).toHaveBeenCalledTimes(f.manifest.files.length);
    expect(Object.isFrozen(result.variants)).toBe(true);
    expect(Object.isFrozen(result.manifest.actions.idle)).toBe(true);
    expect(Object.isFrozen(result.variants[0]?.renderer === 'sprite' ? result.variants[0].atlas.clips.idle?.frames : undefined)).toBe(true);
  });

  it('rejects malformed manifest without attempting source I/O', async () => {
    const f = fixture();
    f.manifest.thumbnail = 'assets/../secret.png';
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    expect(f.source.paths).not.toHaveBeenCalled();
    expect(f.source.read).not.toHaveBeenCalled();
  });

  it.each([{ characterId: 'fluffy-ranger' }, { packVersion: '2.0.0' }])('requires exact catalog identity and version: %o', async change => {
    const f = fixture();
    await expect(resolvePack(f.manifest, f.source, { ...options, ...change })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(f.source.read).not.toHaveBeenCalled();
  });

  it.each(['0.0.99', '0.1', '01.1.0', '0.1.0-alpha', '65536.0.0'])('rejects incompatible/malformed app version %s', async appVersion => {
    const f = fixture();
    f.manifest.minAppVersion = '0.1.0';
    await expect(resolvePack(f.manifest, f.source, { ...options, appVersion })).rejects.toMatchObject({ code: 'INCOMPATIBLE_APP' });
    expect(f.source.read).not.toHaveBeenCalled();
  });

  it('compares numeric version components rather than lexical strings', async () => {
    const f = fixture();
    f.manifest.minAppVersion = '0.9.0';
    await expect(resolvePack(f.manifest, f.source, { ...options, appVersion: '0.10.0' })).resolves.toMatchObject({ manifest: { minAppVersion: '0.9.0' } });
  });

  it('rejects unsupported image formats even if the baseline manifest schema permits them', async () => {
    const f = fixture();
    f.manifest.thumbnail = 'assets/cover.webp';
    f.data.delete(thumbnailPath);
    f.setFile(f.manifest.thumbnail, new Uint8Array([1, 2, 3]));
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(f.source.read).not.toHaveBeenCalled();
  });

  it('requires at least one static fallback in this built-in pack slice', async () => {
    const f = fixture();
    f.manifest.variants.splice(1);
    delete (f.manifest.actions.idle as Record<string, string>).still;
    f.data.delete(stillPath);
    f.manifest.files = describeFiles(f.data);
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'NO_STATIC_FALLBACK' });
  });

  it.each(['extra', 'missing', 'duplicate'])('rejects %s paths before reading', async mode => {
    const f = fixture();
    const paths = [...f.data.keys()];
    if (mode === 'extra') paths.push('assets/unlisted.png');
    else if (mode === 'missing') paths.pop();
    else paths[0] = atlasPath;
    const source = { ...f.source, paths: () => paths };
    await expect(resolvePack(f.manifest, source, options)).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    expect(source.read).not.toHaveBeenCalled();
  });

  it('rejects declared but unreferenced local bytes in this supported-only subset', async () => {
    const f = fixture();
    f.setFile('assets/extra.png', png());
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
  });

  it('rejects wrong byte size before hashing', async () => {
    const f = fixture();
    f.data.set(thumbnailPath, new Uint8Array([1]));
    const digest = vi.fn(async () => 'unused');
    await expect(resolvePack(f.manifest, f.source, { ...options, digest })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(digest).not.toHaveBeenCalled();
  });

  it('rejects same-size bytes with an incorrect hash', async () => {
    const f = fixture();
    const bytes = f.data.get(thumbnailPath);
    if (!bytes) throw new Error('fixture');
    bytes[0] = 0;
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it.each([
    ['oversized', () => png(2049, 4, 6, true)],
    ['RGB rather than RGBA', () => png(4, 4, 2)],
    ['missing IEND', () => png().slice(0, -12)],
    ['bad CRC', () => { const bytes = png(); bytes[29] = (bytes[29] ?? 0) ^ 1; return bytes; }],
    ['trailing bytes', () => new Uint8Array([...png(), 0])],
  ] satisfies [string, () => Uint8Array][])('rejects hash-consistent structural PNG issues: %s', async (_label, makeBytes) => {
    const f = fixture();
    f.setFile(thumbnailPath, makeBytes());
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'INVALID_PNG' });
  });

  it('checks total decoded texture budget, not merely the compressed sums', async () => {
    const f = fixture();
    // No decode is attempted in this test: structural metadata alone rejects the budget.
    const huge = png(2048, 2048, 6, true);
    for (const path of [thumbnailPath, texturePath, stillPath, 'assets/extra1.png', 'assets/extra2.png']) f.setFile(path, huge);
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'TEXTURE_BUDGET_EXCEEDED' });
  });

  it.each([
    ['missing declared image', () => ({ ...atlas(), image: 'assets/missing.png' })],
    ['atlas/header dimensions disagree', () => ({ ...atlas(), size: { w: 6, h: 4 } })],
    ['out-of-bounds frame', () => ({ ...atlas(), clips: { idle: { frames: [{ rect: [3, 0, 2, 2], durationMs: 100 }] } } })],
    ['missing idle clip', () => ({ ...atlas(), clips: { walk: atlas().clips.idle } })],
    ['invalid JSON UTF-8', () => undefined],
  ] satisfies [string, () => unknown][])('rejects invalid atlas %s after checking file integrity', async (_label, makeAtlas) => {
    const f = fixture();
    const value = makeAtlas();
    if (value === undefined) f.setFile(atlasPath, new Uint8Array([0xc0, 0x80]));
    else f.setAtlas(value);
    await expect(resolvePack(f.manifest, f.source, options)).rejects.toMatchObject({ code: 'INVALID_ATLAS' });
  });

  it('does not expose raw source or digest exceptions', async () => {
    const f = fixture();
    const read = async (): Promise<Uint8Array> => { throw new Error('/Users/private/credential'); };
    await expect(resolvePack(f.manifest, { ...f.source, read }, options)).rejects.toMatchObject({ code: 'READ_FAILED', message: 'READ_FAILED' });
    const digest = async (): Promise<string> => { throw new Error('/Users/private/credential'); };
    await expect(resolvePack(f.manifest, f.source, { ...options, digest })).rejects.toMatchObject({ code: 'DIGEST_FAILED', message: 'DIGEST_FAILED' });
  });

  it('cancels prior to touching the source', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error('private reason'));
    await expect(resolvePack(f.manifest, f.source, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', message: 'ABORTED' });
    expect(f.source.paths).not.toHaveBeenCalled();
  });

  it('aborts an in-flight source which never settles, also notifying the source', async () => {
    const f = fixture();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const read = vi.fn(async (_path, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<Uint8Array>(() => undefined);
    });
    const promise = resolvePack(f.manifest, { ...f.source, read }, { ...options, signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('times out even if the integrity digest never settles', async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      const digest = vi.fn(async () => new Promise<string>(() => undefined));
      const promise = resolvePack(f.manifest, f.source, { ...options, digest, timeoutMs: 20 });
      const rejection = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(20);
      await rejection;
      expect(digest).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('leaves the previous resolved pack valid after an independent replacement fails', async () => {
    const first = fixture();
    const current = await resolvePack(first.manifest, first.source, options);
    const oldBytes = current.readAsset(texturePath);
    const next = fixture();
    next.manifest.packVersion = '2.0.0';
    next.data.set(texturePath, new Uint8Array());
    await expect(resolvePack(next.manifest, next.source, { ...options, packVersion: '2.0.0' })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(current.manifest.packVersion).toBe('1.0.0');
    expect(current.readAsset(texturePath)).toEqual(oldBytes);
  });
});
