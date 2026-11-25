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
  readonly routeId: string | null;
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

function freezeEntry<T extends CgCatalogEntry>(entry: T): T {
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
export const BUILTIN_CG_CATALOG: readonly (CgCatalogEntry & { readonly routeId: string })[] = Object.freeze([
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

/** New personal-story assets are authored separately. Service/gallery
 * integration must use the source EVENT; old trip pins remain unchanged. */
export const EVENT_CG_CATALOG: readonly CgCatalogEntry[] = Object.freeze([
  freezeEntry({
    characterId: 'star-singer', cgId: 'star-singer.shared-constellation', variant: 'default', routeId: null,
    eventDefId: 'star-singer.shared-constellation', assetVersion: '1.0.0', rarity: 'RARE',
    title: '只属于我们的星座', hint: '一起写过星光笔记后，星咏或许会与你绘制新的星图。',
    caption: '月色洒进窗边，星咏在发光的星图旁把两颗星连成独特的记号。这是你们共同记录的一段回忆。',
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    image: { bytes: 83192, sha256: 'a9da709e3ba7608a4f7ea56544976bde2fee895e39b9d25679a7fbc2481c0653' },
    thumbnail: { bytes: 22678, sha256: 'fb5b92f45a2283913018b2d4314839a3510f8ce60dcb5af8044259cb267288c6' },
    assetHash: '20f15143d474fbda1db5acec6f277ba8f6a4581771a0afdef511a634ce2fe021',
  }),
  freezeEntry({
    characterId: 'fluffy-ranger', cgId: 'fluffy-ranger.meadow-homecoming', variant: 'default', routeId: 'morning-dew-meadow',
    eventDefId: 'fluffy-ranger.meadow-homecoming', assetVersion: '1.0.0', rarity: 'COMMON',
    title: '归家暖意', hint: '绒绒从晨露草原归来时，或许会分享一段特别的旅行见闻。',
    caption: '炉边灯火温暖，绒绒把旅行收集的花草摆在桌旁，坐下来慢慢讲述草地上的见闻。',
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    image: { bytes: 70089, sha256: '76aa8809834e13465ebde6f0217f3abeb6201dbbee9fe1d851042593ee258121' },
    thumbnail: { bytes: 21252, sha256: '2113951b43b4055f538c05dfc89d85f03d3bb23ace1a0968ee1ff201dc40819a' },
    assetHash: 'c133d4b622db732ccfeaa34648c9b3de0ff83986634c0345ac07ee7e8f2a3051',
  }),
]);

export function findBuiltinEventCg(characterId: string, cgId: string, variant = 'default', assetVersion?: string): CgCatalogEntry | undefined {
  let latest: CgCatalogEntry | undefined;
  for (const entry of EVENT_CG_CATALOG) {
    if (entry.characterId !== characterId || entry.cgId !== cgId || entry.variant !== variant) continue;
    if (assetVersion !== undefined) { if (entry.assetVersion === assetVersion) return entry; }
    else if (!latest || newer(entry.assetVersion, latest.assetVersion)) latest = entry;
  }
  return latest;
}

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
