import { describe, expect, it } from 'vitest';
import {
  cgAssetRefSchema, cgMarkViewedPayloadSchema, cgSetFavoritePayloadSchema,
  galleryPageSchema, galleryQuerySchema, galleryRowSchema,
} from '../src/index.js';
import type {
  CgAssetRef, CgMarkViewedPayload, GalleryPage, GalleryQuery, LockedGalleryRow, PinnedCgAssetRef, UnlockedGalleryRow,
} from '../src/index.js';

const START = 1_700_000_000_000;
const assetHash = 'a1'.repeat(32);
const reference: PinnedCgAssetRef = {
  state: 'PINNED', characterId: 'star-singer', eventDefId: 'dew-postcard', assetVersion: '1.0.0', assetHash,
};
const locked: LockedGalleryRow = {
  petId: 'pet-1', characterId: 'star-singer', cgId: 'morning-dew', variant: 'default',
  title: '晨露草甸', hint: '旅行中可能获得', routeId: 'morning-dew-meadow', eventDefId: 'dew-postcard',
  rarity: 'COMMON', unlockStatus: 'LOCKED',
};
const unlocked: UnlockedGalleryRow = {
  ...locked, unlockStatus: 'UNLOCKED', sourceTripId: 'trip:001', unlockedAt: START,
  favorite: false, viewedAt: null, assetRef: reference,
};
const query: GalleryQuery = { filter: 'ALL', offset: 0, limit: 50 };
const viewed: CgMarkViewedPayload = {
  petId: locked.petId, cgId: locked.cgId, variant: locked.variant, characterId: locked.characterId,
  eventDefId: reference.eventDefId, assetVersion: reference.assetVersion, assetHash,
};

describe('gallery query', () => {
  it('accepts an explicit, bounded query with optional metadata filters', () => {
    expect(galleryQuerySchema.parse(query)).toEqual(query);
    const filtered = { ...query, petId: 'pet-2', characterId: 'fluffy-ranger', routeId: 'morning-dew-meadow',
      eventDefId: 'dew-postcard', rarity: 'RARE', filter: 'FAVORITES', offset: 10_000, limit: 1 };
    expect(galleryQuerySchema.parse(filtered)).toEqual(filtered);
  });

  it.each([
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { offset: -1 }, { offset: 10_001 }, { offset: Infinity },
    { offset: 1.25 }, { filter: 'unlocked' }, { filter: 'UNKNOWN' }, { rarity: 'CUSTOM' }, { rarity: null },
    { petId: '' }, { cgId: 'morning-dew' }, { routeId: '../private' }, { characterId: 'a/b' },
    { eventDefId: 'x'.repeat(129) }, { assetVersion: '1.0.0' }, { assetPath: 'assets/image.png' },
  ])('rejects unrecognized filters and invalid ranges: %o', (invalid) => {
    expect(galleryQuerySchema.safeParse({ ...query, ...invalid }).success).toBe(false);
  });

  it('requires the declared paging fields, without silently inserting a default', () => {
    expect(galleryQuerySchema.safeParse({ offset: 0, limit: 20 }).success).toBe(false);
    expect(galleryQuerySchema.safeParse({ filter: 'LOCKED', limit: 20 }).success).toBe(false);
    expect(galleryQuerySchema.safeParse({ filter: 'LOCKED', offset: 0 }).success).toBe(false);
  });
});

describe('historical CG asset reference', () => {
  it('distinguishes exact pins from legacy and unavailable references', () => {
    expect(cgAssetRefSchema.parse(reference)).toEqual(reference);
    expect(cgAssetRefSchema.parse({ state: 'LEGACY_UNVERSIONED' })).toEqual({ state: 'LEGACY_UNVERSIONED' });
    expect(cgAssetRefSchema.parse({ state: 'UNAVAILABLE_AT_DEPARTURE' })).toEqual({ state: 'UNAVAILABLE_AT_DEPARTURE' });
  });

  it.each([
    { assetHash: 'A1'.repeat(32) }, { assetHash: 'abcd' }, { assetHash: null },
    { assetVersion: '1.0' }, { assetVersion: 'latest' }, { assetVersion: '1.0.00' }, { assetVersion: '65536.0.0' },
    { characterId: 'a/b' }, { eventDefId: '' }, { path: 'assets/image.png' }, { imageUrl: 'file:///private.png' },
  ])('rejects corrupt/incomplete or path-bearing pins: %o', (invalid) => {
    expect(cgAssetRefSchema.safeParse({ ...reference, ...invalid }).success).toBe(false);
  });

  it.each(['LEGACY_UNVERSIONED', 'UNAVAILABLE_AT_DEPARTURE'])('cannot pretend %s is a known asset', (state) => {
    expect(cgAssetRefSchema.safeParse({ state, assetVersion: '1.0.0', assetHash }).success).toBe(false);
    expect(cgAssetRefSchema.safeParse({ state, assetVersion: null }).success).toBe(false);
  });
});

describe('gallery projection is a closed locked/unlocked union', () => {
  it('holds only locked hint metadata and accepts independently unlocked variants', () => {
    expect(galleryRowSchema.parse(locked)).toEqual(locked);
    expect(galleryRowSchema.parse(unlocked)).toEqual(unlocked);
    expect(galleryRowSchema.parse({ ...unlocked, variant: 'special', favorite: true, viewedAt: START + 10 }))
      .toMatchObject({ variant: 'special', favorite: true, viewedAt: START + 10 });
    expect(galleryRowSchema.parse({ ...locked, routeId: null, eventDefId: null, rarity: null }))
      .toMatchObject({ routeId: null, eventDefId: null, rarity: null });
  });

  it.each([
    { assetRef: reference }, { assetHash }, { assetVersion: '1.0.0' }, { image: 'data:image/png;base64,AAAA' },
    { thumbnail: 'assets/thumbnail.png' }, { imagePath: 'assets/private.png' }, { caption: 'Spoiler' },
    { presentationTimeline: [] }, { favorite: false }, { viewedAt: null }, { unlockedAt: START },
    { sourceTripId: 'trip-1' }, { path: 'file:///secret' },
  ])('rejects an asset or unlock-only field on a locked row: %o', (invalid) => {
    expect(galleryRowSchema.safeParse({ ...locked, ...invalid }).success).toBe(false);
  });

  it('does not accept asset paths or captions even on an unlocked row: pure identity DTO only', () => {
    expect(galleryRowSchema.safeParse({ ...unlocked, image: 'assets/actual.png' }).success).toBe(false);
    expect(galleryRowSchema.safeParse({ ...unlocked, captions: ['剧情'] }).success).toBe(false);
    expect(galleryRowSchema.safeParse({ ...unlocked, assetRef: { ...reference, path: 'assets/actual.png' } }).success).toBe(false);
  });

  it.each(['LEGACY_UNVERSIONED', 'UNAVAILABLE_AT_DEPARTURE'] as const)('retains %s as a genuine favorite-able unlock, not a viewed image', (state) => {
    const assetRef: CgAssetRef = { state };
    expect(galleryRowSchema.parse({ ...unlocked, assetRef, favorite: true })).toMatchObject({ assetRef, favorite: true });
    expect(galleryRowSchema.safeParse({ ...unlocked, assetRef, viewedAt: START + 1 }).success).toBe(false);
  });

  it('retains original travel-source rows and permits exact, pinned event-source rows only', () => {
    const event = { ...unlocked, sourceTripId: null, sourceEventId: 'event-1', routeId: null };
    expect(galleryRowSchema.parse(event)).toEqual(event);
    expect(galleryRowSchema.parse(unlocked)).toEqual(unlocked);
    for (const raw of [{ ...event, sourceTripId: 'trip-1' }, { ...event, sourceEventId: null },
      { ...event, assetRef: { state: 'LEGACY_UNVERSIONED' } }, { ...unlocked, sourceTripId: null }]) expect(galleryRowSchema.safeParse(raw).success).toBe(false);
  });

  it.each([
    { viewedAt: START - 1 }, { viewedAt: -1 }, { viewedAt: Infinity }, { unlockedAt: -1 },
    { unlockedAt: Number.MAX_SAFE_INTEGER + 1 }, { favorite: 1 }, { sourceTripId: '' }, { assetRef: null },
    { characterId: 'fluffy-ranger' }, { eventDefId: 'unrelated-event' }, { eventDefId: null },
    { assetRef: { ...reference, characterId: 'fluffy-ranger' } },
    { assetRef: { ...reference, eventDefId: 'different-event' } },
  ])('rejects corrupt row state or contradictory historical identity: %o', (invalid) => {
    expect(galleryRowSchema.safeParse({ ...unlocked, ...invalid }).success).toBe(false);
  });
});

describe('bounded authoritative gallery page', () => {
  const other: LockedGalleryRow = { ...locked, petId: 'pet-2', characterId: 'fluffy-ranger' };
  const page: GalleryPage = { revision: 42, rows: [unlocked, other], total: 2, offset: 0, limit: 50 };

  it('allows different pets and variants with the same CG ID', () => {
    expect(galleryPageSchema.parse(page)).toEqual(page);
    const twoVariants = [unlocked, { ...unlocked, variant: 'alternative' }];
    expect(galleryPageSchema.parse({ ...page, rows: twoVariants }).rows).toHaveLength(2);
  });

  it('accepts a last partial page, an empty collection, and an offset past the end', () => {
    expect(galleryPageSchema.parse({ ...page, rows: [other], total: 2, offset: 1, limit: 50 }).rows).toHaveLength(1);
    expect(galleryPageSchema.parse({ ...page, rows: [], total: 0 }).rows).toHaveLength(0);
    expect(galleryPageSchema.parse({ ...page, rows: [], offset: 10 }).rows).toHaveLength(0);
  });

  it('rejects repeated tuple identity even when other fields or unlock state differ', () => {
    expect(galleryPageSchema.safeParse({ ...page, rows: [unlocked, { ...unlocked, favorite: true }] }).success).toBe(false);
    expect(galleryPageSchema.safeParse({ ...page, rows: [unlocked, locked] }).success).toBe(false);
    const delimited = [{ ...locked, petId: 'a:b', cgId: 'c' }, { ...locked, petId: 'a', cgId: 'b:c' }];
    expect(galleryPageSchema.safeParse({ ...page, rows: delimited }).success).toBe(true);
  });

  it.each([
    { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { total: -1 }, { total: 1 }, { total: 10 },
    { offset: -1 }, { offset: 1 }, { limit: 1 }, { limit: 51 }, { rows: [] }, { paths: [] },
  ])('rejects a corrupt or contradictory page: %o', (invalid) => {
    expect(galleryPageSchema.safeParse({ ...page, ...invalid }).success).toBe(false);
  });

  it('rejects more than the supported page size', () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({ ...locked, petId: `pet-${index}` }));
    expect(galleryPageSchema.safeParse({ ...page, rows, total: 51, limit: 50 }).success).toBe(false);
  });
});

describe('gallery preference intents do not create rewards', () => {
  const favorite = { petId: locked.petId, cgId: locked.cgId, variant: locked.variant, favorite: true };

  it('uses a favorite boolean for an existing unlock identity', () => {
    expect(cgSetFavoritePayloadSchema.parse(favorite)).toEqual(favorite);
    expect(cgSetFavoritePayloadSchema.safeParse({ ...favorite, unlockStatus: 'UNLOCKED' }).success).toBe(false);
    expect(cgSetFavoritePayloadSchema.safeParse({ ...favorite, favorite: 1 }).success).toBe(false);
    expect(cgSetFavoritePayloadSchema.safeParse({ ...favorite, reward: 100 }).success).toBe(false);
  });

  it('requires the exact pin identity for a view request, without client time, source or reward', () => {
    expect(cgMarkViewedPayloadSchema.parse(viewed)).toEqual(viewed);
    expect(cgMarkViewedPayloadSchema.safeParse({ ...viewed, viewedAt: START }).success).toBe(false);
    expect(cgMarkViewedPayloadSchema.safeParse({ ...viewed, sourceTripId: 'trip-1' }).success).toBe(false);
    expect(cgMarkViewedPayloadSchema.safeParse({ ...viewed, rewards: [] }).success).toBe(false);
    expect(cgMarkViewedPayloadSchema.safeParse({ ...viewed, path: '/private/image.png' }).success).toBe(false);
    expect(cgMarkViewedPayloadSchema.safeParse({ ...viewed, assetHash: 'latest' }).success).toBe(false);
    const { assetHash: absent, ...missingHash } = viewed;
    expect(absent).toBe(assetHash);
    expect(cgMarkViewedPayloadSchema.safeParse(missingHash).success).toBe(false);
  });
});
