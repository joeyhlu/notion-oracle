/** Open the user's terminal running a command (used for the one-time CLI sign-in). */

import { spawn } from "node:child_process";

export function openTerminal(command: string): void {
  if (process.platform === "darwin") {
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    spawn("osascript", ["-e", 'tell application "Terminal"', "-e", "activate", "-e", `do script "${escaped}"`, "-e", "end tell"], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/c", "start", '"Notion Oracle"', "cmd.exe", "/k", command], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return;
  }
  const script = `${command}; exec $SHELL`;
  for (const [bin, args] of [
    ["x-terminal-emulator", ["-e", "bash", "-c", script]],
    ["gnome-terminal", ["--", "bash", "-c", script]],
    ["konsole", ["-e", "bash", "-c", script]],
    ["xterm", ["-e", "bash", "-c", script]],
  ] as const) {
    try {
      const child = spawn(bin, [...args], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
      return;
    } catch {
      // try the next terminal
    }
  }
}
