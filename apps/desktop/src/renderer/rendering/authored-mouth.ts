import type { ResolvedPack, ResolvedPackVariant } from '../asset-packs/resolve-pack';

type Rect = readonly [number, number, number, number];
export interface AuthoredMouthPatch { readonly source: Rect; readonly destination: Rect; readonly level: number }

// These are the exact generated character sprite atlases and atlas descriptor.
// Their generator authors the face at (64,71), plus known per-clip bob/stride
// offsets. Never infer landmarks/crop a mouth from other character packs.
const ATLAS_DESCRIPTOR_HASH = '701f66b111a4d07dd616e86121bec5631176027e1d3e66f70c9717940ffdbc56';
const authored: Readonly<Record<string, string>> = {
  'star-singer:1.0.1': '332e062fa42e201514790222245b6bfac67659a467ec37b330c6187ecf113a3e',
  'fluffy-ranger:1.0.1': 'e0355da39251e955a9588bbe20b2c0c477b2a8dd615e34012f3407d0f598ff7e',
  'nova:1.0.0': 'b8ccfd4e59b575ed483b87708ac3c4b431f90dfc143ea1f4a3bbfcb0815d0c6c',
};
const yOffsets: Readonly<Record<string, readonly number[]>> = {
  idle: [0, -1, -3, -1], talk: [0, -1, -3, -1], walk: [0, -1, -3, -1],
  sleep: [1, 2, 3, 2], happy: [0, -4, -5, -3], 'tap.head': [0, 2, 3, 0],
};
const xWalk = [-2, 1, 2, -1];
const MOUTH_RECT = [59, 66, 10, 11] as const; // bounded authored face pixels, not a drawn generic 'O'

/** Five quantized mouth levels, including the genuine closed idle mouth.
 * Talk frame ordering follows the actual authored ellipse heights [0.9,2.6,
 * 4.1,1.8], not animation elapsed time or text length. */
function levelFor(open: number): number {
  if (open <= .025) return 0;
  if (open < .25) return 1;
  if (open < .5) return 2;
  if (open < .75) return 3;
  return 4;
}
const talkFrames = [0, 0, 3, 1, 2] as const;
function offset(clip: string, index: number): readonly [number, number] | null {
  const dy = yOffsets[clip]?.[index];
  if (dy === undefined) return null;
  return [clip === 'walk' ? xWalk[index]! : 0, dy];
}

/** Optional exact pack capability. Uses only a small patch of pixels from
 * the already verified same-character TALK/IDLE sprite, respecting the
 * currently drawn action's bob, facing, scale and full-frame hit geometry.
 * No Live2D rig or viseme mapping is claimed for these engineering assets. */
export function authoredMouthPatch(pack: ResolvedPack, variant: ResolvedPackVariant, clip: string, index: number, open: number): AuthoredMouthPatch | null {
  if (variant.renderer !== 'sprite' || variant.id !== 'sprite' || variant.entry !== 'assets/atlas.json' || variant.imagePath !== 'assets/atlas.png'
    || variant.imageSize.w !== 768 || variant.imageSize.h !== 512 || pack.manifest.logicalSize.w !== 128 || pack.manifest.logicalSize.h !== 128
    || !Number.isFinite(open) || open < 0 || open > 1) return null;
  const expected = authored[`${pack.manifest.characterId}:${pack.manifest.packVersion}`];
  if (!expected || pack.manifest.files.find(file => file.path === variant.imagePath)?.sha256 !== expected
    || pack.manifest.files.find(file => file.path === variant.entry)?.sha256 !== ATLAS_DESCRIPTOR_HASH) return null;
  const shift = offset(clip, index);
  if (!shift) return null;
  const level = levelFor(open), sourceClip = level === 0 ? 'idle' : 'talk', sourceIndex = talkFrames[level]!;
  const frame = variant.atlas.clips[sourceClip]?.frames[sourceIndex], sourceShift = offset(sourceClip, sourceIndex);
  if (!frame || !sourceShift || frame.rect[2] !== 128 || frame.rect[3] !== 128) return null;
  const [x, y, w, h] = MOUTH_RECT;
  const sx = frame.rect[0] + x + sourceShift[0], sy = frame.rect[1] + y + sourceShift[1];
  const dx = x + shift[0], dy = y + shift[1];
  if (dx < 0 || dy < 0 || dx + w > 128 || dy + h > 128 || sx < 0 || sy < 0 || sx + w > variant.imageSize.w || sy + h > variant.imageSize.h) return null;
  return { source: [sx, sy, w, h], destination: [dx, dy, w, h], level };
}
