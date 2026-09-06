/** Locate the Claude Code / Codex executables and report their sign-in state. */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { BrainId, BrainStatus } from "../shared/types.ts";
import { runCapture } from "./process.ts";

const NAMES: Record<BrainId, string> = { claude: "claude", codex: "codex" };

function candidatePaths(name: string): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(home, ".local", "bin", `${name}.exe`),
      join(local, "Programs", name, `${name}.exe`),
      join(appData, "npm", `${name}.cmd`),
      join(local, "pnpm", `${name}.cmd`),
    ];
  }
  return [
    join(home, ".local", "bin", name),
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
    join(home, ".npm-global", "bin", name),
    join(home, ".volta", "bin", name),
    join(home, ".bun", "bin", name),
    "/usr/bin/" + name,
  ];
}

/** GUI apps on macOS do not inherit the shell PATH, so ask the login shell where the command lives. */
async function resolveViaShell(name: string): Promise<string | null> {
  if (process.platform === "win32") {
    const res = await runCapture("cmd.exe", ["/d", "/c", `where ${name}`], { timeoutMs: 8000 });
    const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l));
    return first ?? null;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const res = await runCapture(shell, ["-ilc", `command -v ${name}`], { timeoutMs: 8000 });
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => l.startsWith("/") && existsSync(l));
  return hit ?? null;
}

export async function resolveCli(brain: BrainId, override?: string): Promise<string | null> {
  if (override?.trim()) return existsSync(override.trim()) ? override.trim() : null;
  const name = NAMES[brain];
  for (const p of candidatePaths(name)) if (existsSync(p)) return p;
  const fromPath = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, process.platform === "win32" ? `${name}.cmd` : name)).find((p) => existsSync(p));
  if (fromPath) return fromPath;
  return resolveViaShell(name);
}

export async function checkBrain(brain: BrainId, override?: string): Promise<BrainStatus> {
  const path = await resolveCli(brain, override);
  if (!path) {
    return { brain, installed: false, path: null, version: null, loggedIn: null, detail: `${NAMES[brain]} was not found. Install it, then click Re-check.` };
  }
  const version = (await runCapture(path, ["--version"], { timeoutMs: 15000 })).stdout.trim().split("\n")[0] ?? null;
  if (brain === "claude") {
    const res = await runCapture(path, ["auth", "status"], { timeoutMs: 20000 });
    try {
      const status = JSON.parse(res.stdout) as { loggedIn?: boolean; authMethod?: string };
      const loggedIn = Boolean(status.loggedIn);
      return { brain, installed: true, path, version, loggedIn, detail: loggedIn ? `Signed in (${status.authMethod ?? "ok"}).` : "Installed but not signed in." };
    } catch {
      return { brain, installed: true, path, version, loggedIn: null, detail: `Could not read sign-in status: ${(res.stderr || res.stdout).trim().slice(0, 200) || "no output"}` };
    }
  }
  const res = await runCapture(path, ["login", "status"], { timeoutMs: 20000 });
  const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
  const loggedIn = res.code === 0 && !/not logged in/.test(text);
  return { brain, installed: true, path, version, loggedIn, detail: loggedIn ? "Signed in." : "Installed but not signed in." };
}
