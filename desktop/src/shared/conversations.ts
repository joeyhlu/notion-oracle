/**
 * Saved conversations.
 *
 * The CLI keeps its own session state and can resume it by id, so the only thing lost when Oracle
 * quits is the app's memory of which id belonged to which conversation, and the transcript it had
 * drawn. Both are small; they live in one JSON file per conversation under userData.
 *
 * Pure shapes and helpers, so the renderer can import them; the store is conversations-file.ts.
 */

export interface Message {
  role: "user" | "assistant";
  text: string;
}

export interface Conversation {
  id: string;
  /** The CLI's own session id, which is what makes resuming possible. Null until the first reply. */
  threadId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Keeps the folder bounded; the picker only ever shows the recent ones. */
export const MAX_CONVERSATIONS = 50;

export function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A conversation is named after its opening line, which is what people recognise it by.
 *
 * Trimmed on a word boundary so the picker does not show half a word, and newlines collapsed
 * because a pasted block of text would otherwise make the title unreadable.
 */
export function titleFrom(text: string, limit = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New conversation";
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function summarize(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
  };
}

/** Newest first, which is the order a history list is read in. */
export function byRecency(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}
