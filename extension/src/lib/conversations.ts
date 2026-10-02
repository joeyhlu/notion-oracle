/**
 * Saved chats. The rules live here, pure; the content script applies them to chrome.storage.
 *
 * Each conversation is stored under its own key so saving one never rewrites the others, and a
 * small index lists them newest first. The provider's own history is kept beside the transcript
 * so a reopened chat continues with full context rather than just the visible text.
 */

import type { ProviderId, Source } from "../shared/types.ts";

export interface ToolLine {
  label: string;
  ok: boolean;
  write: boolean;
}

export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: ToolLine[]; sources?: Source[]; error?: string };

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  /** The provider's message history, or null when it was not kept. */
  history: unknown[] | null;
  transcript: TranscriptEntry[];
  /** The Notion page the chat started on. */
  pageTitle?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  pageTitle?: string;
}

export const MAX_CONVERSATIONS = 40;
export const INDEX_KEY = "conversations";
export const conversationKey = (id: string): string => `conv:${id}`;

export function newConversationId(now = Date.now()): string {
  return `c${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The first line of the first message, cut at a word boundary. */
export function titleFrom(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line || "New chat";
  const cut = line.lastIndexOf(" ", max);
  return `${line.slice(0, cut > max * 0.6 ? cut : max)}…`;
}

/**
 * Puts a conversation at the top of the index. Returns the new index and the ids that fell off
 * the end, whose stored bodies the caller deletes.
 */
export function upsertIndex(index: ConversationSummary[], summary: ConversationSummary, max = MAX_CONVERSATIONS): { index: ConversationSummary[]; evicted: string[] } {
  const rest = index.filter((c) => c.id !== summary.id);
  const next = [summary, ...rest];
  return { index: next.slice(0, max), evicted: next.slice(max).map((c) => c.id) };
}

export function summarize(conversation: Conversation): ConversationSummary {
  return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, pageTitle: conversation.pageTitle };
}

/** "Today", "Yesterday", "Previous 7 days", "Older": the groups the history list shows. */
export function ageGroup(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (then.getTime() >= startOfToday) return "Today";
  if (then.getTime() >= startOfToday - day) return "Yesterday";
  if (then.getTime() >= startOfToday - 7 * day) return "Previous 7 days";
  return "Older";
}

export const MAX_CHANGES = 100;
