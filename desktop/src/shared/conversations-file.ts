/**
 * Conversations on disk: one JSON file each, under `conversations/` in userData.
 *
 * A file per conversation rather than one index: appending a message rewrites only that
 * conversation, and a file corrupted by a crash costs one conversation instead of the history.
 * Node-only — the renderer imports conversations.ts.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CONVERSATIONS, byRecency, summarize, type Conversation, type ConversationSummary } from "./conversations.ts";

const FILE = /^[\w-]+\.json$/;

export class ConversationStore {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, "conversations");
  }

  private path(id: string): string {
    // Ids are generated, never user input, but a traversal here would write anywhere on disk.
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  get(id: string): Conversation | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path(id), "utf8")) as Conversation;
      return parsed && Array.isArray(parsed.messages) ? parsed : null;
    } catch {
      return null;
    }
  }

  save(conversation: Conversation): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(conversation.id), JSON.stringify(conversation, null, 2));
    this.prune();
  }

  list(): ConversationSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of names) {
      if (!FILE.test(name)) continue;
      const conversation = this.get(name.replace(/\.json$/, ""));
      // An empty conversation is one the user opened and never used; it is not history.
      if (conversation?.messages.length) out.push(summarize(conversation));
    }
    return out.sort(byRecency);
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  /** Drops the oldest beyond the cap. Runs on save, so the folder cannot creep upward. */
  private prune(): void {
    const all = this.list();
    for (const stale of all.slice(MAX_CONVERSATIONS)) this.remove(stale.id);
  }
}
