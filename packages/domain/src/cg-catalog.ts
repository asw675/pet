/** Trusted, versioned CG content metadata. This catalog is not an unlock store. */
export interface CgAssetFile {
  readonly bytes: number;
  readonly sha256: string;
}

export type CgRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';

export interface CgCatalogEntry {
  readonly characterId: string;
  readonly cgId: string;
  readonly variant: string;
  readonly routeId: string;
  readonly eventDefId: string;
  readonly assetVersion: string;
  readonly rarity: CgRarity;
  readonly title: string;
  readonly hint: string;
  readonly caption: string;
  readonly license: { readonly owner: string; readonly reference: string };
  readonly image: CgAssetFile;
  readonly thumbnail: CgAssetFile;
  readonly assetHash: string;
}

export type CgAssetDescriptor = Omit<CgCatalogEntry, 'assetHash'>;

/**
 * Asset identity algorithm v1: lowercase SHA-256 hex over the UTF-8 bytes
 * of this exact compact JSON serialization (ordered keys below, no trailing
 * newline). Both files' byte counts and digests, all identity and content
 * fields, title/caption/hint, rarity, and license are covered. assetHash
 * itself and environment-dependent file paths are deliberately excluded.
 * Keep this ordering unchanged for existing history/pins.
 */
export function serializeCgAssetDescriptor(entry: CgAssetDescriptor): string {
  return JSON.stringify({
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
}

function freezeEntry(entry: CgCatalogEntry): CgCatalogEntry {
  return Object.freeze({
    ...entry,
    license: Object.freeze({ ...entry.license }),
    image: Object.freeze({ ...entry.image }),
    thumbnail: Object.freeze({ ...entry.thumbnail }),
  });
}

/**
 * Bundled, project-original engineering CGs. The asset versions are immutable:
 * new art, metadata or rights changes must receive a new assetVersion rather
 * than silently replace previously unlocked/pinned content. No gameplay
 * unlock, reward, favorite or view state is stored here.
 */
export const BUILTIN_CG_CATALOG: readonly CgCatalogEntry[] = Object.freeze([
  freezeEntry({
    characterId: 'star-singer',
    cgId: 'morning-dew',
    variant: 'default',
    routeId: 'morning-dew-meadow',
    eventDefId: 'dew-postcard',
    assetVersion: '1.0.0',
    rarity: 'COMMON',
    title: '晨露星辉',
    hint: '清晨的草地上，或许藏着一份温柔的旅途纪念。',
    caption: '第一缕阳光穿过林梢，星咏停在晨露闪烁的花丛旁。绯色长发与微光相映，她将这个宁静的清晨留在旅行明信片上。',
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    image: { bytes: 159647, sha256: 'd818c4e0c5fd92bbc6587bf4304ec71b66801e36c5da4736c14555c739a49943' },
    thumbnail: { bytes: 44850, sha256: 'b506bc7c5b0c306a1d731783aa55afd4ede1031f8e9fbd74756b88754b0fbdb9' },
    assetHash: 'f8fa4c3384d52b707fa8c3f4f63b55e781d541ec207eb521b32a8b79ce713719',
  }),
  freezeEntry({
    characterId: 'fluffy-ranger',
    cgId: 'morning-dew',
    variant: 'default',
    routeId: 'morning-dew-meadow',
    eventDefId: 'dew-postcard',
    assetVersion: '1.0.0',
    rarity: 'COMMON',
    title: '林间晨风',
    hint: '追随轻柔的晨风，或许会遇到值得记住的风景。',
    caption: '沿着晨露闪闪的溪岸，绒绒遇见了一场柔和的清晨。她在草木之间露出笑容，一片清亮的光落在游侠的衣摆上。',
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    image: { bytes: 148316, sha256: '2f4c1ccec26736f6fa90bd14a97c5a93bee42498bdcc015071708aa42fe86177' },
    thumbnail: { bytes: 44225, sha256: '0cc78c30bd29077fba9116dbe33cf5510ea703a68119fa589f7ed2ae86abefae' },
    assetHash: 'e60e00265fae34a3e3b2685962e802cfc73f0bf4520e31ab0b197a8d010049fd',
  }),
]);

function newer(left: string, right: string): boolean {
  const l = left.split('.').map(Number);
  const r = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (l[i] ?? 0) - (r[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Resolve latest only when no version was supplied. A previously pinned
 * version always resolves exactly or fails; never redirect old history to
 * whatever is newest.
 */
export function findBuiltinCg(
  characterId: string, cgId: string, variant = 'default', assetVersion?: string,
): CgCatalogEntry | undefined {
  let latest: CgCatalogEntry | undefined;
  for (const entry of BUILTIN_CG_CATALOG) {
    if (entry.characterId !== characterId || entry.cgId !== cgId || entry.variant !== variant) continue;
    if (assetVersion !== undefined) {
      if (entry.assetVersion === assetVersion) return entry;
    } else if (!latest || newer(entry.assetVersion, latest.assetVersion)) {
      latest = entry;
    }
  }
  return latest;
}
