import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";

// Taken from package.json at build time so the version shown in the app cannot drift from the
// version that was released. Nothing in the source hard-codes it.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const watch = process.argv.includes("--watch");
const outdir = "dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(`${outdir}/renderer`, { recursive: true });
cpSync("src/renderer/index.html", `${outdir}/renderer/index.html`);
cpSync("src/renderer/styles.css", `${outdir}/renderer/styles.css`);
cpSync("build/tray.png", `${outdir}/tray.png`);
cpSync("build/tray@2x.png", `${outdir}/tray@2x.png`);
cpSync("build/icon.png", `${outdir}/icon.png`);

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true, sourcemap: watch ? "inline" : false, minify: false, logLevel: "info", target: ["node20"],
  define: { __APP_VERSION__: JSON.stringify(version) },
};

const contexts = await Promise.all([
  // Electron main + preload: CommonJS, node platform, electron kept external.
  esbuild.context({ ...common, platform: "node", format: "cjs", external: ["electron"], entryPoints: { "main/main": "src/main/main.ts", "preload/preload": "src/preload/preload.ts" }, outdir }),
  // Notion MCP server: standalone node script spawned by the AI CLI.
  esbuild.context({ ...common, platform: "node", format: "cjs", entryPoints: { "mcp/notion-server": "src/mcp/notion-server.ts", "mcp/calendar-server": "src/mcp/calendar-server.ts" }, outdir }),
  // Renderer: browser bundle.
  esbuild.context({ ...common, platform: "browser", format: "iife", target: ["chrome120"], entryPoints: { "renderer/renderer": "src/renderer/renderer.ts" }, outdir }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("Watching…");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log("Built to dist/.");
}
