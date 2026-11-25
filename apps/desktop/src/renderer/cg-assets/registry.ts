import { galleryRowSchema } from '@pet-desktop/contracts';
import type { GalleryRow, UnlockedGalleryRow } from '@pet-desktop/contracts';
import { BUILTIN_CG_CATALOG, serializeCgAssetDescriptor } from '@pet-desktop/domain/cg-catalog';
import type { CgAssetFile, CgCatalogEntry } from '@pet-desktop/domain/cg-catalog';

export type CgAssetKind = 'thumbnail' | 'image';
export type CgAssetFailureCode = 'INVALID_ROW' | 'LOCKED' | 'LEGACY_UNVERSIONED' | 'UNAVAILABLE_AT_DEPARTURE'
  | 'VERSION_UNAVAILABLE' | 'IDENTITY_MISMATCH' | 'CORRUPTED_ASSET' | 'CANCELLED';

interface VerifiedCgAsset {
  readonly kind: CgAssetKind;
  /** Already-verified embedded data URL. Never a path or URL from IPC. */
  readonly src: string;
  readonly entry: CgCatalogEntry;
  readonly width: number;
  readonly height: number;
}

export type CgAssetResult = { readonly ok: true; readonly asset: VerifiedCgAsset }
  | { readonly ok: false; readonly code: CgAssetFailureCode };
export type CgAssetLoaderMap = Readonly<Record<string, () => Promise<string>>>;

export const cgFailureText: Readonly<Record<CgAssetFailureCode, string>> = Object.freeze({
  INVALID_ROW: '图鉴记录无法验证。',
  LOCKED: '尚未解锁这一画面。',
  LEGACY_UNVERSIONED: '历史记录没有绑定资源版本，无法安全恢复原始画面。',
  UNAVAILABLE_AT_DEPARTURE: '出发时尚无此纪念画面的固定资源。',
  VERSION_UNAVAILABLE: '首次获得时的资源版本暂不可用，已保留历史记录。',
  IDENTITY_MISMATCH: '历史资源身份不匹配，已停止加载。',
  CORRUPTED_ASSET: '固定资源校验或读取失败，可稍后重新尝试。',
  CANCELLED: '加载已取消。',
});

class CgAssetFailure extends Error {
  constructor(readonly code: CgAssetFailureCode) { super(code); }
}
function fail(code: CgAssetFailureCode): never { throw new CgAssetFailure(code); }
function checkAborted(signal: AbortSignal): void { if (signal.aborted) fail('CANCELLED'); }

/** Dynamic imports and WebCrypto cannot be stopped once scheduled. Do not
 * expose a late result, and remove the abort listener on every settle path. */
function cancellable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new CgAssetFailure('CANCELLED')); return; }
    const abort = () => reject(new CgAssetFailure('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    const clear = () => signal.removeEventListener('abort', abort);
    try {
      void work().then((value) => { clear(); resolve(value); }, (error: unknown) => { clear(); reject(error); });
    } catch (error) { clear(); reject(error); }
  });
}

function sha256(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  return cancellable(async () => {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, signal);
}

const dataPrefix = 'data:image/png;base64,';
const digestSyntax = /^[0-9a-f]{64}$/u;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const maxFileBytes = 16 * 1024 * 1024;

function validFile(file: CgAssetFile): boolean {
  return Number.isSafeInteger(file.bytes) && file.bytes >= 33 && file.bytes <= maxFileBytes && digestSyntax.test(file.sha256);
}

function decodePngDataUrl(url: string, expected: CgAssetFile): { bytes: Uint8Array<ArrayBuffer>; width: number; height: number } {
  if (typeof url !== 'string' || !url.startsWith(dataPrefix) || !validFile(expected)) fail('CORRUPTED_ASSET');
  const encoded = url.slice(dataPrefix.length);
  if (encoded.length !== 4 * Math.ceil(expected.bytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail('CORRUPTED_ASSET');
  let raw: string;
  try { raw = atob(encoded); } catch { return fail('CORRUPTED_ASSET'); }
  if (raw.length !== expected.bytes) fail('CORRUPTED_ASSET');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  if (!pngSignature.every((value, index) => bytes[index] === value)) fail('CORRUPTED_ASSET');
  const view = new DataView(bytes.buffer);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) fail('CORRUPTED_ASSET');
  const width = view.getUint32(16), height = view.getUint32(20);
  // Refuse unexpected oversized allocations even if a future bundled
  // descriptor accidentally pins such an image. Browser decode is still
  // required before the UI can mark the first view.
  if (width < 1 || height < 1 || width > 4096 || height > 4096) fail('CORRUPTED_ASSET');
  return { bytes, width, height };
}

/** Stable display key. Full acquisition key also distinguishes exact pinned
 * history and unlock time; favorites/viewed preferences do not change it. */
export function cgRowKey(row: GalleryRow): string {
  return JSON.stringify([row.petId, row.cgId, row.variant]);
}
export function cgAcquisitionKey(row: UnlockedGalleryRow): string {
  const ref = row.assetRef;
  return JSON.stringify([
    row.petId, row.cgId, row.variant, row.characterId, row.eventDefId, row.routeId, row.sourceTripId, row.unlockedAt,
    ref.state, ...(ref.state === 'PINNED' ? [ref.characterId, ref.eventDefId, ref.assetVersion, ref.assetHash] : []),
  ]);
}

/** Only locally compiled exact catalog entries and static loader keys exist.
 * Locked, unavailable and legacy rows never resolve any artwork, and a pinned
 * version is never replaced by the newest catalog entry. */
export function createCgAssetRegistry(catalog: readonly CgCatalogEntry[], loaders: CgAssetLoaderMap) {
  return async (rawRow: unknown, kind: CgAssetKind, signal: AbortSignal): Promise<CgAssetResult> => {
    try {
      checkAborted(signal);
      if (kind !== 'thumbnail' && kind !== 'image') fail('INVALID_ROW');
      const parsed = galleryRowSchema.safeParse(rawRow);
      if (!parsed.success) fail('INVALID_ROW');
      const row = parsed.data;
      if (row.unlockStatus !== 'UNLOCKED') fail('LOCKED');
      const ref = row.assetRef;
      if (ref.state !== 'PINNED') fail(ref.state);
      const matches = catalog.filter((entry) => entry.characterId === ref.characterId && entry.cgId === row.cgId
        && entry.variant === row.variant && entry.assetVersion === ref.assetVersion);
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry) fail(matches.length > 1 ? 'IDENTITY_MISMATCH' : 'VERSION_UNAVAILABLE');
      if (entry.eventDefId !== ref.eventDefId || entry.routeId !== row.routeId || entry.assetHash !== ref.assetHash) fail('IDENTITY_MISMATCH');
      if (!validFile(entry.image) || !validFile(entry.thumbnail)) fail('CORRUPTED_ASSET');
      if (await sha256(new TextEncoder().encode(serializeCgAssetDescriptor(entry)), signal) !== ref.assetHash) fail('CORRUPTED_ASSET');
      checkAborted(signal);

      // Merely resolving a locked card or a thumbnail cannot execute an image
      // loader: only this specific, selected exact file key is invoked.
      const key = `./builtin/${entry.characterId}/${entry.cgId}/${entry.variant}/${entry.assetVersion}/${kind}.png`;
      const load = Object.hasOwn(loaders, key) ? loaders[key] : undefined;
      if (!load) fail('VERSION_UNAVAILABLE');
      const src = await cancellable(load, signal);
      checkAborted(signal);
      const { bytes, width, height } = decodePngDataUrl(src, entry[kind]);
      if (await sha256(bytes, signal) !== entry[kind].sha256) fail('CORRUPTED_ASSET');
      checkAborted(signal);
      return { ok: true, asset: { entry, kind, src, width, height } };
    } catch (error) {
      return { ok: false, code: signal.aborted ? 'CANCELLED' : error instanceof CgAssetFailure ? error.code : 'CORRUPTED_ASSET' };
    }
  };
}

// Vite generates per-file lazy loaders; no network or arbitrary file access
// is possible. `?inline` also avoids production fetch(file:) restrictions.
const builtinLoaders = import.meta.glob<string>('./builtin/*/*/*/*/*.png', { query: '?inline', import: 'default' });
export const resolveBuiltinCg = createCgAssetRegistry(BUILTIN_CG_CATALOG, builtinLoaders);
