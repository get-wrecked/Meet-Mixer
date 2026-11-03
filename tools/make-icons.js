// Draws the Meet Mixer icon (three mixer sliders on a blue rounded square) and writes
// extension/icons/icon16.png … icon128.png. Node built-ins only: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling per axis, for smooth edges

// The design on a 128 × 128 grid.
const BG = [26, 115, 232];      // Meet blue
const FG = [255, 255, 255];
const TRACKS = [40, 64, 88];    // slider x positions
const KNOBS = [82, 44, 64];     // knob y positions
function shade(x, y) {
  // Rounded square, radius 28.
  const r = 28;
  const cx = Math.min(Math.max(x, r), 128 - r);
  const cy = Math.min(Math.max(y, r), 128 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  for (let i = 0; i < 3; i++) {
    if ((x - TRACKS[i]) ** 2 + (y - KNOBS[i]) ** 2 <= 13 * 13) return FG;
  }
  for (const tx of TRACKS) {
    if (Math.abs(x - tx) <= 4 && y >= 26 && y <= 102) return mix(BG, FG, 0.55);
  }
  return BG;
}
function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(((x + (sx + 0.5) / SS) * 128) / size, ((y + (sy + 0.5) / SS) * 128) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = (y * size + x) * 4;
      if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
      px[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const out = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of SIZES) fs.writeFileSync(path.join(out, `icon${size}.png`), render(size));
console.log(`Wrote ${SIZES.map((s) => `icon${s}.png`).join(', ')} to ${out}`);
