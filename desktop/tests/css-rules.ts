import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Rule = { selector: string; body: string; /** Enclosing at-rule preludes, outermost first. */ context: string[] };

/**
 * Parses a stylesheet into flat rules, descending into at-rule blocks such as @media.
 *
 * The regex this replaces matched `(?:^|\})\s*([^{}]+)\{([^}]*)\}` globally, which consumes each
 * rule's closing brace as the *next* match's opening delimiter — so it saw only every other rule
 * and silently went blind to whichever half a later edit shifted a rule into. Guard tests that
 * quietly stop looking are worse than no guard, hence a real brace walk.
 */
export function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];

  const closingBrace = (open: number): number => {
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return j;
    }
    return src.length;
  };

  const walk = (from: number, to: number, context: string[]): void => {
    let prelude = "";
    let i = from;
    while (i < to) {
      if (src[i] !== "{") {
        prelude += src[i++];
        continue;
      }
      const close = closingBrace(i);
      const selector = prelude.trim().replace(/\s+/g, " ");
      if (selector.startsWith("@")) walk(i + 1, close, [...context, selector]);
      else if (selector) out.push({ selector, body: src.slice(i + 1, close), context });
      i = close + 1;
      prelude = "";
    }
  };

  walk(0, src.length, []);
  return out;
}

const dir = join(import.meta.dirname, "..", "src", "renderer");
export const stylesheet = readFileSync(join(dir, "styles.css"), "utf8");
export const markup = readFileSync(join(dir, "index.html"), "utf8");
export const rules = parseRules(stylesheet);

/** Declarations of the rule with exactly this selector list. Throws if there isn't exactly one. */
export function ruleBody(selector: string): string {
  const found = rules.filter((r) => r.selector === selector);
  if (found.length !== 1) {
    throw new Error(`expected exactly one rule for "${selector}", found ${found.length}`);
  }
  return found[0]!.body;
}
