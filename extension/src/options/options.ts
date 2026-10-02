/**
 * Setup and settings in one page. It opens on install, saves as you type, and checks each key
 * the moment it is pasted, so getting started is: paste a key, see it go green, open Notion.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NotionClient, databaseTitle, pageTitle, type NotionDataSource, type NotionPage } from "../lib/notion.ts";
import { describeAnthropicError } from "../lib/providers/anthropic.ts";
import { describeOpenAIError } from "../lib/providers/openai.ts";
import { markSvg } from "../shared/mark.ts";
import { iconSvg } from "../shared/icons.ts";
import { loadSettings, saveSettings } from "../shared/settings.ts";
import { CLAUDE_MODELS, OPENAI_MODELS, type ProviderId, type Settings } from "../shared/types.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let settings: Settings;

const TOGGLES = ["webSearch", "workspaceSearch", "bulkEdit", "aiShortcut", "selectionButton", "floatingButton"] as const;

// ---------- form <-> settings ----------

function fill(): void {
  setProvider(settings.provider, false);
  $<HTMLInputElement>("anthropicApiKey").value = settings.anthropicApiKey;
  $<HTMLSelectElement>("anthropicModel").value = settings.anthropicModel;
  // A model chosen before this list existed still shows, rather than silently changing.
  if ($<HTMLSelectElement>("anthropicModel").value !== settings.anthropicModel) {
    const option = new Option(settings.anthropicModel, settings.anthropicModel);
    $<HTMLSelectElement>("anthropicModel").add(option);
    option.selected = true;
  }
  $<HTMLSelectElement>("effort").value = settings.effort;
  $<HTMLInputElement>("openaiApiKey").value = settings.openaiApiKey;
  $<HTMLInputElement>("openaiModel").value = settings.openaiModel;
  $<HTMLInputElement>("notionToken").value = settings.notionToken;
  $<HTMLTextAreaElement>("customInstructions").value = settings.customInstructions;
  for (const key of TOGGLES) $<HTMLInputElement>(key).checked = settings[key];
}

function read(): Settings {
  return {
    ...settings,
    anthropicApiKey: $<HTMLInputElement>("anthropicApiKey").value.trim(),
    anthropicModel: $<HTMLSelectElement>("anthropicModel").value,
    effort: $<HTMLSelectElement>("effort").value as Settings["effort"],
    openaiApiKey: $<HTMLInputElement>("openaiApiKey").value.trim(),
    openaiModel: $<HTMLInputElement>("openaiModel").value.trim() || "gpt-5.5",
    notionToken: $<HTMLInputElement>("notionToken").value.trim(),
    customInstructions: $<HTMLTextAreaElement>("customInstructions").value,
    ...Object.fromEntries(TOGGLES.map((key) => [key, $<HTMLInputElement>(key).checked])),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savedTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = read();
    await saveSettings(settings);
    const saved = $("saved");
    saved.textContent = "Saved";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.textContent = ""), 1800);
  }, 250);
}

function setProvider(provider: ProviderId, save = true): void {
  settings.provider = provider;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-provider]")) b.setAttribute("aria-checked", String(b.dataset.provider === provider));
  $("anthropic-fields").hidden = provider !== "anthropic";
  $("openai-fields").hidden = provider !== "openai";
  $<HTMLInputElement>("webSearch").disabled = provider !== "anthropic";
  if (save) {
    scheduleSave();
    void checkAi();
  }
}

// ---------- checks ----------

function setCheck(id: string, text: string, kind: "ok" | "err" | "wait" | "" = ""): void {
  const node = $(id);
  node.textContent = text;
  node.className = `check ${kind}`.trim();
}

/**
 * A step's status, shown twice the way a Notion page would: as a tag beside the heading and in
 * the property rows at the top. Green when done, red when something is wrong, grey otherwise.
 */
function setStep(step: string, kind: "ok" | "bad" | "idle", text: string): void {
  $(`step-${step}`).classList.toggle("done", kind === "ok");
  for (const id of [`badge-${step}`, `prop-${step}`]) {
    const tag = $(id);
    tag.textContent = text;
    tag.className = `tag${kind === "idle" ? "" : ` ${kind}`}`;
  }
}

let aiCheck = 0;

async function checkAi(): Promise<void> {
  const s = read();
  const mine = ++aiCheck;
  const key = s.provider === "anthropic" ? s.anthropicApiKey : s.openaiApiKey;
  if (!key) {
    setCheck("check-ai", "");
    setStep("ai", "idle", "Needs a key");
    return;
  }
  setCheck("check-ai", "Checking the key…", "wait");
  setStep("ai", "idle", "Checking");
  try {
    let label: string;
    if (s.provider === "anthropic") {
      const model = await new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 }).models.retrieve(s.anthropicModel);
      label = model.display_name || s.anthropicModel;
    } else {
      const model = await new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 }).models.retrieve(s.openaiModel);
      label = model.id;
    }
    if (mine !== aiCheck) return;
    setCheck("check-ai", `Connected. Oracle will use ${label}.`, "ok");
    setStep("ai", "ok", "Connected");
  } catch (error) {
    if (mine !== aiCheck) return;
    setCheck("check-ai", s.provider === "anthropic" ? describeAnthropicError(error) : describeOpenAIError(error), "err");
    setStep("ai", "bad", "Not working");
  }
}

let notionCheck = 0;

async function checkNotion(): Promise<void> {
  const token = $<HTMLInputElement>("notionToken").value.trim();
  const mine = ++notionCheck;
  const list = $("notion-pages");
  list.hidden = true;
  if (!token) {
    setCheck("check-notion", "");
    setStep("notion", "idle", "Not connected");
    return;
  }
  setCheck("check-notion", "Checking…", "wait");
  try {
    const notion = new NotionClient(token);
    const me = await notion.me();
    const found = await notion.search("", undefined, 12);
    if (mine !== notionCheck) return;
    const name = me.name ?? "your integration";
    if (!found.length) {
      setCheck("check-notion", `Connected as “${name}”, but no pages are shared with it yet. In Notion, open a page, choose ••• → Connections and add ${name}, then press Check again.`, "err");
      setStep("notion", "bad", "No pages shared");
      return;
    }
    setCheck("check-notion", `Connected as “${name}”. Oracle can see these, and everything under them:`, "ok");
    setStep("notion", "ok", "Connected");
    list.replaceChildren(
      ...found.slice(0, 10).map((r) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        const object = (r as { object?: string }).object;
        name.textContent = object === "data_source" || object === "database" ? databaseTitle(r as NotionDataSource) : pageTitle(r as NotionPage) || "Untitled";
        li.append(name);
        return li;
      }),
    );
    list.hidden = false;
  } catch (error) {
    if (mine !== notionCheck) return;
    const message = error instanceof Error ? error.message : String(error);
    setCheck("check-notion", /401|unauthorized|invalid/i.test(message) ? "Notion did not accept that secret. Copy the Internal Integration Secret again." : message, "err");
    setStep("notion", "bad", "Not working");
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

// ---------- page ----------

async function main(): Promise<void> {
  settings = await loadSettings();
  $("mark").innerHTML = markSvg(78);
  for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) node.innerHTML = iconSvg(node.dataset.icon ?? "", 14);
  for (const node of document.querySelectorAll("[data-version]")) node.textContent = chrome.runtime.getManifest().version;
  for (const node of document.querySelectorAll("[data-mod]")) node.textContent = isMac ? "⌘" : "Ctrl";

  const claude = $<HTMLSelectElement>("anthropicModel");
  for (const m of CLAUDE_MODELS) claude.add(new Option(`${m.label} — ${m.note}`, m.id));
  const openaiList = $("openai-models");
  for (const m of OPENAI_MODELS) {
    const option = document.createElement("option");
    option.value = m.id;
    option.label = `${m.label} — ${m.note}`;
    openaiList.append(option);
  }
  fill();

  const welcome = new URLSearchParams(location.search).has("welcome");
  const configured = Boolean(settings.provider === "anthropic" ? settings.anthropicApiKey : settings.openaiApiKey);
  if (!welcome && configured) $("lede").textContent = "Settings. Changes save as you make them.";

  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-provider]")) b.addEventListener("click", () => setProvider(b.dataset.provider as ProviderId));
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-reveal]")) {
    b.addEventListener("click", () => {
      const input = $<HTMLInputElement>(b.dataset.reveal!);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "Hide" : "Show";
    });
  }

  const recheckAi = debounce(() => void checkAi(), 500);
  const recheckNotion = debounce(() => void checkNotion(), 500);
  for (const id of ["anthropicApiKey", "openaiApiKey", "openaiModel"]) {
    $(id).addEventListener("input", () => {
      scheduleSave();
      recheckAi();
    });
  }
  for (const id of ["anthropicModel", "effort"]) {
    $(id).addEventListener("change", () => {
      scheduleSave();
      recheckAi();
    });
  }
  $("notionToken").addEventListener("input", () => {
    scheduleSave();
    recheckNotion();
  });
  $("recheck-notion").addEventListener("click", () => void checkNotion());
  $("customInstructions").addEventListener("input", scheduleSave);
  for (const key of TOGGLES) $(key).addEventListener("change", scheduleSave);

  $("open-notion").addEventListener("click", () => void chrome.tabs.create({ url: "https://www.notion.so/" }));
  $("open-shortcuts").addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

  void checkAi();
  void checkNotion();
  if (welcome && !configured) setTimeout(() => $<HTMLInputElement>(settings.provider === "anthropic" ? "anthropicApiKey" : "openaiApiKey").focus(), 100);
}

void main();
