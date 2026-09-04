import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NotionClient } from "../lib/notion.ts";
import { loadSettings, saveSettings } from "../shared/settings.ts";
import type { ProviderId, Settings } from "../shared/types.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $<HTMLSpanElement>("status");

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  status.textContent = text;
  status.className = kind;
}

function readForm(): Settings {
  const provider = (document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value ?? "anthropic") as ProviderId;
  return {
    provider,
    anthropicApiKey: $<HTMLInputElement>("anthropicApiKey").value.trim(),
    anthropicModel: $<HTMLSelectElement>("anthropicModel").value,
    openaiApiKey: $<HTMLInputElement>("openaiApiKey").value.trim(),
    openaiModel: $<HTMLInputElement>("openaiModel").value.trim() || "gpt-5.5",
    notionToken: $<HTMLInputElement>("notionToken").value.trim(),
    effort: $<HTMLSelectElement>("effort").value as Settings["effort"],
    customInstructions: $<HTMLTextAreaElement>("customInstructions").value,
  };
}

function fillForm(settings: Settings): void {
  document.querySelector<HTMLInputElement>(`input[name="provider"][value="${settings.provider}"]`)!.checked = true;
  $<HTMLInputElement>("anthropicApiKey").value = settings.anthropicApiKey;
  $<HTMLSelectElement>("anthropicModel").value = settings.anthropicModel;
  $<HTMLInputElement>("openaiApiKey").value = settings.openaiApiKey;
  $<HTMLInputElement>("openaiModel").value = settings.openaiModel;
  $<HTMLInputElement>("notionToken").value = settings.notionToken;
  $<HTMLSelectElement>("effort").value = settings.effort;
  $<HTMLTextAreaElement>("customInstructions").value = settings.customInstructions;
  syncProviderFields();
}

function syncProviderFields(): void {
  const provider = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value ?? "anthropic";
  $<HTMLFieldSetElement>("anthropic-fields").hidden = provider !== "anthropic";
  $<HTMLFieldSetElement>("openai-fields").hidden = provider !== "openai";
}

async function testConnection(kind: string): Promise<void> {
  const s = readForm();
  setStatus("Testing…");
  try {
    if (kind === "anthropic") {
      if (!s.anthropicApiKey) throw new Error("Enter an Anthropic API key first.");
      const client = new Anthropic({ apiKey: s.anthropicApiKey, dangerouslyAllowBrowser: true });
      const model = await client.models.retrieve(s.anthropicModel);
      setStatus(`Claude OK: ${model.display_name}`, "ok");
    } else if (kind === "openai") {
      if (!s.openaiApiKey) throw new Error("Enter an OpenAI API key first.");
      const client = new OpenAI({ apiKey: s.openaiApiKey, dangerouslyAllowBrowser: true });
      const model = await client.models.retrieve(s.openaiModel);
      setStatus(`OpenAI OK: ${model.id}`, "ok");
    } else if (kind === "notion") {
      if (!s.notionToken) throw new Error("Enter a Notion integration secret first.");
      const me = await new NotionClient(s.notionToken).me();
      const pages = await new NotionClient(s.notionToken).search("", undefined, 5);
      setStatus(`Notion OK: integration "${me.name ?? "unnamed"}" can see ${pages.length === 0 ? "no pages yet (share pages with it via ••• → Connections)" : `${pages.length}+ pages`}`, "ok");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "err");
  }
}

async function main(): Promise<void> {
  fillForm(await loadSettings());
  for (const radio of document.querySelectorAll('input[name="provider"]')) radio.addEventListener("change", syncProviderFields);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-test]")) {
    button.addEventListener("click", () => void testConnection(button.dataset.test ?? ""));
  }
  $<HTMLButtonElement>("save").addEventListener("click", async () => {
    await saveSettings(readForm());
    setStatus("Saved.", "ok");
    setTimeout(() => setStatus(""), 2500);
  });
}

void main();
