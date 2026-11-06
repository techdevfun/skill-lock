import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

function run(args, cwd, extraEnv = {}) {
  const res = spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "sl-e2e-"));
  const skills = join(dir, ".claude", "skills", "review-helper");
  mkdirSync(join(skills, "scripts"), { recursive: true });
  writeFileSync(
    join(skills, "SKILL.md"),
    "---\nname: review-helper\ndescription: Review a pull request.\n---\n\n# Review Helper\n\nRead the diff, run checks, report findings.\n",
  );
  writeFileSync(join(skills, "scripts", "check.sh"), "#!/bin/sh\necho ok\n");
  return dir;
}

test("e2e: init -> verify clean -> edit -> verify drift -> diff -> approve -> verify clean", () => {
  const dir = setupProject();
  let r = run(["init"], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review-helper/);
  assert.ok(existsSync(join(dir, "skill-lock.json")));
  assert.ok(existsSync(join(dir, ".skill-lock", "baseline", ".claude", "skills", "review-helper", "SKILL.md")));

  r = run(["verify"], dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CLEAN/);

  appendFileSync(join(dir, ".claude", "skills", "review-helper", "SKILL.md"), "\n- New rule: never approve unread changes.\n");
  r = run(["verify"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /CHANGED/);
  assert.match(r.stdout, /DRIFT/);

  r = run(["diff"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\+- New rule: never approve unread changes\./);

  r = run(["approve"], dir);
  assert.equal(r.code, 0, r.stderr);
  r = run(["verify"], dir);
  assert.equal(r.code, 0, r.stdout);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: added and removed files are caught, and approve re-baselines them", () => {
  const dir = setupProject();
  assert.equal(run(["init"], dir).code, 0);
  writeFileSync(join(dir, ".claude", "skills", "review-helper", "notes.md"), "extra\n");
  let r = run(["verify"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /NEW/);
  r = run(["approve"], dir);
  assert.equal(r.code, 0);
  assert.equal(run(["verify"], dir).code, 0);

  rmSync(join(dir, ".claude", "skills", "review-helper", "scripts", "check.sh"));
  r = run(["verify"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /REMOVED/);
  assert.equal(run(["approve"], dir).code, 0);
  assert.equal(run(["verify"], dir).code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: exit code 2 for usage and config errors", () => {
  const dir = setupProject();
  // No lockfile yet.
  let r = run(["verify"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /skill-lock\.json/);
  // Unknown command.
  r = run(["frobnicate"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command/);
  // Unknown flag.
  r = run(["init", "--nope"], dir);
  assert.equal(r.code, 2);
  // Second init refuses to overwrite the baseline.
  assert.equal(run(["init"], dir).code, 0);
  r = run(["init"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already exists/);
  // Unknown skill.
  r = run(["verify", "no-such-skill"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no such skill/);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: verify --format json is machine-readable", () => {
  const dir = setupProject();
  assert.equal(run(["init"], dir).code, 0);
  const r = run(["verify", "--format", "json"], dir);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.summary.ok, 2);
  assert.equal(parsed.summary.changed, 0);
  assert.equal(parsed.rows.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: verify output never prints file contents (no secret leakage)", () => {
  const dir = setupProject();
  // The well-known AWS example access key — a documented fake, used here
  // only to prove the tool never echoes skill contents in its output.
  const fakeSecret = "AKIAIOSFODNN7EXAMPLE";
  appendFileSync(join(dir, ".claude", "skills", "review-helper", "SKILL.md"), `\nExample key: ${fakeSecret}\n`);
  assert.equal(run(["init"], dir).code, 0);
  let r = run(["verify"], dir);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes(fakeSecret), "verify printed file contents");
  appendFileSync(join(dir, ".claude", "skills", "review-helper", "SKILL.md"), "x");
  r = run(["verify"], dir);
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes(fakeSecret), "verify printed file contents on drift");
  // diff is the one command that shows lines by design (the human review
  // surface), but it is scoped to the changed hunks — it must not dump
  // the whole file. The unchanged header line must not appear.
  r = run(["diff"], dir);
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes("# Review Helper"), "diff dumped unchanged lines");
  assert.match(r.stdout, /^\+x$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: diff flags invisible characters in a tampered file", () => {
  const dir = setupProject();
  assert.equal(run(["init"], dir).code, 0);
  const skillFile = join(dir, ".claude", "skills", "review-helper", "SKILL.md");
  const original = readFileSync(skillFile, "utf8");
  writeFileSync(skillFile, original.replace("report findings", "report\u{E0001} findings"));
  let r = run(["verify"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /non-printing/);
  r = run(["diff"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /U\+E0001/);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: loose instruction files (AGENTS.md) are pinned too", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-e2e-loose-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Agent instructions\n\nKeep changes small.\n");
  const r = run(["init", "AGENTS.md"], dir);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(dir, "skill-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.files), ["AGENTS.md"]);
  assert.equal(run(["verify"], dir).code, 0);
  appendFileSync(join(dir, "AGENTS.md"), "x");
  assert.equal(run(["verify"], dir).code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("e2e: --version and --help work", () => {
  const r1 = run(["--version"], tmpdir());
  assert.equal(r1.code, 0);
  assert.match(r1.stdout, /skill-lock 0\.1\.0/);
  const r2 = run(["--help"], tmpdir());
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /skill-lock init/);
});
