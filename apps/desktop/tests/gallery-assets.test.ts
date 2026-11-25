import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GalleryPage, GalleryQuery, LockedGalleryRow, UnlockedGalleryRow } from '@pet-desktop/contracts';
import { BUILTIN_CG_CATALOG } from '@pet-desktop/domain/cg-catalog';
import type { CgCatalogEntry } from '@pet-desktop/domain/cg-catalog';
import { cgAcquisitionKey, createCgAssetRegistry, resolveBuiltinCg } from '../src/renderer/cg-assets/registry';
import { confirmedViewPayload, exactGalleryRow, returnedGalleryMatchesQuery, usableGalleryPage } from '../src/renderer/cg-assets/gallery-view-policy';

const first = BUILTIN_CG_CATALOG[0]!;
const key = (entry: CgCatalogEntry, kind: 'image' | 'thumbnail') => `./builtin/${entry.characterId}/${entry.cgId}/${entry.variant}/${entry.assetVersion}/${kind}.png`;
function readDataUrl(entry: CgCatalogEntry, kind: 'image' | 'thumbnail'): string {
  const path = join(import.meta.dirname, '../src/renderer/cg-assets', key(entry, kind));
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}
const locked = (entry: CgCatalogEntry): LockedGalleryRow => ({
  petId: 'pet-1', characterId: entry.characterId, cgId: entry.cgId, variant: entry.variant, title: entry.title,
  hint: entry.hint, routeId: entry.routeId, eventDefId: entry.eventDefId, rarity: entry.rarity, unlockStatus: 'LOCKED',
});

describe('Gallery renderer projection and first-view policy', () => {
  const row = unlocked(first);
  const gallery: GalleryPage = { revision: 12, offset: 0, limit: 12, total: 1, rows: [row] };
  const query: GalleryQuery = { filter: 'UNLOCKED', offset: 0, limit: 12, petId: row.petId,
    characterId: row.characterId, routeId: first.routeId, eventDefId: first.eventDefId, rarity: first.rarity };

  it('withholds pages from old filters, old revisions and previous service generations', () => {
    const page = { generation: 3, queryKey: 'query-1', gallery };
    expect(usableGalleryPage(page, 3, 'query-1', 12)).toEqual(gallery);
    expect(usableGalleryPage(page, 3, 'query-2', 12)).toBeNull();
    expect(usableGalleryPage(page, 2, 'query-1', 12)).toBeNull();
    for (const result of [null, 11, 13]) expect(usableGalleryPage(page, 3, 'query-1', result)).toBeNull();
    expect(usableGalleryPage(page, null, 'query-1', 12)).toBeNull();
  });

  it('requires the requested pagination, filters and current revision even after response schema validation', () => {
    expect(returnedGalleryMatchesQuery(gallery, query, 11, 12)).toBe(true);
    expect(returnedGalleryMatchesQuery(gallery, query, 13, 12)).toBe(false);
    expect(returnedGalleryMatchesQuery(gallery, query, 11, 13)).toBe(false);
    expect(returnedGalleryMatchesQuery(gallery, query, 11, null)).toBe(false);
    for (const changes of [{ offset: 12 }, { limit: 20 }, { petId: 'other' }, { characterId: 'other' },
      { routeId: 'other' }, { eventDefId: 'other' }, { rarity: 'RARE' }, { filter: 'FAVORITES' }, { filter: 'LOCKED' }] as const) {
      expect(returnedGalleryMatchesQuery(gallery, { ...query, ...changes }, 11, 12)).toBe(false);
    }
    expect(returnedGalleryMatchesQuery({ ...gallery, rows: [locked(first)] }, query, 11, 12)).toBe(false);
    expect(exactGalleryRow({ ...gallery, rows: [{ ...row, favorite: true }] }, row)?.favorite).toBe(true);
    expect(exactGalleryRow({ ...gallery, rows: [unlocked({ ...first, assetVersion: '2.0.0' })] }, row)).toBeUndefined();
  });

  it('marks only the actually displayed, exact high-resolution image for a present pinned acquisition', async () => {
    const image = await resolveBuiltinCg(row, 'image', signal());
    const thumb = await resolveBuiltinCg(row, 'thumbnail', signal());
    if (!image.ok || !thumb.ok) throw new Error('Expected authentic fixture assets');
    const context = { selected: row, current: row, selectedGeneration: 3, currentGeneration: 3,
      image: image.asset, imageLoaded: true, allowCommands: true };
    expect(confirmedViewPayload(context)).toEqual({ petId: row.petId, cgId: row.cgId, variant: row.variant,
      characterId: first.characterId, eventDefId: first.eventDefId, assetVersion: first.assetVersion, assetHash: first.assetHash });
    for (const changes of [
      { imageLoaded: false }, { allowCommands: false }, { currentGeneration: null }, { currentGeneration: 4 }, { current: null },
      { image: null }, { image: thumb.asset }, { current: { ...row, viewedAt: row.unlockedAt } },
      { current: unlocked({ ...first, assetVersion: '2.0.0' }) },
      { image: { ...image.asset, entry: { ...image.asset.entry, cgId: 'wrong' } } },
      { current: { ...row, assetRef: { state: 'LEGACY_UNVERSIONED' } }, selected: { ...row, assetRef: { state: 'LEGACY_UNVERSIONED' } } },
    ] as const) expect(confirmedViewPayload({ ...context, ...changes })).toBeUndefined();
  });
});
const unlocked = (entry: CgCatalogEntry): UnlockedGalleryRow => ({
  ...locked(entry), unlockStatus: 'UNLOCKED', sourceTripId: 'trip-1', unlockedAt: 30_000, viewedAt: null, favorite: false,
  assetRef: { state: 'PINNED', characterId: entry.characterId, eventDefId: entry.eventDefId, assetVersion: entry.assetVersion, assetHash: entry.assetHash },
});
const signal = () => new AbortController().signal;

describe('Strict renderer CG asset registry', () => {
  it('never imports any artwork for locked, unavailable, legacy or malformed rows', async () => {
    const image = vi.fn(async () => readDataUrl(first, 'image'));
    const thumbnail = vi.fn(async () => readDataUrl(first, 'thumbnail'));
    const resolve = createCgAssetRegistry([first], { [key(first, 'image')]: image, [key(first, 'thumbnail')]: thumbnail });
    for (const kind of ['image', 'thumbnail'] as const) {
      expect(await resolve(locked(first), kind, signal())).toEqual({ ok: false, code: 'LOCKED' });
      expect(await resolve({ ...unlocked(first), assetRef: { state: 'LEGACY_UNVERSIONED' } }, kind, signal()))
        .toEqual({ ok: false, code: 'LEGACY_UNVERSIONED' });
      expect(await resolve({ ...unlocked(first), assetRef: { state: 'UNAVAILABLE_AT_DEPARTURE' } }, kind, signal()))
        .toEqual({ ok: false, code: 'UNAVAILABLE_AT_DEPARTURE' });
      expect(await resolve({ ...locked(first), image: 'data:image/png;base64,fake' }, kind, signal())).toEqual({ ok: false, code: 'INVALID_ROW' });
    }
    expect(image).not.toHaveBeenCalled();
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it('selects only exact version and chosen file, never substitutes newest or high-res for thumbnail', async () => {
    const newest = { ...first, assetVersion: '2.0.0' };
    const thumb = vi.fn(async () => readDataUrl(first, 'thumbnail'));
    const image = vi.fn(async () => readDataUrl(first, 'image'));
    const newer = vi.fn(async () => 'unused');
    const resolve = createCgAssetRegistry([first, newest], {
      [key(first, 'thumbnail')]: thumb, [key(first, 'image')]: image, [key(newest, 'thumbnail')]: newer,
    });
    expect(await resolve(unlocked(first), 'thumbnail', signal())).toMatchObject({
      ok: true, asset: { kind: 'thumbnail', entry: { assetVersion: first.assetVersion }, width: 256, height: 144 },
    });
    expect(thumb).toHaveBeenCalledOnce();
    expect(image).not.toHaveBeenCalled();
    expect(newer).not.toHaveBeenCalled();
    const missing = { ...first, assetVersion: '3.0.0' };
    expect(await resolve(unlocked(missing), 'image', signal())).toEqual({ ok: false, code: 'VERSION_UNAVAILABLE' });
    expect(image).not.toHaveBeenCalled();
    expect(newer).not.toHaveBeenCalled();
  });

  it('rejects pinned hash, event, route and canonical descriptor mismatch before import', async () => {
    const load = vi.fn(async () => readDataUrl(first, 'image'));
    const map = { [key(first, 'image')]: load };
    const resolve = createCgAssetRegistry([first], map);
    const wrongHash = { ...first, assetHash: '0'.repeat(64) };
    expect(await resolve(unlocked(wrongHash), 'image', signal())).toEqual({ ok: false, code: 'IDENTITY_MISMATCH' });
    expect(await resolve(unlocked({ ...first, eventDefId: 'other-event' }), 'image', signal())).toEqual({ ok: false, code: 'IDENTITY_MISMATCH' });
    expect(await resolve(unlocked({ ...first, routeId: 'other-route' }), 'image', signal())).toEqual({ ok: false, code: 'IDENTITY_MISMATCH' });
    const corruptedMetadata = createCgAssetRegistry([{ ...first, caption: 'different caption' }], map);
    expect(await corruptedMetadata(unlocked(first), 'image', signal())).toEqual({ ok: false, code: 'CORRUPTED_ASSET' });
    expect(load).not.toHaveBeenCalled();
  });

  it('does not release bytes on MIME, byte count or same-size content corruption', async () => {
    const valid = readDataUrl(first, 'image');
    const bytes = Buffer.from(valid.slice('data:image/png;base64,'.length), 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    for (const malformed of [valid.replace('image/png', 'text/html'), valid.slice(0, -4), `data:image/png;base64,${bytes.toString('base64')}`]) {
      const resolve = createCgAssetRegistry([first], { [key(first, 'image')]: async () => malformed });
      expect(await resolve(unlocked(first), 'image', signal())).toEqual({ ok: false, code: 'CORRUPTED_ASSET' });
    }
  });

  it('settles cancellation while the exact high-resolution import is still pending and discards its late bytes', async () => {
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const loader = () => new Promise<string>((resolve) => { release = resolve; entered(); });
    const resolve = createCgAssetRegistry([first], { [key(first, 'image')]: loader });
    const controller = new AbortController();
    const pending = resolve(unlocked(first), 'image', controller.signal);
    await started;
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'CANCELLED' });
    release(readDataUrl(first, 'image'));
    expect(await pending).toEqual(result);
    expect(await resolve(unlocked(first), 'image', controller.signal)).toEqual(result);
  });

  it('resolves actual bundled lazy bytes for each catalog history and rejects different pins', async () => {
    for (const entry of BUILTIN_CG_CATALOG) {
      for (const kind of ['image', 'thumbnail'] as const) {
        const result = await resolveBuiltinCg(unlocked(entry), kind, signal());
        expect(result).toMatchObject({ ok: true, asset: { kind, src: readDataUrl(entry, kind), entry } });
      }
    }
    expect(cgAcquisitionKey({ ...unlocked(first), favorite: true, viewedAt: 31_000 })).toBe(cgAcquisitionKey(unlocked(first)));
    expect(cgAcquisitionKey(unlocked({ ...first, assetVersion: '2.0.0' }))).not.toBe(cgAcquisitionKey(unlocked(first)));
  });
});
