import { z } from 'zod';

/** Resource format version is independent of IPC, game rules, and persistence. */
export const CHARACTER_PACK_SCHEMA_VERSION = 1 as const;

export const characterPackLimits = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  packBytes: 64 * 1024 * 1024,
  files: 256,
  textureEdge: 2048,
  clips: 64,
  framesPerClip: 256,
  totalFrames: 1024,
});

// IDs are stable, canonical keys; in particular, reject prototype members.
const assetIdSchema = z.string().regex(/^(?!(?:constructor|prototype)$)[a-z0-9][a-z0-9._-]{0,63}$/u);
export const packVersionSchema = z.string().regex(/^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/u)
  .refine((value) => value.split('.').every((part) => Number(part) <= 65535), 'Version components must not exceed 65535');

// Zod deliberately omits own __proto__ keys when parsing objects. At this
// resource boundary we reject the *input* instead of silently sanitizing it.
// The traversal is bounded and does not execute property getters.
function rejectPrototypeKeys(input: unknown): unknown {
  const pending = [input];
  const seen = new WeakSet<object>();
  let visits = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (++visits > 100_000) return null;
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return null;
      pending.push(descriptor.value);
    }
  }
  return input;
}

// Paths are canonical and portable across case-insensitive Windows file systems.
// Neither resource URLs nor arbitrary downloadable/executable formats are data paths.
// Reserved future model extensions do not imply an installed model adapter.
const resourceExtensions = new Set(['png', 'webp', 'json', 'moc3', 'vrm', 'skel', 'atlas']);
const deviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
export const assetPathSchema = z.string().min(8).max(240)
  .regex(/^assets\/(?:[a-z0-9][a-z0-9._-]{0,63}\/)*[a-z0-9][a-z0-9._-]{0,63}$/u)
  .refine((value) => {
    const parts = value.split('/');
    const filename = parts.at(-1);
    if (filename === undefined) return false;
    if (parts.some((part) => part.endsWith('.') || part.includes('..') || deviceName.test(part.split('.')[0] ?? ''))) return false;
    const extensionStart = filename.lastIndexOf('.');
    return extensionStart > 0 && resourceExtensions.has(filename.slice(extensionStart + 1));
  }, 'Asset path must use canonical, relative, portable assets/ data files');

const imagePathSchema = assetPathSchema.refine((value) => /\.(?:png|webp)$/u.test(value), 'Expected a PNG or WebP image');
const labelSchema = z.string().min(1).max(160).refine((value) => value.trim().length > 0, 'Text must not be blank');
const displayNameSchema = z.object({ 'zh-CN': labelSchema }).catchall(labelSchema).superRefine((names, context) => {
  const locales = Object.keys(names);
  if (locales.length > 16) context.addIssue({ code: 'custom', message: 'At most 16 localized names' });
  for (const locale of locales) {
    if (!/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-\d{3})?$/u.test(locale)) {
      context.addIssue({ code: 'custom', path: [locale], message: 'Invalid locale identifier' });
    }
  }
});

export const characterRendererSchema = z.enum(['sprite', 'static', 'cubism', 'vrm', 'spine']);
export type CharacterRenderer = z.infer<typeof characterRendererSchema>;

const variantSchema = z.strictObject({
  id: assetIdSchema,
  renderer: characterRendererSchema,
  entry: assetPathSchema,
}).superRefine((variant, context) => {
  const extensions: Record<CharacterRenderer, RegExp> = {
    sprite: /\.json$/u,
    static: /\.(?:png|webp)$/u,
    cubism: /\.model3\.json$/u,
    vrm: /\.vrm$/u,
    spine: /\.(?:json|skel)$/u,
  };
  if (!extensions[variant.renderer].test(variant.entry)) context.addIssue({
    code: 'custom', path: ['entry'], message: 'Variant entry must match its renderer format',
  });
});

const normalized = z.number().min(0).max(1);
const normalizedSize = z.number().gt(0).max(1);
const normalizedRectSchema = z.tuple([normalized, normalized, normalizedSize, normalizedSize])
  .refine(([x, y, w, h]) => x + w <= 1 && y + h <= 1, 'Hit region exceeds the normalized model bounds');
const textureDimensionSchema = z.number().int().min(1).max(characterPackLimits.textureEdge);
const dimensionsSchema = z.strictObject({ w: textureDimensionSchema, h: textureDimensionSchema });
const declaredFileSchema = z.strictObject({
  path: assetPathSchema,
  bytes: z.number().int().min(1).max(characterPackLimits.fileBytes),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
const actionVariantMapSchema = z.record(assetIdSchema, assetIdSchema).refine(
  (map) => Object.keys(map).length > 0 && Object.keys(map).length <= 8,
  'Each action maps to 1–8 variants',
);
const actionsSchema = z.record(assetIdSchema, actionVariantMapSchema).refine(
  (map) => Object.keys(map).length > 0 && Object.keys(map).length <= characterPackLimits.clips,
  'Action count exceeds the supported bounds',
);
const lipSyncSchema = z.record(assetIdSchema, z.strictObject({
  mode: z.literal('frames'),
  clips: z.tuple([assetIdSchema, assetIdSchema, assetIdSchema]).refine(
    (clips) => new Set(clips).size === 3, 'Lip-sync clip IDs must be distinct',
  ),
})).refine((map) => Object.keys(map).length <= 8, 'Too many lip-sync variants');

/** Declarative resource pack, not executable or a source of business-state truth. */
const manifestStructureSchema = z.strictObject({
  schemaVersion: z.literal(CHARACTER_PACK_SCHEMA_VERSION),
  characterId: assetIdSchema,
  packVersion: packVersionSchema,
  minAppVersion: packVersionSchema,
  displayName: displayNameSchema,
  thumbnail: imagePathSchema,
  variants: z.array(variantSchema).min(1).max(8),
  anchor: z.strictObject({ x: normalized, y: normalized }),
  logicalSize: dimensionsSchema,
  hitRegions: z.array(z.strictObject({ id: assetIdSchema, rect: normalizedRectSchema })).min(1).max(32),
  actions: actionsSchema,
  lipSync: lipSyncSchema.optional(),
  cgIds: z.array(assetIdSchema).max(256),
  license: z.strictObject({ owner: labelSchema, reference: labelSchema }),
  files: z.array(declaredFileSchema).min(1).max(characterPackLimits.files),
}).superRefine((manifest, context) => {
  const variants = new Map<string, z.infer<typeof variantSchema>>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    // Paths are already lowercase; normalize here as an additional invariant.
    const canonical = file.path.toLowerCase();
    if (paths.has(canonical)) context.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'Duplicate asset path' });
    paths.add(canonical);
    totalBytes += file.bytes;
  }
  if (totalBytes > characterPackLimits.packBytes) context.addIssue({ code: 'custom', path: ['files'], message: 'Pack byte budget exceeded' });
  if (!paths.has(manifest.thumbnail)) context.addIssue({ code: 'custom', path: ['thumbnail'], message: 'Thumbnail is not a declared file' });
  for (const [index, variant] of manifest.variants.entries()) {
    if (variants.has(variant.id)) context.addIssue({ code: 'custom', path: ['variants', index, 'id'], message: 'Duplicate variant ID' });
    variants.set(variant.id, variant);
    if (!paths.has(variant.entry)) context.addIssue({ code: 'custom', path: ['variants', index, 'entry'], message: 'Variant entry is not a declared file' });
    if (!Object.hasOwn(manifest.actions.idle ?? {}, variant.id)) context.addIssue({
      code: 'custom', path: ['actions', 'idle', variant.id], message: 'Every variant must provide an idle clip',
    });
  }
  for (const [semanticId, map] of Object.entries(manifest.actions)) {
    for (const [variantId, clip] of Object.entries(map)) {
      const variant = variants.get(variantId);
      if (variant === undefined) context.addIssue({ code: 'custom', path: ['actions', semanticId, variantId], message: 'Action refers to an unknown variant' });
      else if (variant.renderer === 'static' && clip !== 'idle') context.addIssue({
        code: 'custom', path: ['actions', semanticId, variantId], message: 'Static variant has only the idle clip',
      });
    }
  }
  for (const variantId of Object.keys(manifest.lipSync ?? {})) {
    if (variants.get(variantId)?.renderer !== 'sprite') context.addIssue({
      code: 'custom', path: ['lipSync', variantId], message: 'Frame lip-sync requires a known sprite variant',
    });
  }
  const regions = new Set<string>();
  for (const [index, region] of manifest.hitRegions.entries()) {
    if (regions.has(region.id)) context.addIssue({ code: 'custom', path: ['hitRegions', index, 'id'], message: 'Duplicate hit region ID' });
    regions.add(region.id);
  }
  if (new Set(manifest.cgIds).size !== manifest.cgIds.length) context.addIssue({ code: 'custom', path: ['cgIds'], message: 'Duplicate CG ID' });
});
export const characterPackManifestSchema = z.preprocess(rejectPrototypeKeys, manifestStructureSchema);
export type CharacterPackManifest = z.infer<typeof characterPackManifestSchema>;

const textureCoordinateSchema = z.number().int().min(0).max(characterPackLimits.textureEdge - 1);
const pixelRectSchema = z.tuple([textureCoordinateSchema, textureCoordinateSchema, textureDimensionSchema, textureDimensionSchema]);
const spriteFrameSchema = z.strictObject({
  rect: pixelRectSchema,
  durationMs: z.number().int().min(16).max(10_000),
});
const spriteClipSchema = z.strictObject({ frames: z.array(spriteFrameSchema).min(1).max(characterPackLimits.framesPerClip) });

/** V1 baseline atlas: one bounded image, equal-sized full frames, no trim/rotation. */
const atlasStructureSchema = z.strictObject({
  schemaVersion: z.literal(CHARACTER_PACK_SCHEMA_VERSION),
  image: imagePathSchema,
  size: dimensionsSchema,
  clips: z.record(assetIdSchema, spriteClipSchema).refine(
    (clips) => Object.keys(clips).length > 0 && Object.keys(clips).length <= characterPackLimits.clips,
    'Clip count exceeds the supported bounds',
  ),
}).superRefine((atlas, context) => {
  let count = 0;
  let frameDimensions: readonly [number, number] | undefined;
  for (const [clipId, clip] of Object.entries(atlas.clips)) {
    for (const [index, frame] of clip.frames.entries()) {
      count++;
      const [x, y, w, h] = frame.rect;
      if (x + w > atlas.size.w || y + h > atlas.size.h) context.addIssue({
        code: 'custom', path: ['clips', clipId, 'frames', index, 'rect'], message: 'Frame exceeds atlas bounds',
      });
      if (frameDimensions === undefined) frameDimensions = [w, h];
      else if (w !== frameDimensions[0] || h !== frameDimensions[1]) context.addIssue({
        code: 'custom', path: ['clips', clipId, 'frames', index, 'rect'], message: 'Untrimmed atlas frames must have equal dimensions',
      });
    }
  }
  if (count > characterPackLimits.totalFrames) context.addIssue({ code: 'custom', path: ['clips'], message: 'Total frame budget exceeded' });
});
export const spriteAtlasSchema = z.preprocess(rejectPrototypeKeys, atlasStructureSchema);
export type SpriteAtlas = z.infer<typeof spriteAtlasSchema>;

/** Cross-check already parsed atlas/manifest data before selecting a sprite variant.
 * The byte resolver independently verifies file sizes/digests and decoded images.
 */
export function validateSpriteAtlas(manifest: CharacterPackManifest, variantId: string, atlas: SpriteAtlas): void {
  const variant = manifest.variants.find((candidate) => candidate.id === variantId);
  if (variant?.renderer !== 'sprite') throw new Error('Unknown sprite variant');
  if (!manifest.files.some((file) => file.path === variant.entry)) throw new Error('Sprite variant entry is undeclared');
  if (!manifest.files.some((file) => file.path === atlas.image)) throw new Error('Atlas image is undeclared');
  for (const mappings of Object.values(manifest.actions)) {
    const clipId = mappings[variantId];
    if (clipId !== undefined && !Object.hasOwn(atlas.clips, clipId)) throw new Error(`Missing sprite action clip: ${clipId}`);
  }
  for (const clipId of manifest.lipSync?.[variantId]?.clips ?? []) {
    if (!Object.hasOwn(atlas.clips, clipId)) throw new Error(`Missing sprite lip-sync clip: ${clipId}`);
  }
}

/** JSON Schemas describe the structural contract; Zod refinements remain authoritative
 * for cross-file references, budgets, format semantics and coordinate sums. */
export function characterPackManifestJsonSchema() { return z.toJSONSchema(characterPackManifestSchema); }
export function spriteAtlasJsonSchema() { return z.toJSONSchema(spriteAtlasSchema); }
