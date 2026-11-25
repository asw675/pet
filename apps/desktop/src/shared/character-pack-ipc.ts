import { assetPathSchema, characterPackLimits, characterPackManifestSchema, packVersionSchema } from '@pet-desktop/contracts';
import { z } from 'zod';

export const builtinCharacterIds = ['star-singer', 'fluffy-ranger', 'nova'] as const;
export const builtinCharacterIdSchema = z.enum(builtinCharacterIds);
export type BuiltinCharacterId = z.infer<typeof builtinCharacterIdSchema>;

const builtinVersions: Readonly<Record<BuiltinCharacterId, string>> = {
  'star-singer': '1.1.0',
  'fluffy-ranger': '1.0.1',
  nova: '1.0.0',
};

export function builtinPackVersion(characterId: string): string | undefined {
  const id = builtinCharacterIdSchema.safeParse(characterId);
  return id.success ? builtinVersions[id.data] : undefined;
}

export function comparePackVersions(left: string, right: string): number {
  const l = left.split('.').map(Number), r = right.split('.').map(Number);
  return (l[0]! - r[0]!) || (l[1]! - r[1]!) || (l[2]! - r[2]!);
}

export const maxInstalledPackVersions = 64;
export const characterPackChangedSchema = z.strictObject({
  characterId: builtinCharacterIdSchema,
  packVersion: packVersionSchema,
});
export type CharacterPackChanged = z.infer<typeof characterPackChangedSchema>;

export const characterPackRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('import') }),
  characterPackChangedSchema.extend({ kind: z.literal('activate') }),
  z.strictObject({ kind: z.literal('read'), characterId: builtinCharacterIdSchema }),
]);
export type CharacterPackRequest = z.infer<typeof characterPackRequestSchema>;

const packRowSchema = z.strictObject({
  characterId: builtinCharacterIdSchema,
  builtinVersion: packVersionSchema,
  activeVersion: packVersionSchema,
  installedVersions: z.array(packVersionSchema).max(maxInstalledPackVersions),
});
export type CharacterPackRow = z.infer<typeof packRowSchema>;

const packBytes = z.custom<ArrayBuffer>(value => Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  && (value as ArrayBuffer).byteLength > 0 && (value as ArrayBuffer).byteLength <= characterPackLimits.fileBytes);
const packTransferSchema = z.strictObject({
  manifest: characterPackManifestSchema,
  assets: z.array(z.strictObject({ path: assetPathSchema, data: packBytes })).min(1).max(characterPackLimits.files),
}).superRefine(({ manifest, assets }, context) => {
  const declared = new Map(manifest.files.map(file => [file.path, file.bytes]));
  if (declared.size !== assets.length || assets.some(asset => {
    const size = declared.get(asset.path);
    declared.delete(asset.path);
    return size !== asset.data.byteLength;
  })) context.addIssue({ code: 'custom', message: 'Resource list does not match manifest' });
});
export type CharacterPackTransfer = z.infer<typeof packTransferSchema>;

export const characterPackResultSchema = z.union([
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['INVALID_REQUEST', 'FORBIDDEN', 'BUSY', 'CANCELLED', 'INVALID_PACK', 'UNSUPPORTED_PACK',
      'VERSION_CONFLICT', 'NOT_FOUND', 'STORAGE_ERROR', 'LIMIT_REACHED']),
  }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('list'), rows: z.array(packRowSchema).length(builtinCharacterIds.length) }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('change'), change: characterPackChangedSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('read'), pack: packTransferSchema.nullable() }),
]);
export type CharacterPackResult = z.infer<typeof characterPackResultSchema>;
export type CharacterPackFailure = Extract<CharacterPackResult, { ok: false }>['code'];

export function characterPackResultMatches(request: CharacterPackRequest, result: CharacterPackResult): boolean {
  if (!result.ok) return true;
  switch (request.kind) {
    case 'list':
      return result.kind === 'list' && new Set(result.rows.map(row => row.characterId)).size === builtinCharacterIds.length
        && result.rows.every(row => row.builtinVersion === builtinPackVersion(row.characterId)
          && (row.activeVersion === row.builtinVersion || row.installedVersions.includes(row.activeVersion)));
    case 'import':
      return result.kind === 'change';
    case 'activate':
      return result.kind === 'change' && result.change.characterId === request.characterId
        && result.change.packVersion === request.packVersion;
    case 'read':
      return result.kind === 'read' && (result.pack === null || result.pack.manifest.characterId === request.characterId);
  }
}
