import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";
// One version for the whole product: package.json is the source, the manifest is generated.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
manifest.version = version;
writeFileSync(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("src/options/options.html", `${outdir}/options.html`);
cpSync("src/options/options.css", `${outdir}/options.css`);
cpSync("icons", `${outdir}/icons`, { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "browser",
  target: ["chrome116"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: { background: "src/background/index.ts" }, outdir, format: "esm" }),
  esbuild.context({ ...common, entryPoints: { content: "src/content/index.ts", options: "src/options/options.ts" }, outdir, format: "iife" }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("Watching for changes… load the dist/ folder as an unpacked extension.");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`Built ${version} to dist/. Load it via chrome://extensions → Load unpacked.`);
}
