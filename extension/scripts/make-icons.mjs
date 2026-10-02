/**
 * Renders the Oracle mark to PNG at every size the extension and the desktop app need, with no
 * dependencies: each shape is a signed distance field, and coverage comes from the distance at
 * 4x4 sub-pixel samples, so edges are anti-aliased at 16px as well as at 1024px.
 *
 *   node scripts/make-icons.mjs            # extension icons
 *   node scripts/make-icons.mjs --desktop  # also ../desktop/build/icon.png
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { MARK, pointCentre } from "../src/shared/mark.ts";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Signed distances in tile units (negative inside). */
function roundedBox(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

/**
 * `inset` is transparent margin as a fraction of the canvas. Chrome asks for artwork inside a
 * 96px box on the 128px icon; the toolbar sizes use the whole square.
 */
function render(size, inset) {
  const half = 0.5 - inset;
  const scale = half * 2; // tile side as a fraction of the canvas
  const p = pointCentre();
  const ink = hex(MARK.ink), paper = hex(MARK.paper), point = hex(MARK.point);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const N = 4;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          // Canvas coordinates, then tile coordinates.
          const cx = (px + (sx + 0.5) / N) / size;
          const cy = (py + (sy + 0.5) / N) / size;
          const x = 0.5 + (cx - 0.5) / scale;
          const y = 0.5 + (cy - 0.5) / scale;
          if (roundedBox(x, y, 0.5, MARK.corner) > 0) continue;
          let colour = ink;
          const dot = circle(x, y, p.x, p.y, MARK.pointRadius);
          const orbit = Math.abs(Math.hypot(x - 0.5, y - 0.5) - MARK.orbitRadius) - MARK.orbitWidth / 2;
          const clear = circle(x, y, p.x, p.y, MARK.pointRadius + MARK.clearance);
          if (dot <= 0) colour = point;
          else if (orbit <= 0 && clear > 0) colour = paper;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }
      const i = py * (size * 4 + 1) + 1 + px * 4;
      const n = N * N;
      const cover = a / n;
      // Premultiplied average, un-premultiplied for PNG.
      raw.set(cover ? [Math.round(r / (a / 255)), Math.round(g / (a / 255)), Math.round(b / (a / 255)), Math.round(cover)] : [0, 0, 0, 0], i);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("icons", { recursive: true });
const INSET = { 16: 0, 32: 1 / 32, 48: 2 / 48, 128: 16 / 128 };
for (const size of [16, 32, 48, 128]) writeFileSync(`icons/icon${size}.png`, render(size, INSET[size]));
console.log("Extension icons written to icons/");
if (process.argv.includes("--desktop")) {
  writeFileSync("../desktop/build/icon.png", render(1024, 0));
  console.log("Desktop icon written to ../desktop/build/icon.png");
}
