/** Small DOM helpers and the icon set shared by the chat window and the AI menu. */

import { markSvg } from "../shared/mark.ts";
import { ICON_PATHS } from "../shared/icons.ts";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, size = 16): SVGSVGElement {
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
  path.setAttribute("d", ICON_PATHS[name] ?? ICON_PATHS.sparkle!);
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
