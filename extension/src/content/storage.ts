/** Saved chats and the change list, read and written from the page. */

import { INDEX_KEY, conversationKey, summarize, upsertIndex, type Conversation, type ConversationSummary } from "../lib/conversations.ts";
import type { StoredChange } from "../shared/types.ts";

export async function listConversations(): Promise<ConversationSummary[]> {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  return (stored[INDEX_KEY] as ConversationSummary[] | undefined) ?? [];
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  const key = conversationKey(id);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as Conversation | undefined) ?? null;
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const { index, evicted } = upsertIndex(await listConversations(), summarize(conversation));
  await chrome.storage.local.set({ [conversationKey(conversation.id)]: conversation, [INDEX_KEY]: index });
  if (evicted.length) await chrome.storage.local.remove(evicted.map(conversationKey));
}

export async function deleteConversation(id: string): Promise<void> {
  const index = (await listConversations()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [INDEX_KEY]: index });
  await chrome.storage.local.remove(conversationKey(id));
}

export async function listChanges(): Promise<StoredChange[]> {
  const stored = await chrome.storage.local.get("changes");
  return (stored.changes as StoredChange[] | undefined) ?? [];
}

export async function readUiState(): Promise<{ side: boolean }> {
  const stored = await chrome.storage.local.get("ui");
  return { side: false, ...((stored.ui as { side?: boolean } | undefined) ?? {}) };
}

export async function writeUiState(state: { side: boolean }): Promise<void> {
  await chrome.storage.local.set({ ui: state });
}
