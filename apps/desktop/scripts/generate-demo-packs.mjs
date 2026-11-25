/**
 * Deterministic original engineering-only sprites. Nothing here downloads art
 * or uses an image library. The installed application consumes only the PNGs
 * and validated JSON, never this generator.
 *
 * node scripts/generate-demo-packs.mjs          regenerate owned fixtures
 * node scripts/generate-demo-packs.mjs --check  verify byte-for-byte output
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const COLS = 6;
const ACTIONS = [
  { id: 'idle', durations: [420, 280, 420, 160] },
  { id: 'sleep', durations: [400, 400, 400, 400] },
  { id: 'happy', durations: [120, 140, 140, 200] },
  { id: 'tap.head', durations: [150, 150, 180, 220] },
  { id: 'talk', durations: [160, 120, 160, 120] },
  { id: 'walk', durations: [140, 140, 140, 140] },
];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/asset-packs/builtin');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function rgba(hex, alpha = 255) {
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16), alpha];
}

// Straight-alpha surface, bounded analytic shape rasterization with 4x
// subpixel coverage. No background is painted; corners remain transparent.
class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  blend(x, y, color, coverage) {
    const i = (y * this.w + x) * 4;
    const a = color[3] / 255 * coverage;
    const oldA = this.data[i + 3] / 255;
    const outA = a + oldA * (1 - a);
    if (!outA) return;
    for (let c = 0; c < 3; c += 1) {
      this.data[i + c] = Math.round((color[c] * a + this.data[i + c] * oldA * (1 - a)) / outA);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  paint(bounds, inside, color) {
    const [left, top, right, bottom] = bounds;
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(this.h, Math.ceil(bottom)); y += 1) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(this.w, Math.ceil(right)); x += 1) {
        let samples = 0;
        for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
          if (inside(x + dx, y + dy)) samples += 1;
        }
        if (samples) this.blend(x, y, color, samples / 4);
      }
    }
  }

  ellipse(cx, cy, rx, ry, color, outline, border = 1.5) {
    const paintEllipse = (xRadius, yRadius, c) => this.paint(
      [cx - xRadius, cy - yRadius, cx + xRadius, cy + yRadius],
      (x, y) => ((x - cx) / xRadius) ** 2 + ((y - cy) / yRadius) ** 2 <= 1, c,
    );
    if (outline) paintEllipse(rx + border, ry + border, outline);
    paintEllipse(rx, ry, color);
  }

  line(x0, y0, x1, y1, width, color) {
    const r = width / 2;
    const vx = x1 - x0;
    const vy = y1 - y0;
    const lengthSquared = vx * vx + vy * vy;
    this.paint([Math.min(x0, x1) - r, Math.min(y0, y1) - r,
      Math.max(x0, x1) + r, Math.max(y0, y1) + r], (x, y) => {
      const t = lengthSquared === 0 ? 0 :
        Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / lengthSquared));
      return (x - (x0 + vx * t)) ** 2 + (y - (y0 + vy * t)) ** 2 <= r * r;
    }, color);
  }

  polygon(points, color, outline, border = 2.5) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    this.paint([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], (x, y) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, color);
    if (outline) {
      for (let i = 0; i < points.length; i += 1) {
        const [x, y] = points[i];
        const [nextX, nextY] = points[(i + 1) % points.length];
        this.line(x, y, nextX, nextY, border, outline);
      }
    }
  }

  // Disjoint atlas cells can copy the RGBA bytes directly (no blending).
  copy(frame, x, y) {
    for (let row = 0; row < frame.h; row += 1) {
      const source = row * frame.w * 4;
      this.data.set(frame.data.subarray(source, source + frame.w * 4), ((y + row) * this.w + x) * 4);
    }
  }
}

const color = {
  ink: rgba('433451'), rangerInk: rgba('64483c'), white: rgba('fff9ee'), gold: rgba('ffe29a'),
  hair: rgba('b5a4ed'), hairShade: rgba('8d7ac8'), hat: rgba('7964b5'), cloth: rgba('baaaea'),
  robe: rgba('7563b0'), boot: rgba('554365'), skin: rgba('ffe5cf'), blush: rgba('ed8ba1', 180),
  orange: rgba('dfa36e'), orangeDark: rgba('bc7f50'), cream: rgba('ffecc7'),
  pink: rgba('f6b5a4'), green: rgba('71977b'), vest: rgba('8eb08d'), brown: rgba('76523e'),
  leaf: rgba('76b383'), mouth: rgba('9c5d65'), shadow: rgba('2b203c', 48),
  sparkle: rgba('ffd275'), heart: rgba('f3a0b8'),
};

function star(draw, x, y, r, fill = color.gold, outline) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const radius = i % 2 === 0 ? r : r * 0.44;
    return [x + Math.cos(a) * radius, y + Math.sin(a) * radius];
  });
  draw.polygon(points, fill, outline, 1.2);
}

function heart(draw, x, y, size) {
  draw.ellipse(x - size / 4, y - size / 8, size / 3, size / 3, color.heart);
  draw.ellipse(x + size / 4, y - size / 8, size / 3, size / 3, color.heart);
  draw.polygon([[x - size * 0.56, y], [x + size * 0.56, y], [x, y + size * 0.66]], color.heart);
}

function shapeAt(frame, dx, dy) {
  return {
    ellipse: (x, y, rx, ry, ...args) => frame.ellipse(x + dx, y + dy, rx, ry, ...args),
    polygon: (points, ...args) => frame.polygon(points.map(([x, y]) => [x + dx, y + dy]), ...args),
    line: (x0, y0, x1, y1, ...args) => frame.line(x0 + dx, y0 + dy, x1 + dx, y1 + dy, ...args),
  };
}

function face(draw, ink, clip, i) {
  const eyesClosed = clip === 'sleep' || (clip === 'idle' && i === 3) ||
    (clip === 'happy' && i >= 1 && i <= 2) || (clip === 'tap.head' && i === 2);
  for (const x of [52, 76]) {
    if (eyesClosed) {
      draw.line(x - 4, 61, x, 64, 2.3, ink);
      draw.line(x, 64, x + 4, 61, 2.3, ink);
    } else {
      draw.ellipse(x, 61, 3.4, 5.2, ink);
      draw.ellipse(x + 0.9, 58.9, 1.25, 1.25, color.white);
    }
  }
  const rosy = clip === 'happy' || clip === 'tap.head';
  draw.ellipse(45, 69, rosy ? 5.9 : 4.6, 2.5, color.blush);
  draw.ellipse(83, 69, rosy ? 5.9 : 4.6, 2.5, color.blush);
  if (clip === 'talk' || clip === 'happy') {
    const open = clip === 'happy' ? 3.2 : [0.9, 2.6, 4.1, 1.8][i];
    draw.ellipse(64, 71, 3.5, open, color.mouth);
    if (open > 2) draw.ellipse(64, 72.1, 2.1, 0.9, color.pink);
  } else {
    draw.line(61, 70, 64, 72, 1.7, color.mouth);
    draw.line(64, 72, 67, 70, 1.7, color.mouth);
  }
}

function drawStarSinger(draw, clip, i) {
  const ink = color.ink;
  const stride = clip === 'walk' ? [3, -2, -3, 2][i] : 0;
  draw.polygon([[45, 82], [80, 82], [98, 109], [87, 115], [41, 115], [30, 109]], color.robe, ink);
  draw.ellipse(50 - stride, 116 + Math.max(0, -stride), 10, 5, color.boot, ink);
  draw.ellipse(78 + stride, 116 + Math.max(0, stride), 10, 5, color.boot, ink);
  draw.polygon([[50, 82], [78, 82], [85, 111], [43, 111]], color.cloth, ink);
  draw.polygon([[64, 82], [53, 107], [75, 107]], color.cream);
  star(draw, 64, 92, 5.6);
  // Hands and wand stay distinguishable in the body region.
  draw.ellipse(38, 96, 6, 7, color.skin, ink);
  const lift = clip === 'happy' ? 9 : clip === 'walk' ? stride : 0;
  draw.ellipse(89, 95 - lift, 6, 7, color.skin, ink);
  draw.line(96, 98 - lift, 103, 74 - lift, 3.4, color.brown);
  star(draw, 104, 71 - lift, 8, color.gold, color.brown);
  // Hair silhouette, head and fringe.
  draw.ellipse(64, 59, 36, 32, color.hairShade, ink);
  draw.ellipse(64, 63, 28, 25, color.skin, ink);
  draw.polygon([[35, 56], [37, 42], [49, 34], [64, 33], [80, 39], [93, 52], [89, 58],
    [73, 50], [65, 43], [58, 52], [47, 58]], color.hair);
  draw.line(38, 57, 43, 76, 3.3, color.hairShade);
  draw.line(90, 57, 85, 76, 3.3, color.hairShade);
  face(draw, ink, clip, i);
  // Soft wizard hat brim and asymmetric point; gold star.
  draw.polygon([[25, 44], [40, 36], [49, 14], [69, 9], [84, 22], [89, 36], [103, 44],
    [91, 49], [64, 52], [38, 49]], color.hat, ink);
  draw.polygon([[39, 36], [88, 35], [94, 41], [64, 45], [34, 41]], color.cloth);
  star(draw, 65, 25, 8, color.gold, color.brown);
}

function drawRanger(draw, clip, i) {
  const ink = color.rangerInk;
  const stride = clip === 'walk' ? [3, -2, -3, 2][i] : 0;
  const tailY = clip === 'happy' ? 91 - i : 96 + stride;
  draw.ellipse(104, tailY + 5, 17, 11, color.orange, ink);
  draw.ellipse(114, tailY + 1, 8, 8, color.cream);
  draw.ellipse(49 - stride, 116 + Math.max(0, -stride), 10, 5, color.brown, ink);
  draw.ellipse(79 + stride, 116 + Math.max(0, stride), 10, 5, color.brown, ink);
  draw.polygon([[48, 82], [80, 82], [91, 112], [36, 112]], color.green, ink);
  draw.polygon([[52, 83], [62, 105], [76, 83], [80, 109], [48, 109]], color.cream);
  draw.line(47, 99, 81, 99, 4.8, color.brown);
  draw.polygon([[61, 96], [67, 96], [67, 102], [61, 102]], color.gold);
  const lift = clip === 'happy' ? 9 : clip === 'walk' ? stride : 0;
  draw.ellipse(33, 95 + stride, 7, 6, color.cream, ink);
  draw.ellipse(94, 95 - lift, 7, 6, color.cream, ink);
  // Triangular ears, cream inner fur, and face.
  draw.polygon([[34, 45], [27, 10], [49, 22], [59, 43]], color.orange, ink);
  draw.polygon([[94, 45], [101, 10], [79, 22], [69, 43]], color.orange, ink);
  draw.polygon([[33, 18], [45, 28], [42, 40]], color.pink);
  draw.polygon([[95, 18], [83, 28], [86, 40]], color.pink);
  draw.ellipse(64, 57, 36, 33, color.orange, ink);
  draw.ellipse(64, 63, 28, 25, color.cream, ink);
  draw.polygon([[36, 56], [42, 34], [59, 31], [80, 36], [91, 51], [85, 54],
    [74, 48], [71, 42], [60, 51], [49, 58]], color.orange);
  draw.line(47, 37, 59, 34, 2.9, color.cream);
  draw.polygon([[79, 35], [92, 27], [97, 34], [87, 41]], color.leaf, ink, 1.3);
  draw.line(85, 36, 92, 31, 1.2, color.white);
  face(draw, ink, clip, i);
}

function renderFrame(characterId, clip, i) {
  const pixels = new Raster(SIZE, SIZE);
  const dx = clip === 'walk' ? [-2, 1, 2, -1][i] : 0;
  const dy = clip === 'sleep' ? [2, 3, 4, 3][i] :
    clip === 'happy' ? [0, -6, -9, -3][i] :
      clip === 'tap.head' ? [0, 2, 3, 0][i] : [0, -1, -3, -1][i];
  pixels.ellipse(64, 124, clip === 'happy' ? 30 : 37, 2.8, color.shadow);
  const draw = shapeAt(pixels, dx, dy);
  if (characterId === 'star-singer') drawStarSinger(draw, clip, i);
  else drawRanger(draw, clip, i);
  // Clearly visible action-specific accents; no text or external font asset.
  if (clip === 'happy') {
    star(pixels, 15, 24 - i * 2, 4 + i, color.sparkle);
    star(pixels, 113, 34 - i * 3, 6 + i / 2, color.sparkle);
  } else if (clip === 'tap.head') {
    heart(pixels, 16 + i * 2, 30 - i * 4, 8 + i);
    heart(pixels, 110, 14 + i, 7);
  } else if (clip === 'sleep') {
    for (let n = 0; n < 2; n += 1) {
      const x = 99 + n * 11;
      const y = 25 - n * 12 - i;
      const s = 5 + n;
      pixels.line(x, y, x + s, y, 1.8, color.gold);
      pixels.line(x + s, y, x, y + s, 1.8, color.gold);
      pixels.line(x, y + s, x + s, y + s, 1.8, color.gold);
    }
  }
  if (pixels.data[3] !== 0 || pixels.data[(SIZE * SIZE - 1) * 4 + 3] !== 0) {
    throw new Error('Generated frame corners must remain transparent.');
  }
  return pixels;
}

// PNG RGBA8 (color type 6), filter 0, non-interlaced. Each row is preceded by
// its filter byte. CRC32 is computed over type + data for standards compliance.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let bit = 0; bit < 8; bit += 1) v = (v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1);
  return v >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const contents = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, crc]);
}
function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.w, 0);
  header.writeUInt32BE(image.h, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rowBytes = image.w * 4;
  const filtered = Buffer.alloc((rowBytes + 1) * image.h);
  for (let y = 0; y < image.h; y += 1) {
    filtered.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
function generatePack(characterId, name) {
  const clips = {};
  const actions = {};
  const atlas = new Raster(COLS * SIZE, Math.ceil(ACTIONS.length * 4 / COLS) * SIZE);
  let firstFrame;
  let cell = 0;
  for (const action of ACTIONS) {
    const frames = [];
    const hashes = new Set();
    for (let i = 0; i < action.durations.length; i += 1) {
      const frame = renderFrame(characterId, action.id, i);
      firstFrame ??= frame;
      const x = cell % COLS * SIZE;
      const y = Math.floor(cell / COLS) * SIZE;
      atlas.copy(frame, x, y);
      frames.push({ rect: [x, y, SIZE, SIZE], durationMs: action.durations[i] });
      hashes.add(sha256(frame.data));
      cell += 1;
    }
    if (hashes.size < 3) throw new Error(`${characterId}:${action.id} does not animate.`);
    clips[action.id] = { frames };
    actions[action.id] = action.id === 'idle' ?
      { sprite: 'idle', still: 'idle' } : { sprite: action.id };
  }
  const idlePng = encodePng(firstFrame);
  const assets = new Map([
    ['assets/atlas.png', encodePng(atlas)],
    ['assets/atlas.json', json({ schemaVersion: 1, image: 'assets/atlas.png',
      size: { w: atlas.w, h: atlas.h }, clips })],
    ['assets/idle.png', idlePng],
    ['assets/thumbnail.png', idlePng],
  ]);
  const manifest = {
    schemaVersion: 1,
    characterId,
    packVersion: '1.0.0',
    minAppVersion: '0.0.0',
    displayName: { 'zh-CN': name },
    thumbnail: 'assets/thumbnail.png',
    variants: [
      { id: 'sprite', renderer: 'sprite', entry: 'assets/atlas.json' },
      { id: 'still', renderer: 'static', entry: 'assets/idle.png' },
    ],
    anchor: { x: 0.5, y: 1 },
    logicalSize: { w: SIZE, h: SIZE },
    // Fixed, conservative, normalized rectangular regions within the
    // character's stable silhouette; not a claim of per-pixel alpha matching.
    hitRegions: [
      { id: 'head', rect: [0.30, 0.35, 0.40, 0.24] },
      { id: 'body', rect: [0.35, 0.67, 0.30, 0.20] },
    ],
    actions,
    cgIds: [],
    // This marker identifies the project-created test fixture, not a legal
    // conclusion about release/commercial asset redistribution.
    license: { owner: 'Pet Desktop', reference: 'original-poc-fixture' },
    files: [...assets.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  assets.set('manifest.json', json(manifest));
  return assets;
}

const mode = process.argv.slice(2);
if (mode.length > 1 || (mode.length === 1 && mode[0] !== '--check')) {
  throw new Error('Usage: node scripts/generate-demo-packs.mjs [--check]');
}
for (const [characterId, name] of [['star-singer', '星咏'], ['fluffy-ranger', '绒绒']]) {
  const pack = generatePack(characterId, name);
  for (const [relative, bytes] of pack) {
    const path = join(ROOT, characterId, relative);
    if (mode[0] === '--check') {
      if (!readFileSync(path).equals(bytes)) throw new Error(`Fixture drift: ${characterId}/${relative}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  console.log(`${characterId}: ${ACTIONS.length} clips, 24 frames, ${[...pack.values()].reduce((n, bytes) => n + bytes.length, 0)} bytes ${mode[0] === '--check' ? 'verified' : 'written'}`);
}
