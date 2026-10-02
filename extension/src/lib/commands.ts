/**
 * The AI menu: what Notion AI offers when you select text or press the AI shortcut on a line,
 * written down as data.
 *
 * Each command says where it appears (on a selection, at the cursor, or both), what its result
 * is for (replacing the selection, going in below it, or simply being read), and how to word
 * the request. Keeping this pure means the menu, its filtering and the exact prompt each item
 * sends are all testable without a browser.
 */

export type CommandScope = "selection" | "cursor";
/** replace: the result stands in for the selection. insert: it goes in below. answer: it is read. */
export type CommandOutput = "replace" | "insert" | "answer";
export type CommandGroup = "edit" | "generate" | "write" | "draft";

export interface CommandOption {
  label: string;
  value: string;
}

export interface AiCommand {
  id: string;
  label: string;
  group: CommandGroup;
  scope: CommandScope[];
  output: CommandOutput;
  /** Extra words the filter matches, so "grammar" finds "Fix spelling & grammar". */
  keywords?: string[];
  /** A second-level choice: a tone or a language. */
  options?: CommandOption[];
  /**
   * Draft commands need a subject. Choosing one puts this text in the input for the user to
   * finish ("Write a blog post about "), the way Notion AI does.
   */
  topicPrefix?: string;
  /** The instruction sent to the model; `option` is the chosen tone or language. */
  instruction: (option?: string) => string;
  /** Whether the open page is sent along. Edits of a selection do not need it. */
  needsPage?: boolean;
}

export const TONES: CommandOption[] = [
  { label: "Professional", value: "professional" },
  { label: "Casual", value: "casual" },
  { label: "Straightforward", value: "straightforward" },
  { label: "Confident", value: "confident" },
  { label: "Friendly", value: "friendly" },
];

/** The languages Notion AI lists, in its order, plus a few more people ask for. */
export const LANGUAGES: CommandOption[] = [
  "English", "Korean", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Spanish", "Russian", "French",
  "Portuguese", "German", "Italian", "Dutch", "Indonesian", "Filipino", "Vietnamese", "Arabic", "Hindi", "Turkish", "Polish", "Ukrainian",
].map((l) => ({ label: l, value: l }));

const SELECTION: CommandScope[] = ["selection"];
const CURSOR: CommandScope[] = ["cursor"];
const BOTH: CommandScope[] = ["selection", "cursor"];

export const COMMANDS: AiCommand[] = [
  // ---- Edit or review the selection ----
  { id: "improve", label: "Improve writing", group: "edit", scope: SELECTION, output: "replace", keywords: ["better", "polish", "rewrite"],
    instruction: () => "Improve the writing of the selected text. Make it clearer and better flowing, fix any mistakes, and keep the meaning, the language and roughly the length." },
  { id: "fix", label: "Fix spelling & grammar", group: "edit", scope: SELECTION, output: "replace", keywords: ["typo", "proofread", "correct"],
    instruction: () => "Fix the spelling, grammar and punctuation of the selected text. Change nothing else: keep the wording, tone and formatting." },
  { id: "shorter", label: "Make shorter", group: "edit", scope: SELECTION, output: "replace", keywords: ["shorten", "concise", "trim", "condense"],
    instruction: () => "Make the selected text noticeably shorter while keeping its key points and tone." },
  { id: "longer", label: "Make longer", group: "edit", scope: SELECTION, output: "replace", keywords: ["expand", "elaborate", "lengthen"],
    instruction: () => "Make the selected text longer by developing its ideas with relevant detail. Do not invent facts that are not implied by the text or the page." },
  { id: "tone", label: "Change tone", group: "edit", scope: SELECTION, output: "replace", options: TONES, keywords: ["voice", "formal", "style"],
    instruction: (tone) => `Rewrite the selected text in a ${tone ?? "professional"} tone. Keep the meaning and the language.` },
  { id: "simplify", label: "Simplify language", group: "edit", scope: SELECTION, output: "replace", keywords: ["simple", "plain", "easier"],
    instruction: () => "Rewrite the selected text in simpler, plainer language that anyone can follow. Keep the meaning." },
  { id: "translate", label: "Translate", group: "edit", scope: BOTH, output: "replace", options: LANGUAGES, keywords: ["language"],
    instruction: (language) => `Translate the text into ${language ?? "English"}. Keep the formatting, names and anything that should not be translated (code, URLs).`, needsPage: true },

  // ---- Generate from the selection ----
  { id: "explain", label: "Explain this", group: "generate", scope: SELECTION, output: "answer", keywords: ["what does", "meaning", "clarify"],
    instruction: () => "Explain the selected text in plain terms: what it means and why it matters. Be brief.", needsPage: true },
  { id: "summarize", label: "Summarize", group: "generate", scope: BOTH, output: "insert", keywords: ["tldr", "summary", "recap"],
    instruction: () => "Summarize the text in a few short bullet points that capture what matters.", needsPage: true },
  { id: "action-items", label: "Find action items", group: "generate", scope: BOTH, output: "insert", keywords: ["todo", "tasks", "next steps"],
    instruction: () => "List the action items, decisions that need making, and open questions in the text as a Markdown to-do list (- [ ] item). Include owners and dates where the text names them. If there are none, say so in one line.", needsPage: true },
  { id: "continue", label: "Continue writing", group: "write", scope: BOTH, output: "insert", keywords: ["more", "keep going", "next"],
    instruction: () => "Continue writing from where the text leaves off, matching its voice, format and language. Write one or two natural paragraphs (or list items, if it is a list). Do not repeat what is already there.", needsPage: true },

  // ---- Write with AI, at the cursor ----
  { id: "brainstorm", label: "Brainstorm ideas", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Brainstorm ideas for ", keywords: ["ideas"],
    instruction: () => "Brainstorm a varied list of ideas on the topic. Use a bulleted list with a short line of explanation for each." },
  { id: "outline", label: "Outline", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write an outline about ", keywords: ["structure"],
    instruction: () => "Write a clear outline on the topic using Markdown headings and nested bullets." },
  { id: "blog", label: "Blog post", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a blog post about ", keywords: ["article"],
    instruction: () => "Write a blog post on the topic with a title, short introduction, a few sections with headings and a conclusion." },
  { id: "meeting-agenda", label: "Meeting agenda", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a meeting agenda for ", keywords: ["meeting"],
    instruction: () => "Write a meeting agenda on the topic: goal, attendees placeholder, timed agenda items, and a to-do list for follow-ups." },
  { id: "pros-cons", label: "Pros and cons list", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a pros and cons list for ", keywords: ["compare", "tradeoffs"],
    instruction: () => "Write a balanced pros and cons list on the topic, under two headings, then a one-line takeaway." },
  { id: "todo", label: "To-do list", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a to-do list for ", keywords: ["checklist", "tasks"],
    instruction: () => "Write a practical to-do list for the topic as Markdown checkboxes (- [ ] item), in a sensible order." },
  { id: "email", label: "Email", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write an email about ", keywords: ["mail", "message"],
    instruction: () => "Write an email on the topic with a subject line, greeting, a concise body and a sign-off placeholder." },
  { id: "social", label: "Social media post", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a social media post about ", keywords: ["tweet", "linkedin", "post"],
    instruction: () => "Write a short, engaging social media post on the topic." },
  { id: "press", label: "Press release", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a press release about ", keywords: ["announcement", "pr"],
    instruction: () => "Write a press release on the topic: headline, dateline placeholder, lead paragraph, quote placeholder, details and boilerplate placeholder." },
  { id: "job", label: "Job description", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a job description for ", keywords: ["hiring", "role"],
    instruction: () => "Write a job description for the role: summary, responsibilities, requirements, nice-to-haves." },
  { id: "essay", label: "Essay", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write an essay about ", keywords: [],
    instruction: () => "Write a well-structured essay on the topic." },
  { id: "story", label: "Creative story", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a story about ", keywords: ["fiction"],
    instruction: () => "Write a short creative story on the topic." },
  { id: "poem", label: "Poem", group: "draft", scope: CURSOR, output: "insert", topicPrefix: "Write a poem about ", keywords: ["verse"],
    instruction: () => "Write a poem on the topic." },
];

export const GROUP_LABELS: Record<CommandGroup, string> = {
  edit: "Edit or review",
  generate: "Generate from selection",
  write: "Write",
  draft: "Draft with AI",
};

export function commandById(id: string): AiCommand | undefined {
  return COMMANDS.find((c) => c.id === id);
}

/** Commands for a menu opened on a selection or at the cursor, in display order. */
export function commandsFor(scope: CommandScope): AiCommand[] {
  return COMMANDS.filter((c) => c.scope.includes(scope));
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Narrows the menu as the user types. Every typed word has to start a word of the label or a
 * keyword, so "sho" finds "Make shorter" but "e" does not match everything.
 */
export function filterCommands(scope: CommandScope, query: string): AiCommand[] {
  const typed = words(query);
  const available = commandsFor(scope);
  if (!typed.length) return available;
  return available.filter((c) => {
    const hay = [...words(c.label), ...(c.keywords ?? []).flatMap(words)];
    return typed.every((t) => hay.some((h) => h.startsWith(t)));
  });
}

/** Options for a command with a second level, filtered the same way. */
export function filterOptions(command: AiCommand, query: string): CommandOption[] {
  const typed = words(query);
  const options = command.options ?? [];
  if (!typed.length) return options;
  return options.filter((o) => typed.every((t) => words(o.label).some((w) => w.startsWith(t))));
}

// ---------- the request ----------

/** How much of the open page goes along with a request. A page longer than this is cut. */
export const PAGE_BUDGET = 24000;

export interface InlineRequest {
  /** A catalogue command, or null for something the user typed. */
  command: AiCommand | null;
  option?: string;
  /** What the user typed: the whole request when there is no command, the topic for a draft. */
  typed?: string;
  selection: string;
  pageTitle: string;
  pageMarkdown?: string;
}

/**
 * The system prompt for the AI menu. Different from the chat's: the result goes straight into
 * a document, so it must be the text itself — no preamble, no "Here is your rewrite:".
 */
export function inlineSystemPrompt(customInstructions = ""): string {
  const parts = [
    "You are the writing assistant inside the user's Notion page, reached from the AI menu.",
    "Reply with only the requested text, ready to be placed in the document. No introduction, no closing remark, no quotation marks around it, no explanation of what you changed.",
    "Write Markdown that Notion understands: '# ' headings, '- ' bullets, '1. ' numbered lists, '- [ ] ' to-dos, '> ' quotes, **bold**, *italic*, `code`, fenced code blocks and pipe tables.",
    "When rewriting a selection, keep its language unless asked to translate, and keep its formatting (a list stays a list, a single line stays a single line).",
    "When the request is a question rather than writing, answer it directly and briefly.",
  ];
  if (customInstructions.trim()) parts.push("", "The user's standing instructions:", customInstructions.trim());
  return parts.join("\n");
}

function fence(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** Cuts a page to the budget on a line boundary and says it was cut. */
export function trimPage(markdown: string, budget = PAGE_BUDGET): string {
  if (markdown.length <= budget) return markdown;
  const cut = markdown.lastIndexOf("\n", budget);
  return `${markdown.slice(0, cut > budget * 0.8 ? cut : budget)}\n\n[… the rest of the page is not included]`;
}

/** The one user message an AI-menu request sends. */
export function buildInlinePrompt(req: InlineRequest): string {
  const { command } = req;
  const hasSelection = Boolean(req.selection.trim());
  const parts: string[] = [];
  const includePage = Boolean(req.pageMarkdown) && (!command || command.needsPage || !hasSelection);
  parts.push(`Page title: ${req.pageTitle || "Untitled"}`);
  if (includePage && req.pageMarkdown) parts.push(fence("page", trimPage(req.pageMarkdown)));
  if (hasSelection) parts.push(fence("selection", req.selection));

  let task: string;
  if (command?.topicPrefix) {
    const topic = (req.typed ?? "").trim();
    task = `${command.instruction(req.option)}\nTopic: ${topic || "(use the page as the topic)"}`;
  } else if (command) {
    task = command.instruction(req.option);
    // The selection is the text, when there is one; otherwise the page is.
    task += hasSelection ? " Work on the text in <selection>." : " Work on the page in <page>.";
    if (command.id === "continue" && !hasSelection) task += " Continue from the end of the page.";
  } else {
    task = (req.typed ?? "").trim();
    if (hasSelection) task += "\n(This is about the text in <selection>.)";
  }
  parts.push(fence("request", task));
  return parts.join("\n\n");
}

/** The follow-up message for "Tell AI what to do next…" after a result is shown. */
export function buildRefinement(instruction: string): string {
  return fence("request", `${instruction.trim()}\nApply this to your previous result and reply with the full revised text only.`);
}

/** Which action the result card leads with. */
export function primaryAction(command: AiCommand | null, hasSelection: boolean): "replace" | "insert" | "done" {
  if (command?.output === "answer") return "done";
  if (hasSelection && (command?.output === "replace" || !command)) return "replace";
  return "insert";
}
