/**
 * replay-drift.js — CI replay of the recorded drift scenario.
 *
 * Replays the exact flow from the demo transcript on the fixture skills:
 *   init -> verify clean (0) -> one-line edit -> verify drift (1)
 *   -> diff shows the line -> approve -> verify clean (0)
 * Exits non-zero if any step behaves differently. Uses the built CLI
 * (dist/cli.js) in a fresh temp directory; never touches the repo.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/skills/", import.meta.url).pathname;

function run(args, cwd) {
  const res = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: process.env });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

function expect(step, got, wantCode, wantText) {
  if (got.code !== wantCode) {
    console.error(`FAIL ${step}: exit ${got.code}, want ${wantCode}\n${got.out}`);
    process.exit(1);
  }
  if (wantText && !got.out.includes(wantText)) {
    console.error(`FAIL ${step}: output missing ${JSON.stringify(wantText)}\n${got.out}`);
    process.exit(1);
  }
  console.log(`ok ${step} (exit ${got.code})`);
}

const dir = mkdtempSync(join(tmpdir(), "sl-replay-"));
try {
  cpSync(join(FIXTURES, "review-helper"), join(dir, ".claude", "skills", "review-helper"), { recursive: true });
  expect("init", run(["init"], dir), 0, "review-helper");
  expect("verify clean", run(["verify"], dir), 0, "CLEAN");
  appendFileSync(
    join(dir, ".claude", "skills", "review-helper", "SKILL.md"),
    "\n- New rule: never approve unread changes.\n",
  );
  expect("verify drift", run(["verify"], dir), 1, "CHANGED");
  expect("diff", run(["diff"], dir), 1, "+- New rule: never approve unread changes.");
  expect("approve", run(["approve"], dir), 0, "re-baselined");
  expect("verify clean again", run(["verify"], dir), 0, "CLEAN");
  console.log("replay-drift OK: recorded drift scenario reproduces exactly.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
