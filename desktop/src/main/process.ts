/** Small child-process helpers that behave the same on macOS, Windows and Linux. */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/** Quote one argument for cmd.exe + CRT argv parsing. Only used when spawning .cmd shims on Windows. */
export function winQuote(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function spawnCli(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (needsShell(command)) {
    const line = [winQuote(command), ...args.map(winQuote)].join(" ");
    return spawn(line, { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, args, { ...options, windowsHide: true });
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCapture(command: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawnCli(command, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 15000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

export function shellEnv(): NodeJS.ProcessEnv {
  return process.env;
}
