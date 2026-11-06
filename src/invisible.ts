/**
 * Non-printing characters that can hide inside skill text: Unicode tag
 * characters (U+E0000–U+E007F), zero-width and formatting characters,
 * and bidi controls. v0.1.0 reports them as visible markers in diff
 * output; full linting is roadmap.
 */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/u;

export function countInvisible(text: string): number {
  let n = 0;
  for (const ch of text) if (INVISIBLE.test(ch)) n++;
  return n;
}

/** Replace each non-printing character with a visible marker, e.g. ⟨U+E0001⟩. */
export function markInvisible(text: string): string {
  let out = "";
  for (const ch of text) {
    if (INVISIBLE.test(ch)) {
      out += `⟦U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`;
    } else {
      out += ch;
    }
  }
  return out;
}
