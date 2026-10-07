/**
 * A plain log file in the user-data folder, for the failures a tray app would otherwise swallow.
 *
 * Oracle has no server and sends nothing home; this is the one place a problem is written down,
 * so a user can attach it to an issue. Keep it free of secrets and page content: error messages
 * and stack traces only. One previous file is kept when the current one fills up.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_LOG_BYTES = 1_000_000;

export type LogLevel = "info" | "warn" | "error";

function describe(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** One line: time, level, message, and the detail flattened after it. Pure, so it is unit-tested. */
export function formatLine(level: LogLevel, message: string, detail?: unknown, now = new Date()): string {
  const extra = detail === undefined ? "" : ` ${describe(detail)}`;
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra}\n`;
}

export class FileLog {
  readonly path: string;
  private readonly maxBytes: number;

  constructor(path: string, maxBytes = MAX_LOG_BYTES) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  info(message: string, detail?: unknown): void {
    this.write("info", message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.write("warn", message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.write("error", message, detail);
  }

  /** Never throws: a log that cannot be written must not become a second failure. */
  write(level: LogLevel, message: string, detail?: unknown): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.rotate();
      appendFileSync(this.path, formatLine(level, message, detail));
    } catch {
      // Nowhere left to report it.
    }
  }

  private rotate(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    renameSync(this.path, `${this.path}.1`);
  }
}
