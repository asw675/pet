import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEMO_ROUTE } from '@pet-desktop/domain';
import {
  BUILTIN_CG_CATALOG, findBuiltinCg, serializeCgAssetDescriptor, type CgCatalogEntry,
} from '@pet-desktop/domain/cg-catalog';

const CG_ROOT = fileURLToPath(new URL('../src/renderer/cg-assets/builtin/', import.meta.url));
const characters = ['star-singer', 'fluffy-ranger'] as const;
const GOLDEN: Record<(typeof characters)[number], string> = {
  'star-singer': 'f8fa4c3384d52b707fa8c3f4f63b55e781d541ec207eb521b32a8b79ce713719',
  'fluffy-ranger': 'e60e00265fae34a3e3b2685962e802cfc73f0bf4520e31ab0b197a8d010049fd',
};
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function entryFor(characterId: string): CgCatalogEntry {
  const entry = findBuiltinCg(characterId, 'morning-dew', 'default', '1.0.0');
  if (!entry) throw new Error('Expected immutable 1.0.0 CG entry');
  return entry;
}

function pathFor(entry: CgCatalogEntry, name: 'image.png' | 'thumbnail.png'): string {
  return join(CG_ROOT, entry.characterId, entry.cgId, entry.variant, entry.assetVersion, name);
}

// Verify PNG data independently from the composition generator. In addition
// to the pinned byte hashes this checks that every visible RGBA pixel really
// exists after decompression and the thumbnail is a small view of that image.
function decodePng(bytes: Buffer): { w: number; h: number; pixels: Uint8Array } {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(8)).toBe(13);
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  expect([...bytes.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
  const pieces: Buffer[] = [];
  const types: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    expect(offset + length + 12).toBeLessThanOrEqual(bytes.length);
    if (type === 'IDAT') pieces.push(bytes.subarray(offset + 8, offset + 8 + length));
    types.push(type);
    offset += length + 12;
  }
  expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  expect(offset).toBe(bytes.length);
  const row = w * 4;
  const length = (row + 1) * h;
  const raw = inflateSync(Buffer.concat(pieces), { maxOutputLength: length });
  expect(raw.length).toBe(length);
  const pixels = new Uint8Array(w * h * 4);
  let allRowsUnfiltered = true;
  for (let y = 0; y < h; y += 1) {
    if (raw[y * (row + 1)] !== 0) allRowsUnfiltered = false;
    pixels.set(raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)), y * row);
  }
  expect(allRowsUnfiltered).toBe(true);
  // Scene artwork is opaque; no empty transparent or blank placeholder.
  let transparentPixels = 0;
  const colors = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255) transparentPixels += 1;
    // Bound the diversity check without retaining an unbounded color set.
    if (colors.size <= 1024) colors.add(pixels[i]! * 65536 + pixels[i + 1]! * 256 + pixels[i + 2]!);
  }
  expect(colors.size).toBeGreaterThan(1024);
  expect(transparentPixels).toBe(0);
  return { w, h, pixels };
}

describe('004E versioned built-in CG catalog and real artwork bytes', () => {
  it('has exactly two separate immutable entries matching the existing event route', () => {
    const event = DEMO_ROUTE.nodes.find((node) => node.kind === 'EVENT');
    expect(event?.kind).toBe('EVENT');
    if (event?.kind !== 'EVENT') throw new Error('Missing demo event');
    expect(BUILTIN_CG_CATALOG).toHaveLength(2);
    expect(Object.isFrozen(BUILTIN_CG_CATALOG)).toBe(true);
    expect(BUILTIN_CG_CATALOG.map((entry) => entry.characterId).sort()).toEqual([...characters].sort());
    for (const entry of BUILTIN_CG_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.license)).toBe(true);
      expect(Object.isFrozen(entry.image)).toBe(true);
      expect(Object.isFrozen(entry.thumbnail)).toBe(true);
      expect(entry.routeId).toBe(DEMO_ROUTE.routeId);
      expect(entry.cgId).toBe(event.cgId);
      expect(entry.eventDefId).toBe(event.eventDefId);
      expect(entry.variant).toBe('default');
      expect(entry.assetVersion).toBe('1.0.0');
      expect(entry.rarity).toBe('COMMON');
      expect(entry.license).toEqual({ owner: 'Pet Desktop', reference: 'original-poc-fixture' });
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.caption.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
      expect(Object.keys(entry.image).sort()).toEqual(['bytes', 'sha256']);
      expect(Object.keys(entry.thumbnail).sort()).toEqual(['bytes', 'sha256']);
    }
  });

  it('exactly resolves an older version pin instead of redirecting missing versions to latest', () => {
    for (const id of characters) {
      expect(findBuiltinCg(id, 'morning-dew')).toBe(entryFor(id));
      expect(findBuiltinCg(id, 'morning-dew', 'default', '1.0.0')).toBe(entryFor(id));
      expect(findBuiltinCg(id, 'morning-dew', 'default', '0.9.0')).toBeUndefined();
      expect(findBuiltinCg(id, 'morning-dew', 'default', '1.0.1')).toBeUndefined();
      expect(findBuiltinCg(id, 'morning-dew', 'unknown')).toBeUndefined();
      expect(findBuiltinCg(id, 'unknown-cg')).toBeUndefined();
    }
    expect(findBuiltinCg('unknown', 'morning-dew')).toBeUndefined();
    expect(findBuiltinCg('../../', 'morning-dew')).toBeUndefined();
  });

  it.each(characters)('%s canonical descriptor includes both file identities and has a verified golden hash', (id) => {
    const entry = entryFor(id);
    const descriptor = serializeCgAssetDescriptor(entry);
    expect(Object.keys(JSON.parse(descriptor))).toEqual([
      'characterId', 'cgId', 'variant', 'routeId', 'eventDefId', 'assetVersion',
      'rarity', 'title', 'hint', 'caption', 'license', 'image', 'thumbnail',
    ]);
    // Independent ordered JSON representation locks the algorithm, not just
    // equivalence to whatever the shared serialization helper currently emits.
    const canonical = JSON.stringify({
      characterId: entry.characterId,
      cgId: entry.cgId,
      variant: entry.variant,
      routeId: entry.routeId,
      eventDefId: entry.eventDefId,
      assetVersion: entry.assetVersion,
      rarity: entry.rarity,
      title: entry.title,
      hint: entry.hint,
      caption: entry.caption,
      license: { owner: entry.license.owner, reference: entry.license.reference },
      image: { bytes: entry.image.bytes, sha256: entry.image.sha256 },
      thumbnail: { bytes: entry.thumbnail.bytes, sha256: entry.thumbnail.sha256 },
    });
    expect(descriptor).toBe(canonical);
    expect(hash(Buffer.from(descriptor, 'utf8'))).toBe(entry.assetHash);
    expect(entry.assetHash).toBe(GOLDEN[id]);
    expect(hash(serializeCgAssetDescriptor({ ...entry, thumbnail: { ...entry.thumbnail, bytes: entry.thumbnail.bytes + 1 } }))).not.toBe(entry.assetHash);
    expect(hash(serializeCgAssetDescriptor({ ...entry, caption: entry.caption + '。' }))).not.toBe(entry.assetHash);
    expect(hash(serializeCgAssetDescriptor({ ...entry, license: { ...entry.license, reference: 'different' } }))).not.toBe(entry.assetHash);
  });

  it.each(characters)('%s contains exactly the pinned image and thumbnail; real bytes match SHA-256', (id) => {
    const entry = entryFor(id);
    const dir = join(CG_ROOT, id, entry.cgId, entry.variant, entry.assetVersion);
    expect(readdirSync(dir).sort()).toEqual(['image.png', 'thumbnail.png']);
    for (const [name, metadata] of [['image.png', entry.image], ['thumbnail.png', entry.thumbnail]] as const) {
      const file = pathFor(entry, name);
      const stat = lstatSync(file);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      const bytes = readFileSync(file);
      expect(bytes.length).toBe(metadata.bytes);
      expect(hash(bytes)).toBe(metadata.sha256);
    }
  });

  it.each(characters)('%s PNG decodes to a real 768×432 composition and exact 256×144 thumbnail', (id) => {
    const entry = entryFor(id);
    const source = decodePng(readFileSync(pathFor(entry, 'image.png')));
    const preview = decodePng(readFileSync(pathFor(entry, 'thumbnail.png')));
    expect([source.w, source.h]).toEqual([768, 432]);
    expect([preview.w, preview.h]).toEqual([256, 144]);
    let different = 0;
    for (let y = 0; y < preview.h; y += 1) for (let x = 0; x < preview.w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < 3; dy += 1) for (let dx = 0; dx < 3; dx += 1) {
          sum += source.pixels[((y * 3 + dy) * source.w + x * 3 + dx) * 4 + c]!;
        }
        if (preview.pixels[(y * preview.w + x) * 4 + c] !== Math.round(sum / 9)) different += 1;
      }
    }
    expect(different).toBe(0);
  });

  it('ships distinct character scene bytes instead of two metadata aliases for one generic CG', () => {
    const a = entryFor('star-singer');
    const b = entryFor('fluffy-ranger');
    expect(a.image.sha256).not.toBe(b.image.sha256);
    expect(a.thumbnail.sha256).not.toBe(b.thumbnail.sha256);
    expect(a.assetHash).not.toBe(b.assetHash);
    expect(a.caption).not.toBe(b.caption);
  });
});
