import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { characterPackManifestSchema } from '@pet-desktop/contracts';
import { builtinPackIds, loadBuiltinPack } from '../src/renderer/asset-packs/builtin-registry';
import { resolvePack } from '../src/renderer/asset-packs/resolve-pack';

const root = fileURLToPath(new URL('../src/renderer/asset-packs/builtin/', import.meta.url));
const packIds = ['star-singer', 'fluffy-ranger'];

function collectFiles(directory: string, packRoot: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Built-in pack cannot contain symbolic links');
    if (info.isDirectory()) return collectFiles(path, packRoot);
    if (!info.isFile()) throw new Error('Built-in pack must contain regular data files');
    return [relative(packRoot, path).split(sep).join('/')];
  }).sort();
}

describe('versioned built-in character fixtures', () => {
  it.each(packIds)('validates actual on-disk bytes and the entire %s directory', async (characterId) => {
    const directory = join(root, characterId);
    const manifest = characterPackManifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
    const expected = ['manifest.json', ...manifest.files.map((file) => file.path)].sort();
    expect(collectFiles(directory, directory)).toEqual(expected);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(directory, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    const resolved = await resolvePack(manifest, {
      paths: () => expected.filter((path) => path !== 'manifest.json'),
      read: async (path) => new Uint8Array(readFileSync(join(directory, path))),
    }, { characterId, packVersion: '1.0.1', appVersion: '0.0.0' });
    expect(resolved.manifest.characterId).toBe(characterId);
    expect(resolved.variants.some((variant) => variant.renderer === 'sprite')).toBe(true);
    expect(resolved.variants.some((variant) => variant.renderer === 'static')).toBe(true);
  });

  it('exposes only the known versioned built-ins', async () => {
    expect([...builtinPackIds()].sort()).toEqual([...packIds].sort());
    await expect(loadBuiltinPack('https://example.invalid/pack')).rejects.toThrow();
    await expect(loadBuiltinPack('../../outside')).rejects.toThrow();
  });

  it.each(packIds)('resolves %s through Vite data imports without any network or filesystem bridge', async (characterId) => {
    const resolved = await loadBuiltinPack(characterId);
    expect(resolved.manifest.characterId).toBe(characterId);
    const thumbnail = resolved.readAsset(resolved.manifest.thumbnail);
    expect(thumbnail?.length).toBeGreaterThan(8);
    expect([...thumbnail!.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // Returned data cannot mutate the prepared asset storage.
    thumbnail![0] = 0;
    expect(resolved.readAsset(resolved.manifest.thumbnail)?.[0]).toBe(137);
  });
});
