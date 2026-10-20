/**
 * make-icons.mjs — rasterise the app icon to PNG without a dependency.
 *
 * PWA install prompts still want real PNGs on several platforms, and pulling a
 * whole image toolchain in for four files is not worth it. This draws the same
 * shapes as public/icon.svg into an RGBA buffer and writes a PNG by hand
 * (node:zlib supplies the deflate).
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public');

const BG = [0x0d, 0x14, 0x20];
const DIM = [0x1d, 0x28, 0x38];
const HUES = [
  [0x5e, 0xc8, 0xf2],
  [0x7e, 0xe0, 0xa8],
  [0xf2, 0xd3, 0x5e],
  [0xf2, 0x61, 0x4f],
];
const METER_BG = [0x17, 0x20, 0x2f];
const METER = [0x4f, 0xd1, 0xc5];

/** Blocks laid out on a 512x512 design grid, as [x, y, colour]. */
const DESIGN = (() => {
  const dim = [
    [96, 128], [176, 128], [256, 128], [336, 128],
    [96, 208], [336, 208],
    [96, 288], [176, 288],
  ].map(([x, y]) => [x, y, DIM]);
  const lit = [
    [176, 208, HUES[0]],
    [256, 208, HUES[1]],
    [256, 288, HUES[2]],
    [336, 288, HUES[3]],
  ];
  return [...dim, ...lit];
})();

function render(size, { maskable }) {
  const px = new Uint8Array(size * size * 4);
  const s = size / 512;
  // A maskable icon must survive a circular crop, so shrink the artwork into
  // the safe zone (80%) and let the background bleed to the edges.
  const art = maskable ? 0.8 : 1;
  const inset = ((1 - art) * 512) / 2;
  const radius = maskable ? 0 : 96 * s;

  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
    px[i + 3] = 255;
  };

  // background with rounded corners
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (radius > 0) {
        const dx = Math.min(x, size - 1 - x);
        const dy = Math.min(y, size - 1 - y);
        if (dx < radius && dy < radius) {
          const d = Math.hypot(radius - dx, radius - dy);
          if (d > radius) continue; // leave transparent
        }
      }
      set(x, y, BG);
    }
  }

  const rect = (dx, dy, dw, dh, rgb, r = 12) => {
    const x0 = Math.round((inset + dx * art) * s);
    const y0 = Math.round((inset + dy * art) * s);
    const w = Math.round(dw * art * s);
    const h = Math.round(dh * art * s);
    const rr = Math.max(0, Math.round(r * art * s));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = Math.min(x, w - 1 - x);
        const cy = Math.min(y, h - 1 - y);
        if (cx < rr && cy < rr && Math.hypot(rr - cx, rr - cy) > rr) continue;
        set(x0 + x, y0 + y, rgb);
      }
    }
  };

  for (const [x, y, rgb] of DESIGN) rect(x, y, 72, 72, rgb);
  rect(96, 392, 312, 26, METER_BG, 13);
  rect(96, 392, 214, 26, METER, 13);

  return px;
}

function writePng(path, size, px) {
  // filter byte 0 (None) per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  return png.length;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, opts] of targets) {
  const bytes = writePng(join(outDir, name), size, render(size, opts));
  console.log(`${name}  ${size}x${size}  ${bytes} bytes`);
}
