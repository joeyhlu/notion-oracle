/**
 * Zips dist/ into release/notion-oracle-extension.zip: the file people download from
 * the release page and load, and the file a Chrome Web Store upload takes. No dependencies: the
 * zip format is written by hand with deflate from node:zlib.
 *
 * Entries go inside a top-level "notion-oracle-extension" folder, so unzipping produces one
 * obvious folder to pick in "Load unpacked".
 */
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const FOLDER = "notion-oracle-extension";

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

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk("dist");
if (!files.includes(join("dist", "manifest.json"))) throw new Error("dist/ has no manifest.json; run npm run build first.");
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
if (manifest.version !== version) throw new Error(`dist/ was built as ${manifest.version}, package.json says ${version}; rebuild.`);

// A fixed timestamp keeps the zip byte-identical for identical input.
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(`${FOLDER}/${relative("dist", file).split("\\").join("/")}`);
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, packed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync("release", { recursive: true });
// No version in the name: the release page's latest/download link must stay valid across releases.
const out = "release/notion-oracle-extension.zip";
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`Wrote ${out} (${files.length} files)`);
