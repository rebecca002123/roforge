'use strict';

// Generates build/icon.png (512x512 RGBA) with no image dependencies.
// electron-builder converts it to a Windows .ico at package time.
//
// The mark: a dark rounded tile with a tilted rounded square knocked through
// the middle — a nod to the Roblox silhouette — lit in the app's forge red.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 2; // supersampling factor per axis, for clean curves

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRect(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - (halfW - radius);
  const dy = Math.abs(y) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

function rotate(x, y, radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [x * c - y * s, x * s + y * c];
}

const ANGLE = -0.32; // radians of tilt on the inner mark
const c = (SIZE - 1) / 2;

/** Colour at a point, in 0-255 RGBA. Sampled SS×SS times per pixel. */
function sample(px, py) {
  const x = px - c;
  const y = py - c;

  // Outer tile.
  const tile = roundedRect(x, y, SIZE * 0.47, SIZE * 0.47, SIZE * 0.22);
  const tileA = Math.max(0, Math.min(1, 0.5 - tile));
  if (tileA <= 0) return [0, 0, 0, 0];

  // Tile fill: a cool near-black with a subtle top-light.
  const t = py / (SIZE - 1);
  let r = 20 + (1 - t) * 14;
  let g = 23 + (1 - t) * 14;
  let b = 32 + (1 - t) * 16;

  // Tilted rounded square, with a smaller one knocked out of its middle.
  const [rx, ry] = rotate(x, y, ANGLE);
  const outer = roundedRect(rx, ry, SIZE * 0.245, SIZE * 0.245, SIZE * 0.06);
  const inner = roundedRect(rx, ry, SIZE * 0.092, SIZE * 0.092, SIZE * 0.022);
  const ringA = Math.max(0, Math.min(1, 0.5 - outer)) * (1 - Math.max(0, Math.min(1, 0.5 - inner)));

  if (ringA > 0) {
    // Forge gradient: hot amber at the top edge into the app's red.
    const heat = Math.max(0, Math.min(1, (ry / (SIZE * 0.25) + 1) / 2));
    const mr = 255;
    const mg = 150 - heat * 60;
    const mb = 90 - heat * 62;
    r = r * (1 - ringA) + mr * ringA;
    g = g * (1 - ringA) + mg * ringA;
    b = b * (1 - ringA) + mb * ringA;
  }

  return [r, g, b, 255 * tileA];
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS - 0.5, y + (sy + 0.5) / SS - 0.5);
        r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
      }
    }
    const i = rowStart + 1 + x * 4;
    // Un-premultiply so edge pixels keep their colour instead of going dark.
    raw[i] = a > 0 ? Math.round(r / a) : 0;
    raw[i + 1] = a > 0 ? Math.round(g / a) : 0;
    raw[i + 2] = a > 0 ? Math.round(b / a) : 0;
    raw[i + 3] = Math.round(a / (SS * SS));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
