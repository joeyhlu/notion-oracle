/** Generates app icon (1024px) and tray icons (22px / 44px template) as PNGs with no dependencies. */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Purple rounded square with a white ring (app icon). */
function appIcon(size) {
  const c = (size - 1) / 2, outer = size * 0.34, inner = size * 0.18, corner = size * 0.22;
  return png(size, (x, y) => {
    const dx = Math.max(Math.abs(x - c) - (c - corner), 0), dy = Math.max(Math.abs(y - c) - (c - corner), 0);
    const inSquare = Math.hypot(dx, dy) <= corner, d = Math.hypot(x - c, y - c);
    // Anti-alias the ring edges slightly.
    const ringAlpha = Math.max(0, Math.min(1, outer + 0.8 - d)) * Math.max(0, Math.min(1, d - inner + 0.8));
    if (!inSquare) return [0, 0, 0, 0];
    const r = Math.round(107 + (255 - 107) * ringAlpha), g = Math.round(87 + (255 - 87) * ringAlpha), b = 255;
    return [r, g, b, 255];
  });
}

/** Black ring on transparent (macOS template image; also fine on Windows/Linux). */
function trayIcon(size) {
  const c = (size - 1) / 2, outer = size * 0.42, inner = size * 0.24;
  return png(size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    const a = Math.max(0, Math.min(1, outer + 0.7 - d)) * Math.max(0, Math.min(1, d - inner + 0.7));
    return [0, 0, 0, Math.round(255 * a)];
  });
}

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", appIcon(1024));
writeFileSync("build/tray.png", trayIcon(22));
writeFileSync("build/tray@2x.png", trayIcon(44));
console.log("Icons written to build/");
