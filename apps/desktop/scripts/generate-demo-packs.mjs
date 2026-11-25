/**
 * Deterministic original engineering-only anime chibi heroine sprites. Nothing here downloads art
 * or uses an image library. The installed application consumes only the PNGs
 * and validated JSON, never this generator.
 *
 * mise exec node@26.12.1 -- node scripts/generate-demo-packs.mjs
 * mise exec node@26.12.1 -- node scripts/generate-demo-packs.mjs --check
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
  skin: rgba('ffe5cf'), blush: rgba('ed8ba1', 180),
  demonHair: rgba('e17a98'), demonHairShade: rgba('a94d78'), demonHairShine: rgba('ffaac1'),
  horn: rgba('3d304d'), hornShine: rgba('80668b'), demonCloth: rgba('473752'), demonBlack: rgba('30263f'),
  demonAccent: rgba('a46ba1'), demonSkirt: rgba('726082'), azure: rgba('638ec8'), ice: rgba('b4ddf7'),
  rose: rgba('d779a7'), roseLight: rgba('ffc3dc'),
  copper: rgba('ac604e'), copperDark: rgba('844537'), copperShine: rgba('df956e'), cream: rgba('ffecc7'),
  pink: rgba('f6b5a4'), green: rgba('71977b'), vest: rgba('8eb08d'), brown: rgba('76523e'),
  leaf: rgba('76b383'), jade: rgba('588e78'), mint: rgba('aed9a7'), mouth: rgba('9c5d65'), shadow: rgba('2b203c', 48),
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

function face(draw, ink, iris, irisLight, clip, i, rightIris = iris, rightIrisLight = irisLight) {
  const eyesClosed = clip === 'sleep' || (clip === 'idle' && i === 3) ||
    (clip === 'happy' && i >= 1 && i <= 2) || (clip === 'tap.head' && i === 2);
  for (const x of [52, 76]) {
    const outer = x < 64 ? -1 : 1;
    draw.line(x - 5, 51, x + 3, 50.5, 1.35, ink);
    if (eyesClosed) {
      const mid = clip === 'happy' || clip === 'tap.head' ? 58 : 61.5;
      draw.line(x - 5, 60, x, mid, 2.1, ink);
      draw.line(x, mid, x + 5, 60, 2.1, ink);
      draw.line(x + outer * 4.5, 60, x + outer * 6.5, 58.1, 1.3, ink);
    } else {
      // Oversized almond-like eyes, layered irises and bright anime catchlights.
      draw.ellipse(x, 61, 6.6, 7.0, color.white, ink, 0.9);
      draw.ellipse(x + 0.25, 61, 4.7, 6.5, outer < 0 ? iris : rightIris, ink, 0.6);
      draw.ellipse(x + 0.4, 64.1, 3.6, 2.8, outer < 0 ? irisLight : rightIrisLight);
      draw.ellipse(x + 0.1, 60.0, 2.6, 3.8, ink);
      draw.line(x - 5.3, 55.2, x + 4.8, 55.2, 1.9, ink);
      draw.line(x + outer * 5, 55.5, x + outer * 7.0, 53.7, 1.6, ink);
      draw.ellipse(x - 1.6, 57.8, 1.85, 1.55, color.white);
      draw.ellipse(x + 2.3, 64.2, 0.8, 0.8, color.white);
    }
  }
  const rosy = clip === 'happy' || clip === 'tap.head';
  draw.ellipse(44, 70.5, rosy ? 5.4 : 4.5, 2.4, color.blush);
  draw.ellipse(84, 70.5, rosy ? 5.4 : 4.5, 2.4, color.blush);
  draw.ellipse(64, 66.5, 0.85, 0.75, color.blush);
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
  // Original fantasy demon heroine: very long rose-pink hair, a dark
  // tailored jacket and skirt, stockings / boots and human hands.
  draw.polygon([[30, 43], [39, 25], [53, 18], [75, 17], [91, 27], [99, 44], [97, 69], [105, 91],
    [111, 111], [103, 119], [94, 113], [91, 117], [86, 98], [75, 108], [50, 106], [42, 97],
    [36, 118], [29, 113], [20, 119], [16, 112], [23, 90], [31, 69]], color.demonHairShade, ink);
  draw.polygon([[29, 60], [37, 64], [38, 81], [31, 111], [24, 116], [21, 111], [26, 92]], color.demonHair);
  draw.polygon([[91, 64], [98, 61], [102, 88], [107, 111], [102, 116], [95, 111], [90, 82]], color.demonHair);
  draw.line(29, 77, 24, 108, 2, color.demonHairShine);
  draw.line(98, 76, 104, 108, 2, color.demonHairShine);

  draw.line(51 - stride, 105, 51 - stride, 118 + Math.max(0, -stride), 9, color.demonBlack);
  draw.line(77 + stride, 105, 77 + stride, 118 + Math.max(0, stride), 9, color.demonBlack);
  draw.line(49 - stride, 108, 49 - stride, 115 + Math.max(0, -stride), 2, color.hornShine);
  draw.line(75 + stride, 108, 75 + stride, 115 + Math.max(0, stride), 2, color.hornShine);
  draw.ellipse(50 - stride, 118 + Math.max(0, -stride), 10, 4.5, color.demonBlack, ink);
  draw.ellipse(78 + stride, 118 + Math.max(0, stride), 10, 4.5, color.demonBlack, ink);
  draw.polygon([[46, 96], [82, 96], [90, 112], [38, 112]], color.demonSkirt, ink);
  draw.line(47, 108, 81, 108, 1.1, color.demonAccent);
  draw.line(51, 102, 48, 110, 1.2, color.demonBlack);
  draw.line(77, 102, 80, 110, 1.2, color.demonBlack);
  draw.polygon([[47, 81], [58, 79], [70, 79], [81, 81], [84, 98], [44, 98]], color.demonBlack, ink);
  draw.polygon([[53, 81], [64, 87], [75, 81], [69, 96], [59, 96]], color.demonCloth, color.demonAccent, 1.2);
  draw.line(46, 98, 82, 98, 2.3, color.demonAccent);
  star(draw, 64, 92, 4.1, color.gold, color.demonBlack);
  draw.ellipse(38, 96, 6.5, 6.8, color.skin, ink);
  const lift = clip === 'happy' ? 9 : clip === 'walk' ? stride : 0;
  draw.ellipse(89, 95 - lift, 6.5, 6.8, color.skin, ink);

  // The horns are curved above the scalp, distinct from animal ears.
  const leftHorn = [[42, 40], [33, 37], [25, 29], [22, 20], [24, 13], [31, 8], [29, 17], [33, 24], [42, 28], [48, 33]];
  const rightHorn = leftHorn.map(([x, y]) => [128 - x, y]);
  draw.polygon(leftHorn, color.horn, ink);
  draw.polygon(rightHorn, color.horn, ink);
  draw.line(27, 19, 28, 25, 2, color.hornShine);
  draw.line(28, 25, 35, 32, 2, color.hornShine);
  draw.line(101, 19, 100, 25, 2, color.hornShine);
  draw.line(100, 25, 93, 32, 2, color.hornShine);

  draw.ellipse(64, 59, 36, 32, color.demonHairShade, ink);
  draw.ellipse(64, 63, 28, 25, color.skin, ink);
  draw.polygon([[35, 56], [37, 42], [49, 34], [64, 33], [80, 39], [93, 52], [88, 57],
    [76, 51], [69, 43], [63, 53], [57, 47], [47, 56]], color.demonHair);
  draw.polygon([[36, 52], [43, 54], [42, 69], [46, 84], [39, 94], [32, 74]], color.demonHair, ink, 0.9);
  draw.polygon([[88, 52], [92, 54], [94, 72], [91, 94], [82, 86], [87, 70]], color.demonHair, ink, 0.9);
  draw.line(39, 43, 50, 37, 2.0, color.demonHairShine);
  draw.line(50, 37, 61, 37.8, 2.0, color.demonHairShine);
  draw.line(36, 58, 37.8, 74, 1.8, color.demonHairShine);
  draw.line(89.5, 58, 90.5, 74, 1.8, color.demonHairShine);
  face(draw, ink, color.azure, color.ice, clip, i, color.rose, color.roseLight);
}

function drawRanger(draw, clip, i) {
  const ink = color.rangerInk;
  const stride = clip === 'walk' ? [3, -2, -3, 2][i] : 0;
  // Auburn hair extends from the human scalp behind both shoulders.
  // There are no ears, muzzle, paws, tail or other animal features.
  draw.polygon([[31, 39], [39, 26], [53, 18], [72, 17], [88, 27], [98, 42], [95, 64], [99, 84],
    [105, 103], [98, 113], [88, 108], [86, 91], [76, 102], [51, 102], [41, 92], [38, 111],
    [28, 113], [22, 103], [29, 81], [32, 65]], color.copperDark, ink);
  draw.polygon([[28, 68], [38, 70], [38, 91], [30, 108], [25, 103]], color.copper);
  draw.polygon([[90, 69], [97, 70], [99, 91], [102, 103], [96, 109], [89, 100]], color.copper);
  draw.line(31, 83, 29, 101, 1.8, color.copperShine);
  draw.line(96, 83, 99, 101, 1.8, color.copperShine);
  draw.line(49 - stride, 107, 49 - stride, 116 + Math.max(0, -stride), 7, color.skin);
  draw.line(79 + stride, 107, 79 + stride, 116 + Math.max(0, stride), 7, color.skin);
  draw.ellipse(49 - stride, 116 + Math.max(0, -stride), 10, 5, color.brown, ink);
  draw.ellipse(79 + stride, 116 + Math.max(0, stride), 10, 5, color.brown, ink);
  draw.line(45 - stride, 116 + Math.max(0, -stride), 51 - stride, 116 + Math.max(0, -stride), 1.2, color.gold);
  draw.line(75 + stride, 116 + Math.max(0, stride), 81 + stride, 116 + Math.max(0, stride), 1.2, color.gold);
  // Small forest capelet, blouse and pleated skirt with a travel belt.
  draw.polygon([[50, 79], [77, 79], [88, 95], [78, 97], [91, 113], [36, 113], [49, 97], [40, 95]], color.green, ink);
  draw.polygon([[53, 81], [63, 90], [75, 81], [78, 101], [50, 101]], color.cream, ink, 0.8);
  draw.polygon([[39, 109], [50, 95], [63, 101], [78, 95], [89, 109], [83, 111], [45, 111]], color.vest);
  draw.line(53, 104, 48, 110, 1.3, color.green);
  draw.line(76, 104, 81, 110, 1.3, color.green);
  draw.line(47, 100, 81, 100, 4.8, color.brown);
  draw.polygon([[61, 97], [68, 97], [68, 103], [61, 103]], color.gold);
  draw.polygon([[46, 83], [54, 81], [63, 86], [73, 81], [83, 83], [87, 91], [72, 89], [63, 93], [55, 89], [41, 91]], color.green, ink, 1.1);
  draw.polygon([[60, 89], [65, 84], [69, 88], [64, 92]], color.gold, color.brown, 1.0);
  const lift = clip === 'happy' ? 9 : clip === 'walk' ? stride : 0;
  draw.ellipse(35, 95 + stride, 6.5, 6, color.skin, ink);
  draw.ellipse(93, 95 - lift, 6.5, 6, color.skin, ink);
  draw.ellipse(64, 57, 36, 34, color.copperDark, ink);
  draw.ellipse(64, 63, 28, 25, color.skin, ink);
  // Rounded human hairline and swept long bangs, not pointed animal ears.
  draw.polygon([[35, 53], [38, 40], [46, 31], [57, 26], [73, 27], [86, 34], [93, 46], [90, 57],
    [79, 49], [72, 41], [67, 49], [58, 54], [48, 56], [45, 51], [40, 57]], color.copper, ink, 0.9);
  draw.polygon([[36, 53], [43, 56], [42, 74], [50, 86], [42, 94], [35, 86], [31, 70]], color.copper, ink, 0.9);
  draw.polygon([[89, 51], [94, 53], [96, 70], [91, 92], [83, 85], [88, 73]], color.copper, ink, 0.9);
  draw.line(44, 39, 53, 32, 2.2, color.copperShine);
  draw.line(53, 32, 64, 33, 2.2, color.copperShine);
  draw.line(37, 61, 37, 77, 1.5, color.copperShine);
  draw.line(91, 62, 92, 78, 1.5, color.copperShine);
  // Woodland hair ornament, asymmetric ribbon and leaf.
  draw.polygon([[82, 37], [91, 30], [96, 35], [90, 43], [84, 41]], color.leaf, ink, 1.1);
  draw.polygon([[83, 39], [90, 45], [87, 50], [82, 44]], color.gold, color.brown, 0.8);
  draw.line(85, 39, 92, 34, 1.1, color.white);
  face(draw, ink, color.jade, color.mint, clip, i);
}

function drawNova(draw, clip, i) {
  // Nova is an original humanoid mechanical assistant heroine. The cool
  // silver-blue silhouette, optical monocle and white/graphite tech blazer
  // distinguish her from the other two fantasy heroines. Keep this palette
  // local: older character versions must remain byte-for-byte identical.
  const ink = rgba('334f69');
  const shadowHair = rgba('819dbb');
  const silver = rgba('dce9f8');
  const whiteHair = rgba('eef5ff');
  const highlight = rgba('f8fcff');
  const ice = rgba('a2c9e3');
  const dark = rgba('394c64');
  const graphite = rgba('526982');
  const suit = rgba('ecf3f9');
  const trim = rgba('65bdd9');
  const cyan = rgba('70e5ef');
  const cyanLight = rgba('d1fcff');
  const iris = rgba('4ea8c8');
  const stride = clip === 'walk' ? [3, -2, -3, 2][i] : 0;
  const lift = clip === 'happy' ? 9 : clip === 'walk' ? stride : 0;

  // Shoulder-length angular hair behind the body, with a longer side lock.
  draw.polygon([[29, 43], [36, 27], [51, 19], [73, 18], [88, 25], [98, 42],
    [97, 69], [105, 89], [102, 105], [93, 109], [84, 99], [76, 104],
    [52, 102], [42, 94], [33, 103], [20, 107], [24, 89], [29, 69]], shadowHair, ink);
  draw.polygon([[29, 69], [38, 73], [38, 91], [29, 102], [24, 103], [27, 86]], silver);
  draw.polygon([[92, 66], [98, 73], [102, 91], [98, 103], [93, 104], [87, 88]], silver);
  draw.line(29, 80, 27, 97, 1.5, highlight);
  draw.line(95, 79, 98, 96, 1.6, highlight);

  // Human legs in articulated graphite boots; teal seam and pale toe plate.
  draw.line(49 - stride, 105, 49 - stride, 116 + Math.max(0, -stride), 9, dark);
  draw.line(79 + stride, 105, 79 + stride, 116 + Math.max(0, stride), 9, dark);
  draw.line(48 - stride, 108, 48 - stride, 115 + Math.max(0, -stride), 2, trim);
  draw.line(78 + stride, 108, 78 + stride, 115 + Math.max(0, stride), 2, trim);
  draw.ellipse(48 - stride, 117 + Math.max(0, -stride), 10, 4.5, dark, ink);
  draw.ellipse(80 + stride, 117 + Math.max(0, stride), 10, 4.5, dark, ink);
  draw.line(43 - stride, 117 + Math.max(0, -stride), 52 - stride, 117 + Math.max(0, -stride), 2.0, suit);
  draw.line(75 + stride, 117 + Math.max(0, stride), 84 + stride, 117 + Math.max(0, stride), 2.0, suit);

  // Tailored sci-fi skirt suit, layered panels, bright cyan piping and core.
  draw.polygon([[47, 96], [81, 96], [90, 111], [38, 111]], graphite, ink);
  draw.polygon([[46, 99], [57, 100], [53, 110], [39, 110]], suit, ink, 1);
  draw.polygon([[82, 99], [71, 100], [75, 110], [89, 110]], suit, ink, 1);
  draw.line(58, 103, 56, 110, 1.5, trim);
  draw.line(70, 103, 72, 110, 1.5, trim);
  draw.polygon([[48, 79], [80, 79], [88, 89], [81, 93], [84, 99], [44, 99],
    [47, 93], [40, 89]], suit, ink);
  draw.polygon([[53, 81], [64, 86], [75, 81], [77, 98], [51, 98]], dark, ink, 1);
  draw.polygon([[60, 83], [64, 88], [68, 83], [70, 93], [64, 98], [58, 93]], trim, ink, 0.9);
  draw.polygon([[64, 87], [68, 90], [64, 94], [60, 90]], cyanLight, cyan, 1);
  draw.line(46, 98, 82, 98, 2, trim);
  draw.polygon([[40, 88], [47, 89], [42, 101], [34, 99], [35, 92]], suit, ink, 1.2);
  draw.polygon([[88, 88 - lift], [82, 89 - lift], [85, 101 - lift], [93, 99 - lift],
    [94, 92 - lift]], suit, ink, 1.2);
  draw.ellipse(36, 101 + stride, 5.6, 4.8, color.skin, ink, 1);
  draw.ellipse(92, 101 - lift, 5.6, 4.8, color.skin, ink, 1);
  draw.line(34, 97 + stride, 41, 96 + stride, 2.1, trim);
  draw.line(89, 96 - lift, 95, 97 - lift, 2.1, trim);

  // Human anime face and asymmetrically layered white/silver fringe.
  draw.ellipse(64, 57, 36, 34, shadowHair, ink);
  draw.ellipse(64, 63, 28, 25, color.skin, ink);
  draw.polygon([[34, 57], [37, 40], [45, 31], [57, 26], [73, 26], [87, 33],
    [94, 47], [91, 57], [82, 50], [76, 40], [70, 48], [61, 52], [55, 44],
    [47, 55], [41, 58]], whiteHair, ink, 0.9);
  draw.polygon([[36, 50], [43, 56], [42, 68], [48, 80], [43, 96], [36, 91], [31, 71]],
    silver, ink, 0.9);
  draw.polygon([[89, 50], [95, 53], [96, 71], [90, 87], [84, 83], [88, 70]],
    silver, ink, 0.9);
  draw.line(42, 41, 55, 32, 2.4, highlight);
  draw.line(55, 32, 68, 33, 2.1, highlight);
  draw.line(78, 37, 86, 43, 1.7, ice);
  draw.line(35, 62, 37, 81, 1.8, highlight);
  draw.line(93, 62, 92, 77, 1.6, highlight);
  // Deliberately mechanical temple attachment and glowing optical monocle,
  // rather than animal ears or a generic futuristic accessory.
  face(draw, ink, iris, cyanLight, clip, i);
  draw.polygon([[90, 49], [100, 54], [102, 66], [94, 72], [88, 67], [89, 55]], dark, ink, 1.2);
  draw.polygon([[96, 55], [100, 59], [99, 65], [94, 67], [91, 62], [92, 57]], trim, ink, 0.7);
  draw.line(96, 58, 95, 64, 1.8, cyanLight);
  draw.line(90, 61, 86, 61, 2.3, dark);
  const optical = [[69, 53], [81, 53], [86, 57], [86, 65], [81, 69], [69, 69], [66, 65], [66, 57]];
  draw.polygon(optical, rgba('89dcf8', 50), iris, 1.35);
  draw.line(70, 53, 78, 53, 1.2, cyanLight);
  draw.line(81, 66, 84, 63, 1.1, cyanLight);
  draw.polygon([[47, 39], [53, 35], [56, 38], [50, 43]], dark, ink, 0.8);
  draw.line(49, 40, 54, 37, 1.2, cyan);
}

function renderFrame(characterId, clip, i) {
  const pixels = new Raster(SIZE, SIZE);
  const dx = clip === 'walk' ? [-2, 1, 2, -1][i] : 0;
  const dy = clip === 'sleep' ? [1, 2, 3, 2][i] :
    clip === 'happy' ? [0, -4, -5, -3][i] :
      clip === 'tap.head' ? [0, 2, 3, 0][i] : [0, -1, -3, -1][i];
  pixels.ellipse(64, 124, clip === 'happy' ? 30 : 37, 2.8, color.shadow);
  const draw = shapeAt(pixels, dx, dy);
  if (characterId === 'star-singer') drawStarSinger(draw, clip, i);
  else if (characterId === 'fluffy-ranger') drawRanger(draw, clip, i);
  else if (characterId === 'nova') drawNova(draw, clip, i);
  else throw new Error(`Unknown character fixture: ${characterId}`);
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
  // Clear all four cell borders (not just the corners) so full hair and
  // curved horns are never clipped or bleed into neighboring atlas cells.
  const alpha = (x, y) => pixels.data[(y * SIZE + x) * 4 + 3];
  for (let p = 0; p < SIZE; p += 1) {
    if (alpha(p, 0) || alpha(p, SIZE - 1) || alpha(0, p) || alpha(SIZE - 1, p)) {
      throw new Error(`Generated frame border must remain transparent: ${characterId}:${clip}:${i}`);
    }
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
function generatePack(characterId, name, packVersion) {
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
    packVersion,
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
for (const [characterId, name, packVersion] of [
  ['star-singer', '星咏', '1.0.1'],
  ['fluffy-ranger', '绒绒', '1.0.1'],
  ['nova', '诺瓦', '1.0.0'],
]) {
  const pack = generatePack(characterId, name, packVersion);
  for (const [relative, bytes] of pack) {
    const path = join(ROOT, characterId, relative);
    if (mode[0] === '--check' || existsSync(path)) {
      // Published-by-version fixtures are immutable. Never overwrite changed
      // content under an existing ID/version during a new character addition.
      if (!readFileSync(path).equals(bytes)) throw new Error(`Fixture drift: ${characterId}/${relative}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  console.log(`${characterId}: ${ACTIONS.length} clips, 24 frames, ${[...pack.values()].reduce((n, bytes) => n + bytes.length, 0)} bytes ${mode[0] === '--check' ? 'verified' : 'written'}`);
}
