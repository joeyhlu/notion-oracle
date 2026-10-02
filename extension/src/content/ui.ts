/** Small DOM helpers and the icon set shared by the chat window and the AI menu. */

import { markSvg } from "../shared/mark.ts";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 16px line icons, drawn on a 16-unit grid with a 1.5 stroke so they sit with Notion's own. */
const PATHS: Record<string, string> = {
  plus: "M8 3.5v9M3.5 8h9",
  history: "M2.75 8a5.25 5.25 0 1 0 1.6-3.77M2.5 2.75v2.5H5M8 5.25V8l1.9 1.4",
  close: "M4 4l8 8M12 4l-8 8",
  sliders: "M2.75 5h6M12.25 5h1M2.75 11h1M6.75 11h6.5M10.5 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5.25 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  settings: "M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2ZM13.1 9.5l.9.6-1.2 2.1-1-.4a4.8 4.8 0 0 1-1.4.8l-.2 1.1H7.8l-.2-1.1a4.8 4.8 0 0 1-1.4-.8l-1 .4L4 10.1l.9-.6a4.9 4.9 0 0 1 0-1.6L4 7.3 5.2 5.2l1 .4a4.8 4.8 0 0 1 1.4-.8l.2-1.1h2.4l.2 1.1c.5.2 1 .5 1.4.8l1-.4 1.2 2.1-.9.6c.1.5.1 1.1 0 1.6Z",
  expand: "M9.5 2.75h3.75V6.5M6.5 13.25H2.75V9.5M13.25 2.75 9 7M2.75 13.25 7 9",
  collapse: "M13.25 2.75 9.5 6.5M9.5 3v3.5H13M2.75 13.25 6.5 9.5M6.5 13V9.5H3",
  send: "M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25",
  stop: "M5 5h6v6H5z",
  globe: "M8 13.25A5.25 5.25 0 1 0 8 2.75a5.25 5.25 0 0 0 0 10.5ZM2.9 6.25h10.2M2.9 9.75h10.2M8 2.75c-1.5 1.6-2.2 3.3-2.2 5.25S6.5 11.65 8 13.25M8 2.75c1.5 1.6 2.2 3.3 2.2 5.25S9.5 11.65 8 13.25",
  at: "M10.6 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Zm0 0v.9a1.65 1.65 0 0 0 3.3 0V8A5.9 5.9 0 1 0 11 13.1",
  page: "M4.25 2.25h4.9l2.6 2.6v8.9h-7.5zM9 2.5V5h2.5M6 8h4M6 10.5h3",
  database: "M2.75 3.25h10.5v9.5H2.75zM2.75 6.5h10.5M6.5 6.5v6.25",
  check: "M3.5 8.4 6.5 11.25 12.5 4.75",
  copy: "M5.75 5.75h6.5v6.5h-6.5zM3.75 10.25v-6.5h6.5",
  retry: "M12.6 6.25A4.75 4.75 0 1 0 12.75 9M12.9 3.25V6.5H9.6",
  undo: "M5.5 4.25 2.75 7l2.75 2.75M3 7h6.5a3.5 3.5 0 0 1 0 7H7",
  chevron: "M6.25 4 10.25 8l-4 4",
  back: "M9.75 4 5.75 8l4 4",
  insert: "M3 3.5h10M3 12.5h10M8 6v4.5M5.9 8.5 8 10.6l2.1-2.1",
  replace: "M3 5.25h7.5M8.5 3l2.25 2.25L8.5 7.5M13 10.75H5.5M7.5 8.5l-2.25 2.25L7.5 13",
  trash: "M3 4.5h10M6.25 4.5V3h3.5v1.5M4.5 4.5l.6 8.75h5.8l.6-8.75",
  edit: "M10.6 2.9l2.5 2.5L6 12.5l-3.25.75L3.5 10Z",
  sparkle: "M8 2.5v11M2.5 8h11",
  list: "M5.75 4.5h7.5M5.75 8h7.5M5.75 11.5h7.5M2.75 4.5h.5M2.75 8h.5M2.75 11.5h.5",
  todo: "M2.75 3.75h3.5v3.5h-3.5zM8.25 5.5h5M2.75 9.25h3.5v3.5h-3.5zM8.25 11h5",
  translate: "M2.75 3.75h6.5M6 2.5v1.25M8.1 3.75C7.4 6.3 5.6 8.3 3.1 9.5M4.6 5.6c.8 1.6 2 2.8 3.4 3.7M8.5 13.5l2.25-5.75L13 13.5M9.3 11.5h2.9",
  tone: "M3 9.5c1.25-2.5 2.5-2.5 3.75 0s2.5 2.5 3.75 0 1.75-2 2.5-1.25",
  shorter: "M3 5.5h10M3 8h6M3 10.5h3.5",
  longer: "M3 4.5h10M3 7h10M3 9.5h10M3 12h6",
  question: "M6.1 6.1a1.95 1.95 0 1 1 2.6 1.85c-.5.2-.7.6-.7 1.05v.5M8 11.5v.25M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Z",
  pen: "M3 13h2.5l7.25-7.25-2.5-2.5L3 10.5ZM9.25 4.25l2.5 2.5",
  grammar: "M2.75 11.5 5.5 4.5l2.75 7M3.75 9h3.5M9.75 9.5l1.5 1.75 2.5-3.5",
  summarize: "M3 4h10M3 7h10M3 10h6M11 10l1.25 1.25L14 9.25",
  arrowRight: "M3.5 8h9M8.75 4.25 12.5 8l-3.75 3.75",
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.sparkle!);
  if (name === "stop") {
    path.setAttribute("fill", "currentColor");
  }
  svg.appendChild(path);
  return svg;
}

/** The Oracle mark as an element. */
export function mark(size: number, tile = true): HTMLElement {
  const wrap = el("span", "mark");
  wrap.innerHTML = markSvg(size, { tile });
  return wrap;
}

export function iconButton(name: string, label: string, onClick: () => unknown, className = "icon-btn"): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  button.append(icon(name));
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    void onClick();
  });
  return button;
}

/** A labelled button with a leading icon: "Insert below", "Copy". */
export function textButton(name: string, label: string, onClick: () => unknown, className = "btn"): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  if (name) button.append(icon(name));
  button.append(el("span", "", label));
  button.addEventListener("click", (e) => {
    e.preventDefault();
    void onClick();
  });
  return button;
}

/** Icon per AI command, so the menu scans like Notion's. */
export const COMMAND_ICONS: Record<string, string> = {
  improve: "pen", fix: "grammar", shorter: "shorter", longer: "longer", tone: "tone", simplify: "edit", translate: "translate",
  explain: "question", summarize: "summarize", "action-items": "todo", continue: "arrowRight",
  brainstorm: "sparkle", outline: "list", blog: "page", "meeting-agenda": "list", "pros-cons": "list", todo: "todo", email: "page",
  social: "page", press: "page", job: "page", essay: "page", story: "page", poem: "page",
};

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
