import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync("src/manifest.json", `${outdir}/manifest.json`);
cpSync("src/options/options.html", `${outdir}/options.html`);
cpSync("src/options/options.css", `${outdir}/options.css`);
if (existsSync("icons")) cpSync("icons", `${outdir}/icons`, { recursive: true });

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
  console.log("Built to dist/. Load it via chrome://extensions → Load unpacked.");
}
