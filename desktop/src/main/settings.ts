import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.ts";

export class SettingsStore {
  private cache: Settings | null = null;
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "settings.json");
  }

  get(): Settings {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>;
      this.cache = { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      this.cache = { ...DEFAULT_SETTINGS };
    }
    return this.cache;
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    this.cache = next;
    return next;
  }
}
