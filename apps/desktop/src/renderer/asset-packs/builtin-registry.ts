/// <reference types="vite/client" />

import { version as appVersion } from '../../../package.json';
import { resolvePack, type PackSource, type ResolvedPack } from './resolve-pack';

// Only the application's built-in data is registered here. No arbitrary URL,
// absolute paths, directory browsing, dynamically supplied JS or fetch(file:).
// Vite turns the small PNG fixtures into data URLs and JSON into raw strings;
// larger downloadable packs require the later trusted asset service.
const manifests = import.meta.glob<unknown>('./builtin/*/manifest.json', { import: 'default' });
const atlasFiles = import.meta.glob<string>('./builtin/*/assets/**/*.json', { query: '?raw', import: 'default' });
const imageFiles = import.meta.glob<string>('./builtin/*/assets/**/*.png', { query: '?inline', import: 'default' });

const BUILTIN_VERSIONS = new Map([
  ['star-singer', '1.0.1'],
  ['fluffy-ranger', '1.0.1'],
]);

function decodePngDataUrl(url: string): Uint8Array<ArrayBuffer> {
  const prefix = 'data:image/png;base64,';
  if (!url.startsWith(prefix)) throw new Error('Invalid built-in image encoding');
  const binary = atob(url.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function builtinPackIds(): readonly string[] { return [...BUILTIN_VERSIONS.keys()]; }

export async function loadBuiltinPack(characterId: string, signal?: AbortSignal): Promise<ResolvedPack> {
  const packVersion = BUILTIN_VERSIONS.get(characterId);
  if (packVersion === undefined) throw new Error('Built-in character pack unavailable');
  signal?.throwIfAborted();
  const prefix = `./builtin/${characterId}/`;
  const readManifest = manifests[`${prefix}manifest.json`];
  if (!readManifest) throw new Error('Built-in character pack unavailable');
  const readers = new Map<string, () => Promise<Uint8Array>>();
  for (const [file, load] of Object.entries(atlasFiles)) {
    if (file.startsWith(prefix)) readers.set(file.slice(prefix.length), async () => new TextEncoder().encode(await load()));
  }
  for (const [file, load] of Object.entries(imageFiles)) {
    if (file.startsWith(prefix)) readers.set(file.slice(prefix.length), async () => decodePngDataUrl(await load()));
  }
  const source: PackSource = {
    paths: () => [...readers.keys()],
    async read(path, readSignal) {
      readSignal.throwIfAborted();
      const read = readers.get(path);
      if (!read) throw new Error('Built-in asset unavailable');
      const bytes = await read();
      readSignal.throwIfAborted();
      return bytes;
    },
  };
  const manifest = await readManifest();
  signal?.throwIfAborted();
  return resolvePack(manifest, source, { characterId, packVersion, appVersion, ...(signal ? { signal } : {}) });
}
