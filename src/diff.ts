import { markInvisible } from "./invisible.js";

interface Op {
  type: " " | "-" | "+";
  line: string;
}

/** Longest-common-subsequence diff on lines. Files here are small (skills), so O(n*m) is fine. */
function diffLines(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: " ", line: before[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: before[i] });
      i++;
    } else {
      ops.push({ type: "+", line: after[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", line: before[i++] });
  while (j < m) ops.push({ type: "+", line: after[j++] });
  return ops;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: Op[];
}

/** Group ops into unified hunks with 3 lines of context. */
export function toHunks(ops: Op[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const changedIdx = ops.map((op, i) => (op.type === " " ? -1 : i)).filter((i) => i >= 0);
  if (changedIdx.length === 0) return hunks;
  let start = Math.max(0, changedIdx[0] - context);
  let end = Math.min(ops.length, changedIdx[changedIdx.length - 1] + context + 1);
  // Split when the gap between changed regions exceeds 2 * context.
  let groupStart = start;
  let prev = changedIdx[0];
  const groups: Array<[number, number]> = [];
  for (const idx of changedIdx.slice(1)) {
    if (idx - prev > 2 * context) {
      groups.push([groupStart, Math.min(ops.length, prev + context + 1)]);
      groupStart = Math.max(0, idx - context);
    }
    prev = idx;
  }
  groups.push([groupStart, end]);
  for (const [gs, ge] of groups) {
    const slice = ops.slice(gs, ge);
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < gs; k++) {
      if (ops[k].type !== "+") oldLine++;
      if (ops[k].type !== "-") newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (const op of slice) {
      if (op.type !== "+") oldCount++;
      if (op.type !== "-") newCount++;
    }
    hunks.push({ oldStart: oldLine, oldCount, newStart: newLine, newCount, ops: slice });
  }
  return hunks;
}

/** Split into lines. A trailing newline ends the last line; it is not an extra empty line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Render a unified diff between baseline text and current text. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines).map((op) => ({
    ...op,
    line: markInvisible(op.line),
  }));
  const hunks = toHunks(ops);
  if (hunks.length === 0) return "";
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const op of h.ops) out.push(`${op.type}${op.line}`);
  }
  return out.join("\n");
}
