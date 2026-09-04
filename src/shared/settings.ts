import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

const STORAGE_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const partial = (stored[STORAGE_KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...partial };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export function providerLabel(settings: Settings): string {
  return settings.provider === "anthropic"
    ? `Claude · ${settings.anthropicModel}`
    : `ChatGPT · ${settings.openaiModel}`;
}

export function activeApiKey(settings: Settings): string {
  return settings.provider === "anthropic" ? settings.anthropicApiKey : settings.openaiApiKey;
}
