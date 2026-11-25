import {
  characterPackManifestSchema,
  spriteAtlasSchema,
  validateSpriteAtlas,
} from '@pet-desktop/contracts';
import type { CharacterPackManifest, SpriteAtlas } from '@pet-desktop/contracts';
import { parseCubismModelSettings, type CubismModelSettings, validateCubismMetadata } from './cubism-model-settings';

/** A capability for one already selected local pack. */
export interface PackSource {
  /** Exact asset paths (manifest.json is provided separately); no absolute paths. */
  paths(): readonly string[];
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
}

export interface ResolvePackOptions {
  characterId: string;
  packVersion: string;
  appVersion: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test/platform injection; default is Web Crypto SHA-256. */
  digest?: (bytes: Uint8Array) => Promise<string>;
}

export type PackResolveErrorCode =
  | 'INVALID_MANIFEST'
  | 'IDENTITY_MISMATCH'
  | 'INCOMPATIBLE_APP'
  | 'UNSUPPORTED_FORMAT'
  | 'NO_STATIC_FALLBACK'
  | 'SOURCE_MISMATCH'
  | 'READ_FAILED'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'DIGEST_FAILED'
  | 'INVALID_PNG'
  | 'TEXTURE_BUDGET_EXCEEDED'
  | 'INVALID_ATLAS'
  | 'INVALID_CUBISM'
  | 'ABORTED'
  | 'TIMEOUT';

/** Errors crossing to UI carry only a fixed code, never host paths or raw exceptions. */
export class PackResolveError extends Error {
  constructor(readonly code: PackResolveErrorCode) {
    super(code);
    this.name = 'PackResolveError';
  }
}

export interface PackImageSize { readonly w: number; readonly h: number }

interface ResolvedVariantBase {
  readonly id: string;
  readonly entry: string;
  readonly imagePath: string;
  readonly imageSize: PackImageSize;
}

export type ResolvedPackVariant =
  | (ResolvedVariantBase & { readonly renderer: 'sprite'; readonly atlas: SpriteAtlas })
  | (ResolvedVariantBase & { readonly renderer: 'static' })
  | { readonly renderer: 'cubism'; readonly id: string; readonly entry: string; readonly model: CubismModelSettings;
    readonly textures: readonly { readonly path: string; readonly size: PackImageSize }[] };

export interface ResolvedPack {
  /** Parsed and frozen copies, independent of source objects. */
  readonly manifest: CharacterPackManifest;
  readonly variants: readonly ResolvedPackVariant[];
  /** A fresh copy of already verified bytes, never a subsequent source read. */
  readAsset(path: string): Uint8Array<ArrayBuffer> | undefined;
}

const MAX_TEXTURE_DIMENSION = 2048;
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_CHUNKS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_COLOR_CHUNK_SIZES = new Map([[0x73524742, 1], [0x67414d41, 4], [0x6348524d, 32],
  [0x70485973, 9], [0x73424954, 4]]);

function fail(code: PackResolveErrorCode): never {
  throw new PackResolveError(code);
}

/** Keep cancellation responsive even for a source/digest which ignores the signal. */
function abortable<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return start();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function parseVersion(value: string): readonly number[] | undefined {
  if (!/^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.every(part => part <= 65535) ? parts : undefined;
}

function versionAtLeast(current: string, required: string): boolean {
  const actual = parseVersion(current);
  const minimum = parseVersion(required);
  if (!actual || !minimum) return false;
  for (let i = 0; i < 3; i++) {
    const difference = (actual[i] ?? 0) - (minimum[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** PNG chunk checksum check is a structural guard, not pixel decoding. */
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++) c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array, from: number, until: number): number {
  let crc = 0xffffffff;
  for (let i = from; i < until; i++) crc = (crcTable[(crc ^ (bytes[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Non-interlaced, 8bpc RGBA PNG. Bounded provenance or fixed-size color
 * metadata may precede the pixel data.
 * Checks container/CRC/dimensions before any image decoder can allocate pixels.
 * IDAT decompression/pixel decoding is deliberately delegated to the renderer adapter.
 */
function inspectPng(bytes: Uint8Array): PackImageSize {
  if (bytes.byteLength < 45 || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) fail('INVALID_PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunks = 0;
  let compressedBytes = 0;
  let provenance = false;
  const colorChunks = new Set<number>();
  let size: PackImageSize | undefined;
  while (offset <= bytes.length - 12 && ++chunks <= MAX_PNG_CHUNKS) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) fail('INVALID_PNG');
    const type = view.getUint32(offset + 4);
    const data = offset + 8;
    const checksum = data + length;
    const next = checksum + 4;
    if (crc32(bytes, offset + 4, checksum) !== view.getUint32(checksum)) fail('INVALID_PNG');
    if (!size) {
      // First chunk must be exactly IHDR, with a supported 8-bit RGBA layout.
      if (type !== 0x49484452 || length !== 13) fail('INVALID_PNG');
      const w = view.getUint32(data), h = view.getUint32(data + 4);
      if (w < 1 || h < 1 || w > MAX_TEXTURE_DIMENSION || h > MAX_TEXTURE_DIMENSION
        || bytes[data + 8] !== 8 || bytes[data + 9] !== 6 || bytes[data + 10] !== 0
        || bytes[data + 11] !== 0 || bytes[data + 12] !== 0) fail('INVALID_PNG');
      size = Object.freeze({ w, h });
    } else if (type === 0x63614258) { // caBX Content Credentials metadata
      if (provenance || compressedBytes !== 0 || length === 0 || length > 256 * 1024) fail('INVALID_PNG');
      provenance = true;
    } else if (PNG_COLOR_CHUNK_SIZES.has(type)) {
      if (compressedBytes !== 0 || colorChunks.has(type) || length !== PNG_COLOR_CHUNK_SIZES.get(type)) fail('INVALID_PNG');
      colorChunks.add(type);
    } else if (type === 0x49444154) { // IDAT; zero-size adjacent chunks are legal.
      compressedBytes += length;
    } else if (type === 0x49454e44) { // IEND
      if (length !== 0 || compressedBytes === 0 || next !== bytes.length) fail('INVALID_PNG');
      return size;
    } else {
      fail('INVALID_PNG');
    }
    offset = next;
  }
  return fail('INVALID_PNG');
}

function freezeData<T>(data: T): T {
  if (data !== null && typeof data === 'object' && !Object.isFrozen(data)) {
    for (const value of Object.values(data)) freezeData(value);
    Object.freeze(data);
  }
  return data;
}

/**
 * Prepare a verified local pack in isolation. No global registry/cache/current pet
 * is changed; caller may commit only after success and adapter preparation.
 * Hashes establish byte integrity against the selected manifest, not authenticity;
 * source selection, signing, external archives and version pinning remain upstream.
 */
export async function resolvePack(
  rawManifest: unknown,
  source: PackSource,
  options: ResolvePackOptions,
): Promise<ResolvedPack> {
  const controller = new AbortController();
  const abort = () => controller.abort(new PackResolveError('ABORTED'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('INVALID_MANIFEST');
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => controller.abort(new PackResolveError('TIMEOUT')), timeoutMs);
  try {
    checkAborted(controller.signal);
    const parsed = characterPackManifestSchema.safeParse(rawManifest);
    if (!parsed.success) fail('INVALID_MANIFEST');
    const manifest = parsed.data;
    if (manifest.characterId !== options.characterId || manifest.packVersion !== options.packVersion) fail('IDENTITY_MISMATCH');
    if (!versionAtLeast(options.appVersion, manifest.minAppVersion)) fail('INCOMPATIBLE_APP');
    if (manifest.variants.some(variant => !['sprite', 'static', 'cubism'].includes(variant.renderer))
      || manifest.files.some(file => !file.path.endsWith('.png') && !file.path.endsWith('.json') && !file.path.endsWith('.moc3'))
      || !manifest.thumbnail.endsWith('.png')) fail('UNSUPPORTED_FORMAT');
    if (!manifest.variants.some(variant => variant.renderer === 'static')) fail('NO_STATIC_FALLBACK');

    let paths: readonly string[];
    try { paths = source.paths(); } catch { fail('SOURCE_MISMATCH'); }
    if (!Array.isArray(paths) || paths.length !== manifest.files.length) fail('SOURCE_MISMATCH');
    const pathSet = new Set(paths);
    if (pathSet.size !== paths.length || manifest.files.some(file => !pathSet.has(file.path))) fail('SOURCE_MISMATCH');

    const verified = new Map<string, Uint8Array<ArrayBuffer>>();
    const images = new Map<string, PackImageSize>();
    let textureBytes = 0;
    for (const file of manifest.files) {
      checkAborted(controller.signal);
      let received: Uint8Array;
      try { received = await abortable(controller.signal, () => source.read(file.path, controller.signal)); }
      catch { checkAborted(controller.signal); fail('READ_FAILED'); }
      if (!(received instanceof Uint8Array) || received.byteLength !== file.bytes) fail('SIZE_MISMATCH');
      // Do not preserve an attacker/source-owned view or allow digest injection to edit it.
      const bytes = new Uint8Array(received);
      let hash: string;
      try { hash = await abortable(controller.signal, () => (options.digest ?? sha256Hex)(bytes.slice())); }
      catch { checkAborted(controller.signal); fail('DIGEST_FAILED'); }
      if (hash !== file.sha256) fail('HASH_MISMATCH');
      checkAborted(controller.signal);
      if (file.path.endsWith('.png')) {
        const size = inspectPng(bytes);
        textureBytes += size.w * size.h * 4;
        if (textureBytes > MAX_TEXTURE_BYTES) fail('TEXTURE_BUDGET_EXCEEDED');
        images.set(file.path, size);
      }
      verified.set(file.path, bytes);
    }

    const requiredPaths = new Set([manifest.thumbnail]);
    const variants: ResolvedPackVariant[] = [];
    if (!images.has(manifest.thumbnail)) fail('INVALID_PNG');
    for (const variant of manifest.variants) {
      requiredPaths.add(variant.entry);
      if (variant.renderer === 'static') {
        const imageSize = images.get(variant.entry);
        if (!imageSize) fail('INVALID_PNG');
        variants.push({ renderer: 'static', id: variant.id, entry: variant.entry, imagePath: variant.entry, imageSize });
      } else if (variant.renderer === 'sprite') {
        const data = verified.get(variant.entry);
        if (!data) fail('INVALID_ATLAS');
        let atlas: SpriteAtlas;
        try {
          // Reject malformed UTF-8, then strict schema and all cross-file references.
          atlas = spriteAtlasSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
          validateSpriteAtlas(manifest, variant.id, atlas);
        } catch { fail('INVALID_ATLAS'); }
        requiredPaths.add(atlas.image);
        const imageSize = images.get(atlas.image);
        if (!imageSize || imageSize.w !== atlas.size.w || imageSize.h !== atlas.size.h) fail('INVALID_ATLAS');
        variants.push({ renderer: 'sprite', id: variant.id, entry: variant.entry, atlas, imagePath: atlas.image, imageSize });
      } else if (variant.renderer === 'cubism') {
        const jsonBytes = verified.get(variant.entry);
        if (!jsonBytes) fail('INVALID_CUBISM');
        let model: CubismModelSettings;
        try { model = parseCubismModelSettings(variant.entry, jsonBytes); }
        catch { fail('INVALID_CUBISM'); }
        for (const [semantic, actions] of Object.entries(manifest.actions)) {
          const group = actions[variant.id];
          if (group && !(semantic === 'idle' && group === 'idle') && !Object.hasOwn(model.motions, group)) fail('INVALID_CUBISM');
        }
        for (const path of model.dependencies) {
          const dependency = verified.get(path);
          if (!dependency) fail('INVALID_CUBISM');
          if (path.endsWith('.json')) {
            try { validateCubismMetadata(path, dependency); } catch { fail('INVALID_CUBISM'); }
          }
          requiredPaths.add(path);
        }
        const mocBytes = verified.get(model.moc);
        // Container signature only. The official runtime must still check MOC
        // consistency before any model object is allocated.
        if (!mocBytes || mocBytes.byteLength < 64 || mocBytes[0] !== 0x4d || mocBytes[1] !== 0x4f
          || mocBytes[2] !== 0x43 || mocBytes[3] !== 0x33) fail('INVALID_CUBISM');
        const textures = model.textures.map(path => {
          const size = images.get(path);
          if (!size) fail('INVALID_CUBISM');
          return { path, size };
        });
        variants.push({ renderer: 'cubism', id: variant.id, entry: variant.entry, model, textures });
      } else { fail('UNSUPPORTED_FORMAT'); }
    }

    // Only validated dependencies belong to this pack. The SDK and its
    // shaders are never loaded from user asset files.
    if (requiredPaths.size !== verified.size || [...verified.keys()].some(path => !requiredPaths.has(path))) fail('SOURCE_MISMATCH');
    checkAborted(controller.signal);
    return Object.freeze({
      manifest: freezeData(manifest),
      variants: freezeData(variants),
      readAsset: (path: string) => verified.get(path)?.slice(),
    });
  } catch (error) {
    checkAborted(controller.signal);
    if (error instanceof PackResolveError) throw error;
    return fail('INVALID_MANIFEST');
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
  }
}
