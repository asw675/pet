/**
 * Original, SD/anime-heroine engineering CG compositions. The only input art
 * is this repository's own versioned character atlas (1.0.1). The backdrops
 * are procedural; no network, user reference image, third-party illustration,
 * external font, native image library, or executable runtime content.
 *
 * mise exec node@26.12.1 -- node scripts/generate-demo-cg.mjs --check
 *
 * Existing catalog metadata pins both PNGs. Regeneration will not change
 * those pins or silently publish different bytes under an existing version.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { BUILTIN_CG_CATALOG, EVENT_CG_CATALOG, serializeCgAssetDescriptor } from '@pet-desktop/domain/cg-catalog';

const SCRIPT = dirname(fileURLToPath(import.meta.url));
const ART_ROOT = join(SCRIPT, '../src/renderer/asset-packs/builtin');
const CG_ROOT = join(SCRIPT, '../src/renderer/cg-assets/builtin');
const W = 768;
const H = 432;
const SPRITE_VERSION = '1.0.1';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const hex = (s, a = 255) => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), a];
const mixColor = (a, b, t) => a.map((v, i) => Math.round(mix(v, b[i], t)));

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  pixel(x, y, color, coverage = 1) {
    const i = (y * this.w + x) * 4;
    const a = clamp(color[3] / 255 * coverage, 0, 1);
    for (let c = 0; c < 3; c += 1) this.data[i + c] = Math.round(mix(this.data[i + c], color[c], a));
    this.data[i + 3] = 255; // fully opaque CG backdrop
  }

  paint(bounds, test, color) {
    const [l, t, r, b] = bounds;
    for (let y = Math.max(0, Math.floor(t)); y < Math.min(this.h, Math.ceil(b)); y += 1) {
      for (let x = Math.max(0, Math.floor(l)); x < Math.min(this.w, Math.ceil(r)); x += 1) {
        let inside = 0;
        for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
          if (test(x + dx, y + dy)) inside += 1;
        }
        if (inside) this.pixel(x, y, color, inside / 4);
      }
    }
  }

  ellipse(cx, cy, rx, ry, fill) {
    if (rx <= 0 || ry <= 0) return;
    this.paint([cx - rx, cy - ry, cx + rx, cy + ry],
      (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, fill);
  }

  line(x1, y1, x2, y2, width, fill) {
    const r = width / 2;
    const dx = x2 - x1; const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    this.paint([Math.min(x1, x2) - r, Math.min(y1, y2) - r,
      Math.max(x1, x2) + r, Math.max(y1, y2) + r], (x, y) => {
      const t = len2 ? clamp(((x - x1) * dx + (y - y1) * dy) / len2, 0, 1) : 0;
      return (x - x1 - dx * t) ** 2 + (y - y1 - dy * t) ** 2 <= r * r;
    }, fill);
  }

  poly(points, fill) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    this.paint([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], (x, y) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]; const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, fill);
  }

  /** Bilinear premultiplied sampling avoids black fringes at transparent hair. */
  sprite(sprite, sx, sy, sw, sh, dx, dy, dw, dh) {
    for (let y = Math.max(0, Math.floor(dy)); y < Math.min(this.h, Math.ceil(dy + dh)); y += 1) {
      for (let x = Math.max(0, Math.floor(dx)); x < Math.min(this.w, Math.ceil(dx + dw)); x += 1) {
        const u = clamp((x + 0.5 - dx) * sw / dw - 0.5, 0, sw - 1);
        const v = clamp((y + 0.5 - dy) * sh / dh - 0.5, 0, sh - 1);
        const ux = Math.floor(u); const vy = Math.floor(v);
        let a = 0;
        const c = [0, 0, 0];
        for (const [ix, wx] of [[ux, 1 - (u - ux)], [Math.min(ux + 1, sw - 1), u - ux]]) {
          for (const [iy, wy] of [[vy, 1 - (v - vy)], [Math.min(vy + 1, sh - 1), v - vy]]) {
            const index = ((sy + iy) * sprite.w + sx + ix) * 4;
            const alpha = sprite.data[index + 3] / 255 * wx * wy;
            a += alpha;
            for (let k = 0; k < 3; k += 1) c[k] += sprite.data[index + k] * alpha;
          }
        }
        if (a > 0) this.pixel(x, y, [...c.map((channel) => channel / a), a * 255]);
      }
    }
  }
}

function star(draw, x, y, r, color) {
  draw.poly([[x, y - r], [x + r / 4, y - r / 4], [x + r, y], [x + r / 4, y + r / 4],
    [x, y + r], [x - r / 4, y + r / 4], [x - r, y], [x - r / 4, y - r / 4]], color);
}

function flower(draw, x, y, scale, petals, stem) {
  const h = 9 * scale;
  draw.line(x, y + h, x - 1 * scale, y, Math.max(0.7, scale), stem);
  draw.poly([[x - scale, y + h * 0.63], [x - 5 * scale, y + h * 0.33],
    [x - 2 * scale, y + h * 0.12]], stem);
  for (let i = 0; i < 5; i += 1) {
    const a = i * Math.PI * 2 / 5;
    draw.ellipse(x + Math.cos(a) * 2.5 * scale, y + Math.sin(a) * 2.5 * scale,
      2.0 * scale, 1.9 * scale, petals);
  }
  draw.ellipse(x, y, 1.5 * scale, 1.5 * scale, hex('eac86c'));
}

function dew(draw, x, y, s) {
  draw.ellipse(x, y + s * 0.28, s * 0.62, s * 0.8, hex('d6faf4', 105));
  draw.ellipse(x - s * 0.22, y - s * 0.07, s * 0.23, s * 0.3, hex('fffdf0', 220));
  if (s > 1.8) star(draw, x, y, s * 1.7, hex('eefeea', 135));
}

function tree(draw, x, root, height, width, palette, rnd) {
  const top = root - height;
  const bend = (rnd() - 0.5) * width * 0.55;
  draw.poly([[x - width * 0.9, root], [x - width * 0.4, top + height * 0.42],
    [x + bend, top + height * 0.1], [x + width * 0.3, top + height * 0.36],
    [x + width * 0.52, root]], palette.trunk);
  draw.line(x - width * 0.23, root - height * 0.12, x + bend, top + height * 0.3,
    width * 0.15, palette.bark);
  for (const dir of [-1, 1]) {
    draw.line(x, top + height * 0.52, x + dir * height * 0.21, top + height * 0.18,
      width * 0.24, palette.trunk);
  }
  // Overlapping, asymmetrical crowns instead of uniform circular trees.
  for (let i = 0; i < 9; i += 1) {
    const cx = x + (rnd() - 0.5) * height * 0.56;
    const cy = top + rnd() * height * 0.22;
    const r = height * (0.11 + rnd() * 0.12);
    draw.ellipse(cx, cy, r * 1.23, r, i < 6 ? palette.foliage : palette.light);
  }
}

function ribbon(draw, center, width, start, finish, fill) {
  const left = [];
  const right = [];
  for (let y = start; y < finish; y += 8) {
    left.push([center(y) - width(y) / 2, y]);
    right.push([center(y) + width(y) / 2, y]);
  }
  left.push([center(finish) - width(finish) / 2, finish]);
  right.push([center(finish) + width(finish) / 2, finish]);
  draw.poly([...left, ...right.reverse()], fill);
}

function renderScene(entry, sprite, spriteRect) {
  const demon = entry.characterId === 'star-singer';
  const rnd = random(demon ? 0x6d21e105 : 0x15a83277);
  const draw = new Canvas(W, H);
  const sunX = demon ? 540 : 174;
  const sunY = demon ? 85 : 74;
  const top = hex(demon ? 'a7a9e1' : '80cad7');
  const horizon = hex(demon ? 'ffe5bd' : 'fff0c6');
  const glow = hex('fff8d3');
  // A soft, dawn-colored sky with a localized luminous opening.
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const base = mixColor(top, horizon, smooth(clamp(y / 235, 0, 1)));
    const light = Math.max(0, 1 - Math.hypot((x - sunX) / 270, (y - sunY) / 210)) ** 2 * 0.83;
    draw.pixel(x, y, mixColor(base, glow, light));
  }
  draw.ellipse(sunX, sunY, 35, 35, hex('fff9df', 65));
  draw.ellipse(sunX, sunY, 21, 21, hex('fffde5', 230));
  // Hazy ridges, distant trunks and leaf-colored canopies give the CG depth.
  draw.poly([[0, 197], [85, 159], [146, 173], [215, 142], [287, 168], [348, 153],
    [420, 179], [486, 162], [562, 180], [637, 146], [W, 174], [W, H], [0, H]], hex(demon ? '9faeb1' : '99beb6'));
  draw.poly([[0, 210], [97, 183], [180, 199], [278, 176], [382, 201], [500, 183],
    [614, 200], [W, 181], [W, H], [0, H]], hex('84ae9d'));
  const far = { trunk: hex('9aafac'), bark: hex('b4c1b4'), foliage: hex('a5c0b1'), light: hex('c0cfaf') };
  for (let i = 0; i < 17; i += 1) {
    const x = i * 49 + rnd() * 23 - 10;
    tree(draw, x, 229 + rnd() * 9, 75 + rnd() * 46, 4 + rnd() * 4, far, rnd);
  }
  const mid = { trunk: hex(demon ? '77858e' : '688d83'), bark: hex('94a8a0'),
    foliage: hex(demon ? '739d93' : '6da68a'), light: hex('a6c49d') };
  for (const x of [-8, 52, 118, 182, 596, 665, 722, 774]) {
    tree(draw, x, 260 + rnd() * 25, 196 + rnd() * 42, 12 + rnd() * 14, mid, rnd);
  }

  // Flowing meadow ridgeline, with a warm sunlit clearing and soft shadowing.
  const edge = (x) => 219 + Math.sin(x / 136 + (demon ? 0.4 : 1.6)) * 12 + Math.sin(x / 62) * 4;
  for (let y = 193; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (y < edge(x)) continue;
    const depth = clamp((y - 220) / 212, 0, 1);
    const sunny = mixColor(hex(demon ? 'c5d899' : 'c9df97'), hex(demon ? '80aa78' : '75b17d'), depth);
    const shady = mixColor(hex('97b48b'), hex(demon ? '577c76' : '467e70'), depth);
    const clearing = clamp(1 - Math.abs(x - sunX) / 465, 0, 1);
    draw.pixel(x, y, mixColor(shady, sunny, clearing));
  }

  const center = demon
    ? (y) => 313 - (y - 218) * 0.62 - Math.sin((y - 218) / 72) * 36
    : (y) => 463 + (y - 218) * 0.74 + Math.sin((y - 218) / 71) * 27;
  const width = (y) => 5 + (y - 218) * (demon ? 0.74 : 0.57);
  if (demon) {
    ribbon(draw, center, (y) => width(y) + 14, 218, H + 5, hex('8cae7e'));
    ribbon(draw, center, width, 218, H + 5, hex('d0bd91'));
    ribbon(draw, (y) => center(y) + width(y) * 0.08, (y) => width(y) * 0.73, 218, H + 5, hex('ead6aa'));
  } else {
    ribbon(draw, center, (y) => width(y) + 16, 218, H + 5, hex('7caa8f'));
    ribbon(draw, center, width, 218, H + 5, hex('79b6b9'));
    ribbon(draw, (y) => center(y) - width(y) * 0.1, (y) => width(y) * 0.67, 218, H + 5, hex('b3dfd5'));
  }
  for (let i = 0; i < (demon ? 45 : 105); i += 1) {
    const y = 229 + rnd() * (H - 229);
    const px = center(y) + (rnd() - 0.5) * width(y) * 0.85;
    const size = 2 + (y - 218) * 0.026 + rnd() * 4;
    if (demon) draw.ellipse(px, y, size * 0.65, size * 0.22, hex('b5a584', 125));
    else draw.line(px - size, y, px + size, y, Math.max(0.8, size * 0.1), hex('e9fbef', 140));
  }
  // Mid-ground grasses and wildflowers. Perspective increases their size and
  // spacing; route/stream remains readable rather than paved with flowers.
  for (let i = 0; i < 520; i += 1) {
    const y = 220 + (rnd() ** 0.8) * (H - 219);
    const x = rnd() * W;
    if (Math.abs(x - center(y)) < width(y) / 2 + 8) continue;
    const size = 0.32 + (y - 220) / 152;
    const grass = hex(i % 3 === 0 ? '5d9374' : '8fbc7c', 170);
    draw.line(x, y, x + (rnd() - 0.5) * 10 * size, y - (3 + rnd() * 6) * size, 0.9 * size, grass);
    if (i % 4 === 0) flower(draw, x, y - 2 * size, size * 0.8, hex(i % 8 === 0 ? 'f2d9e3' : 'fff6df', 190), grass);
    if (i % 7 === 0) dew(draw, x, y - size * 4, size * 0.85);
  }
  // Broad transparent shafts are deliberately behind the heroine.
  const band = demon ? [80, 125, 200] : [575, 640, 712];
  for (let i = 0; i < band.length; i += 1) {
    const x = band[i];
    draw.poly([[sunX - 7 + i * 5, sunY + 15], [sunX + 6 + i * 5, sunY + 15],
      [x + 55, H], [x - 22, H]], hex('fff8d8', 18 + i * 3));
  }

  // Project-original heroine, composed from a pinned SD animation frame.
  // The two CGs have different posing, focal placement, and foreground path.
  const size = demon ? 278 : 264;
  const cx = demon ? 492 : 271;
  const bottom = demon ? 372 : 378;
  draw.ellipse(cx, bottom + 1, size * 0.36, 13, hex('416f64', 50));
  draw.sprite(sprite, ...spriteRect, cx - size / 2, bottom - size, size, size);

  // Dew-bright foreground foliage creates a compositional frame, leaving the
  // face and clothes unobstructed. Distinct accents suit the heroine's palette.
  const petals = demon ? ['f0bdd8', 'ffd4d5', 'fff5d8'] : ['fff9dc', 'd8edf4', 'f0e49c'];
  const foreground = demon ? [[35, 420], [92, 414], [686, 422], [740, 407]] :
    [[29, 418], [81, 427], [680, 414], [748, 425]];
  for (const [px, py] of foreground) {
    for (let i = 0; i < 13; i += 1) {
      const x = px + (rnd() - 0.5) * 76;
      const y = py + (rnd() - 0.5) * 19;
      const length = 17 + rnd() * 27;
      const tip = x + (rnd() - 0.5) * 25;
      draw.poly([[x - 2, y], [tip, y - length], [x + 2.8, y],
        [x + 4.4, y + 12]], hex(i % 2 ? '386e61' : '63976b', 230));
      if (i % 3 === 0) flower(draw, x, y - length * 0.6, 1.55 + rnd() * 0.8, hex(petals[i % petals.length]), hex('4b8a64'));
      if (i % 4 === 0) dew(draw, tip, y - length, 1.7 + rnd() * 1.3);
    }
  }
  // A few subtle glints and airy bokeh; no text, logo or third-party assets.
  for (let i = 0; i < 40; i += 1) {
    const x = rnd() * W;
    const y = 48 + rnd() * 310;
    if (Math.abs(x - cx) < size * 0.38 && y > bottom - size * 0.9 && y < bottom - size * 0.22) continue;
    const r = 0.7 + rnd() * 3;
    draw.ellipse(x, y, r, r, hex('fffce5', 50 + rnd() * 50));
    if (i % 7 === 0) star(draw, x, y, r + 1, hex('fff9d8', 150));
  }
  return draw;
}

/** Two new event-specific compositions; existing travel CG function/bytes
 * are intentionally left unchanged. Original SD heroine sprite remains the
 * engineering placeholder; the props/backdrop distinguish narrative scenes. */
function renderEventScene(entry, sprite, spriteRect) {
  const night = entry.characterId === 'star-singer';
  const rnd = random(night ? 0x5ce15f91 : 0x14cc403c);
  const canvas = new Canvas(W, H);
  const palette = night ? ['25264f', '634d79', 'a381a7', '514160', 'e6d9fa'] : ['6a3f38', 'b87b55', 'e7b482', '866047', 'fff0ca'];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = smooth(clamp(y / H, 0, 1));
    const glow = clamp(1 - Math.hypot((x - (night ? 210 : 550)) / 500, (y - 150) / 380), 0, 1) * 0.37;
    canvas.pixel(x, y, mixColor(mixColor(hex(palette[0]), hex(palette[1]), t), hex(palette[2]), glow));
  }
  const rect = (l, t, r, b, color) => canvas.poly([[l,t],[r,t],[r,b],[l,b]], color);
  // Large window, distant sky and warm wooden frame; stars in the night
  // scene, sunset hills and scattered tree shapes in the ranger's scene.
  rect(48, 27, 332, 283, hex(night ? '171f42' : '704737'));
  for (let y = 39; y < 268; y++) {
    const sky = mixColor(hex(night ? '182241' : 'c27569'), hex(night ? '505280' : 'f7cf88'), (y - 39) / 229);
    rect(59, y, 320, y + 1, sky);
  }
  if (night) {
    canvas.ellipse(264, 87, 35, 35, hex('ece6ff', 230));
    canvas.ellipse(277, 78, 32, 32, hex('2a3056'));
    for (let i = 0; i < 64; i++) star(canvas, 68 + rnd() * 240, 45 + rnd() * 190, 1 + rnd() * 2, hex('faf0ff', 160));
  } else {
    canvas.ellipse(258, 120, 40, 40, hex('fff3bb'));
    canvas.poly([[59,237],[118,173],[177,231],[222,190],[320,239],[320,268],[59,268]], hex('77796a'));
    canvas.poly([[59,251],[132,221],[199,251],[253,229],[320,255],[320,268],[59,268]], hex('456e60'));
    for (let i = 0; i < 6; i++) tree(canvas, 78 + i * 44, 266, 30 + rnd() * 40, 7, { trunk: hex('495f50'), bark: hex('606c55'), foliage: hex('496e59'), light: hex('77976f') }, rnd);
  }
  rect(182, 37, 193, 268, hex(palette[3])); rect(59, 152, 320, 162, hex(palette[3]));
  rect(42, 272, 339, 286, hex(palette[3]));
  // Floor, desk or hearth scene, with props unique to the event.
  rect(0, 338, W, H, hex(night ? '3d314c' : '764d3e'));
  for (let i = 0; i < 9; i++) canvas.line(i * 100, 339, i * 109 - 70, H, 1.7, hex('2e263b', 80));
  canvas.line(0, 381, W, 381, 2, hex('2e263b', 90));
  if (night) {
    canvas.ellipse(188, 301, 131, 115, hex('b9b2e9', 36));
    canvas.poly([[84,261],[282,259],[333,335],[40,335]], hex('ae9bd2'));
    canvas.poly([[84,261],[282,259],[313,319],[58,319]], hex('f2e9d5'));
    canvas.line(185, 263, 188, 318, 2.8, hex('a89188'));
    const points = [[99,282],[130,275],[162,298],[210,278],[237,290],[277,278]];
    for (let i = 1; i < points.length; i++) canvas.line(...points[i - 1], ...points[i], 1.7, hex('b859a2'));
    for (const [x,y] of points) star(canvas,x,y,5,hex('cf78b5'));
    rect(43, 334, 333, 349, hex('6d4b66')); rect(62, 349, 78, 419, hex('5a395b')); rect(301, 349, 317, 419, hex('5a395b'));
  } else {
    rect(488, 181, 721, 344, hex('6b403b')); rect(511, 211, 697, 344, hex('382f37'));
    canvas.ellipse(603,310,84,35,hex('a9563d',180)); canvas.poly([[560,336],[574,299],[589,321],[604,267],[631,319],[650,306],[665,336]],hex('eb8755'));
    canvas.poly([[590,336],[610,301],[620,318],[635,310],[646,336]],hex('f9da82'));
    canvas.poly([[73,303],[314,303],[348,354],[39,354]],hex('bf946b'));
    canvas.ellipse(130,316,30,9,hex('e6dcbc')); canvas.ellipse(130,310,23,14,hex('fff0d2'));
    canvas.ellipse(130,304,20,6,hex('b27650')); canvas.ellipse(159,310,9,8,hex('fff0d2'));
    for (let i = 0; i < 8; i++) { const x=215+rnd()*100, y=311+rnd()*22; flower(canvas,x,y,1.1,hex('f9e4bc'),hex('6d8a63')); }
    rect(49,354,339,367,hex('694339')); rect(66,367,82,427,hex('694339')); rect(306,367,322,427,hex('694339'));
  }
  const size = 272, cx = night ? 504 : 414, bottom = 385;
  canvas.ellipse(cx, bottom + 4, 99, 15, hex('29263a', 70));
  canvas.sprite(sprite, ...spriteRect, cx - size / 2, bottom - size, size, size);
  for (let i = 0; i < 24; i++) {
    const x = rnd() * W, y = 40 + rnd() * 270;
    if (Math.abs(x - cx) < 105 && y > 130) continue;
    star(canvas,x,y,1.3+rnd()*2.5,hex(palette[4],90+rnd()*80));
  }
  return canvas;
}

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let r = n;
  for (let bit = 0; bit < 8; bit += 1) r = r & 1 ? 0xedb88320 ^ (r >>> 1) : r >>> 1;
  return r >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = (n >>> 8) ^ CRC[(n ^ b) & 255];
  return (n ^ 0xffffffff) >>> 0;
}
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type, bytes) {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), bytes]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.w); header.writeUInt32BE(image.h, 4);
  header[8] = 8; header[9] = 6; // RGBA8, filter 0, non-interlaced
  const row = image.w * 4;
  const filtered = Buffer.alloc((row + 1) * image.h);
  for (let y = 0; y < image.h; y += 1) {
    filtered.set(image.data.subarray(row * y, row * (y + 1)), (row + 1) * y + 1);
  }
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))]);
}

function decodePinnedPng(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Expected original RGBA PNG');
  let size;
  let ended = false;
  const compressed = [];
  for (let i = 8; i + 12 <= png.length;) {
    const n = png.readUInt32BE(i);
    const end = i + 12 + n;
    if (end > png.length) throw new Error('Truncated PNG');
    const type = png.toString('ascii', i + 4, i + 8);
    const data = png.subarray(i + 8, i + 8 + n);
    if (crc32(png.subarray(i + 4, i + 8 + n)) !== png.readUInt32BE(i + 8 + n)) throw new Error('PNG CRC mismatch');
    if (!size) {
      if (type !== 'IHDR' || n !== 13 || !data.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0]))) {
        throw new Error('Expected minimal RGBA8 PNG');
      }
      size = { w: data.readUInt32BE(0), h: data.readUInt32BE(4) };
      if (size.w < 1 || size.h < 1 || size.w > 2048 || size.h > 2048) throw new Error('Unexpected PNG dimensions');
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND' && n === 0 && end === png.length) {
      ended = true; break;
    } else throw new Error('Unexpected PNG chunk');
    i = end;
  }
  if (!size || !ended || !compressed.length) throw new Error('Incomplete PNG');
  const row = size.w * 4;
  const expected = (row + 1) * size.h;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error('Invalid PNG data size');
  const image = new Uint8Array(row * size.h);
  for (let y = 0; y < size.h; y += 1) {
    if (raw[y * (row + 1)] !== 0) throw new Error('Original generator uses PNG filter 0');
    image.set(raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)), y * row);
  }
  return { ...size, data: image };
}

/**
 * Read only the two built-in, exact-version, hash-checked atlas files. New
 * sprite versions are not silently used to regenerate existing CG versions.
 */
function readHeroine(characterId) {
  const root = join(ART_ROOT, characterId);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.characterId !== characterId || manifest.packVersion !== SPRITE_VERSION
    || manifest.license.reference !== 'original-poc-fixture') throw new Error('Original 1.0.1 sprite pack required');
  const verified = (relative) => {
    const spec = manifest.files.find((file) => file.path === relative);
    const bytes = readFileSync(join(root, relative));
    if (!spec || spec.bytes !== bytes.length || spec.sha256 !== sha(bytes)) throw new Error('Original asset hash mismatch');
    return bytes;
  };
  const data = JSON.parse(verified('assets/atlas.json').toString('utf8'));
  const image = decodePinnedPng(verified('assets/atlas.png'));
  if (data.image !== 'assets/atlas.png' || data.size.w !== image.w || data.size.h !== image.h) throw new Error('Atlas mismatch');
  const rect = data.clips.happy.frames[characterId === 'star-singer' ? 0 : 1].rect;
  const [x, y, w, h] = rect;
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w !== 128 || h !== 128
    || x + w > image.w || y + h > image.h) throw new Error('Unexpected sprite rect');
  return { image, rect };
}

/** True thumbnail of the same composition, 3x box downsample. */
function thumbnail(image) {
  if (image.w % 3 || image.h % 3) throw new Error('Thumbnail source dimensions must divide by three');
  const small = new Canvas(image.w / 3, image.h / 3);
  for (let y = 0; y < small.h; y += 1) for (let x = 0; x < small.w; x += 1) {
    const color = [0, 0, 0, 0];
    for (let dy = 0; dy < 3; dy += 1) for (let dx = 0; dx < 3; dx += 1) {
      const pos = ((y * 3 + dy) * image.w + (x * 3 + dx)) * 4;
      for (let c = 0; c < 4; c += 1) color[c] += image.data[pos + c] / 9;
    }
    small.pixel(x, y, color.map(Math.round));
  }
  return small;
}

function generate(entry) {
  if (!['star-singer', 'fluffy-ranger'].includes(entry.characterId)
    || !['morning-dew', 'star-singer.shared-constellation', 'fluffy-ranger.meadow-homecoming'].includes(entry.cgId) || entry.variant !== 'default' || entry.assetVersion !== '1.0.0') {
    throw new Error('This generator owns only the four 1.0.0 engineering CGs');
  }
  const heroine = readHeroine(entry.characterId);
  const canvas = entry.cgId === 'morning-dew' ? renderScene(entry, heroine.image, heroine.rect) : renderEventScene(entry, heroine.image, heroine.rect);
  const image = encodePng(canvas);
  const preview = encodePng(thumbnail(canvas));
  const descriptor = { ...entry, image: { bytes: image.length, sha256: sha(image) },
    thumbnail: { bytes: preview.length, sha256: sha(preview) } };
  const assetHash = sha(Buffer.from(serializeCgAssetDescriptor(descriptor), 'utf8'));
  return { image, preview, descriptor, assetHash };
}

const args = process.argv.slice(2);
if (process.versions.node !== '26.12.1') throw new Error('Use the pinned Node 26.12.1 for deterministic PNG compression');
if (args.length > 1 || (args.length === 1 && !['--check', '--print-metadata'].includes(args[0]))) {
  throw new Error('Usage: generate-demo-cg.mjs [--check|--print-metadata]');
}
const outputs = [...BUILTIN_CG_CATALOG, ...EVENT_CG_CATALOG].filter((entry) => ['morning-dew', 'star-singer.shared-constellation', 'fluffy-ranger.meadow-homecoming'].includes(entry.cgId) && entry.assetVersion === '1.0.0')
  .map((entry) => ({ entry, ...generate(entry) }));
if (outputs.length !== 4) throw new Error('All four original CG entries must exist');
// Print proposed metadata without altering pinned catalog or files. Used
// during development of a new assetVersion, not by the application runtime.
if (args[0] === '--print-metadata') {
  console.log(JSON.stringify(outputs.map(({ entry, descriptor, assetHash }) => ({
    characterId: entry.characterId, cgId: entry.cgId, image: descriptor.image, thumbnail: descriptor.thumbnail, assetHash,
  })), null, 2));
} else {
  for (const { entry, descriptor, assetHash } of outputs) {
    if (entry.assetHash !== assetHash || serializeCgAssetDescriptor(entry) !== serializeCgAssetDescriptor(descriptor)) {
      throw new Error(`Pinned CG metadata drift: ${entry.characterId}; do not overwrite an existing assetVersion`);
    }
  }
  for (const { entry, image, preview } of outputs) {
    const root = join(CG_ROOT, entry.characterId, entry.cgId, entry.variant, entry.assetVersion);
    for (const [file, bytes] of [['image.png', image], ['thumbnail.png', preview]]) {
      const target = join(root, file);
      if (args[0] === '--check') {
        if (!readFileSync(target).equals(bytes)) throw new Error(`CG byte drift: ${entry.characterId}/${file}`);
      } else {
        mkdirSync(root, { recursive: true });
        writeFileSync(target, bytes);
      }
    }
    console.log(`${entry.characterId}: CG ${W}×${H}, thumbnail ${W / 3}×${H / 3}, ${image.length + preview.length} bytes ${args[0] === '--check' ? 'verified' : 'written'}`);
  }
}
