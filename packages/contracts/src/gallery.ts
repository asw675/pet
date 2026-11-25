import { z } from 'zod';
import { packVersionSchema } from '#character-pack';

/** Gallery DTOs carry identities, never file paths, image bytes or unlock rules. */
const galleryIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const safeNonnegativeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const cgAssetHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const galleryLimits = Object.freeze({ pageSize: 50, offset: 10_000 });
const offsetSchema = safeNonnegativeSchema.max(galleryLimits.offset);
const pageSizeSchema = safeNonnegativeSchema.min(1).max(galleryLimits.pageSize);

export const galleryRaritySchema = z.enum(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']);
export type GalleryRarity = z.infer<typeof galleryRaritySchema>;
export const galleryFilterSchema = z.enum(['ALL', 'LOCKED', 'UNLOCKED', 'FAVORITES']);
export type GalleryFilter = z.infer<typeof galleryFilterSchema>;

export const galleryQuerySchema = z.strictObject({
  petId: galleryIdSchema.optional(),
  characterId: galleryIdSchema.optional(),
  routeId: galleryIdSchema.optional(),
  eventDefId: galleryIdSchema.optional(),
  rarity: galleryRaritySchema.optional(),
  filter: galleryFilterSchema,
  offset: offsetSchema,
  limit: pageSizeSchema,
});
export type GalleryQuery = z.infer<typeof galleryQuerySchema>;

/** A missing historical reference is not interchangeable with a current asset.
 * Legacy and unavailable entries intentionally cannot carry a hash/version. */
const pinnedCgAssetRefSchema = z.strictObject({
  state: z.literal('PINNED'),
  assetVersion: packVersionSchema,
  assetHash: cgAssetHashSchema,
  characterId: galleryIdSchema,
  eventDefId: galleryIdSchema,
});

export const cgAssetRefSchema = z.discriminatedUnion('state', [
  pinnedCgAssetRefSchema,
  z.strictObject({ state: z.literal('LEGACY_UNVERSIONED') }),
  z.strictObject({ state: z.literal('UNAVAILABLE_AT_DEPARTURE') }),
]);
export type CgAssetRef = z.infer<typeof cgAssetRefSchema>;
export type PinnedCgAssetRef = z.infer<typeof pinnedCgAssetRefSchema>;
export type CgAssetState = CgAssetRef['state'];

const unlockKeyFields = {
  petId: galleryIdSchema,
  cgId: galleryIdSchema,
  variant: galleryIdSchema,
};
const rowFields = {
  ...unlockKeyFields,
  characterId: galleryIdSchema,
  title: z.string().min(1).max(128),
  hint: z.string().min(1).max(512),
  routeId: galleryIdSchema.nullable(),
  eventDefId: galleryIdSchema.nullable(),
  rarity: galleryRaritySchema.nullable(),
};

const lockedGalleryRowSchema = z.strictObject({
  ...rowFields,
  unlockStatus: z.literal('LOCKED'),
});

const unlockedGalleryRowSchema = z.strictObject({
  ...rowFields,
  unlockStatus: z.literal('UNLOCKED'),
  sourceTripId: galleryIdSchema,
  unlockedAt: safeNonnegativeSchema,
  favorite: z.boolean(),
  viewedAt: safeNonnegativeSchema.nullable(),
  assetRef: cgAssetRefSchema,
});

/** A locked row is a separate closed shape, not an unlocked row with hidden
 * fields. No asset descriptor, caption or URL can be sent for either row. */
export const galleryRowSchema = z.discriminatedUnion('unlockStatus', [
  lockedGalleryRowSchema,
  unlockedGalleryRowSchema,
]).superRefine((row, context) => {
  if (row.unlockStatus !== 'UNLOCKED') return;
  if (row.viewedAt !== null && row.viewedAt < row.unlockedAt) {
    context.addIssue({ code: 'custom', path: ['viewedAt'], message: 'View time cannot precede unlock time' });
  }
  if (row.assetRef.state !== 'PINNED') {
    if (row.viewedAt !== null) {
      context.addIssue({ code: 'custom', path: ['viewedAt'], message: 'Unversioned or unavailable CG cannot be marked viewed' });
    }
    return;
  }
  if (row.assetRef.characterId !== row.characterId || row.assetRef.eventDefId !== row.eventDefId) {
    context.addIssue({ code: 'custom', path: ['assetRef'], message: 'Pinned character and event must match the gallery row' });
  }
});
export type GalleryRow = z.infer<typeof galleryRowSchema>;
export type LockedGalleryRow = Extract<GalleryRow, { unlockStatus: 'LOCKED' }>;
export type UnlockedGalleryRow = Extract<GalleryRow, { unlockStatus: 'UNLOCKED' }>;

/** Current authoritatively filtered pagination. The revision must be compared
 * with the containing snapshot when the query transport is introduced. */
export const galleryPageSchema = z.strictObject({
  revision: safeNonnegativeSchema,
  rows: z.array(galleryRowSchema).max(galleryLimits.pageSize),
  total: safeNonnegativeSchema,
  offset: offsetSchema,
  limit: pageSizeSchema,
}).superRefine((page, context) => {
  const expectedRows = Math.min(page.limit, Math.max(0, page.total - page.offset));
  if (page.rows.length !== expectedRows) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'Gallery page length contradicts its total, offset or limit' });
  }
  const keys = new Set<string>();
  page.rows.forEach((row, index) => {
    const key = JSON.stringify([row.petId, row.cgId, row.variant]);
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['rows', index], message: 'Duplicate CG unlock identity' });
    keys.add(key);
  });
});
export type GalleryPage = z.infer<typeof galleryPageSchema>;

/** A favorite is a user preference on an existing, authoritative unlock. */
export const cgSetFavoritePayloadSchema = z.strictObject({
  ...unlockKeyFields,
  favorite: z.boolean(),
});
export type CgSetFavoritePayload = z.infer<typeof cgSetFavoritePayloadSchema>;

/** Marking the first view has no gameplay effect. Expected identity must match
 * the immutable acquisition reference; service supplies the viewed timestamp. */
export const cgMarkViewedPayloadSchema = z.strictObject({
  ...unlockKeyFields,
  characterId: galleryIdSchema,
  eventDefId: galleryIdSchema,
  assetVersion: packVersionSchema,
  assetHash: cgAssetHashSchema,
});
export type CgMarkViewedPayload = z.infer<typeof cgMarkViewedPayloadSchema>;
