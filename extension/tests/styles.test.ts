import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Selectors per at-rule context, from a brace-walking read of the stylesheet. */
function selectors(css: string): Array<{ selector: string; context: string }> {
  const out: Array<{ selector: string; context: string }> = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  let buffer = "";
  for (const ch of text) {
    if (ch === "{") {
      const head = buffer.trim();
      buffer = "";
      if (head.startsWith("@")) stack.push(head);
      else {
        if (!stack.some((s) => s.startsWith("@keyframes"))) out.push({ selector: head.replace(/\s+/g, " "), context: stack.join(" ") });
        stack.push(head);
      }
    } else if (ch === "}") {
      stack.pop();
      buffer = "";
    } else buffer += ch;
  }
  return out;
}

for (const file of ["src/content/panel.css", "src/options/options.css"]) {
  test(`${file}: every selector is declared once per context`, () => {
    const seen = new Map<string, number>();
    for (const { selector, context } of selectors(readFileSync(join(import.meta.dirname, "..", file), "utf8"))) {
      const key = `${context}|${selector}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const repeated = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(repeated, []);
  });
}

test("[hidden] beats any class that sets display", () => {
  for (const file of ["src/content/panel.css", "src/options/options.css"]) {
    assert.match(readFileSync(join(import.meta.dirname, "..", file), "utf8"), /\[hidden\] \{ display: none !important; \}/, file);
  }
});

test("no rule positions every element that has a tooltip", () => {
  // `[data-tip] { position: relative }` once outranked `.fab { position: fixed }` and left the
  // floating button half off the left edge of the page.
  const css = readFileSync(join(import.meta.dirname, "..", "src/content/panel.css"), "utf8");
  assert.doesNotMatch(css, /^\[data-tip\]\s*\{[^}]*position/m);
});

test("no serif anywhere, and no display sizes in the panel inside Notion", () => {
  const panel = readFileSync(join(import.meta.dirname, "..", "src/content/panel.css"), "utf8");
  const setup = readFileSync(join(import.meta.dirname, "..", "src/options/options.css"), "utf8");
  assert.doesNotMatch(panel + setup, /(?<!sans-)serif|Georgia|Tiempos|Charter|Times/i);
  // The setup page is drawn as a Notion page and carries its 40px title; the panel sits inside
  // someone's page and must stay at UI sizes.
  const sizes = [...panel.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...sizes) <= 16, `largest panel font size ${Math.max(...sizes)}px`);
});
