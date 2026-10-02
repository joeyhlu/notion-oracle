import { DEFAULT_SETTINGS, SETTINGS_VERSION, type Settings } from "./types.ts";

const STORAGE_KEY = "settings";

/**
 * Brings settings saved by an earlier version up to date. The settings page writes the whole
 * object, so an old default such as the model id is indistinguishable from a choice; the only
 * value moved here is the old default model, to the model that replaced it.
 */
export function migrateSettings(stored: Partial<Settings> | undefined): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  if ((stored?.version ?? 1) < 2 && stored?.anthropicModel === "claude-opus-5") merged.anthropicModel = "claude-opus-5-5";
  merged.version = SETTINGS_VERSION;
  return merged;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return migrateSettings(stored[STORAGE_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...settings, version: SETTINGS_VERSION } });
}

export function providerLabel(settings: Settings): string {
  return settings.provider === "anthropic" ? `Claude · ${settings.anthropicModel}` : `ChatGPT · ${settings.openaiModel}`;
}

/** Short model name for the panel header: "Opus 5.5", "GPT-5.5". */
export function shortModelLabel(settings: Settings): string {
  if (settings.provider === "openai") return settings.openaiModel.replace(/^gpt-/i, "GPT-");
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(settings.anthropicModel);
  if (!m) return settings.anthropicModel;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${name} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ""}`;
}

export function activeApiKey(settings: Settings): string {
  return settings.provider === "anthropic" ? settings.anthropicApiKey : settings.openaiApiKey;
}
