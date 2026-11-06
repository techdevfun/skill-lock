import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { sha256File, sha256Text } from "../dist/hash.js";
import { unifiedDiff } from "../dist/diff.js";
import { countInvisible, markInvisible } from "../dist/invisible.js";
import {
  discover,
  hashFiles,
  loadLockfile,
  saveLockfile,
  verifyLockfile,
  approveLockfile,
} from "../dist/lockfile.js";
import { extractRefs } from "../dist/refs.js";

const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

test("hash: sha256 of known bytes matches the well-known digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-hash-"));
  const file = join(dir, "abc.txt");
  writeFileSync(file, "abc");
  assert.equal(sha256File(file), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  rmSync(dir, { recursive: true, force: true });
});

test("hash: one changed byte changes the digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-hash1-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "abc");
  const before = sha256File(file);
  writeFileSync(file, "abd");
  assert.notEqual(sha256File(file), before);
  rmSync(dir, { recursive: true, force: true });
});

test("diff: unified diff shows the changed lines with context", () => {
  const before = "one\ntwo\nthree\nfour\nfive\n";
  const after = "one\ntwo\nTHREE\nfour\nfive\n";
  const out = unifiedDiff("SKILL.md", before, after);
  assert.match(out, /^--- a\/SKILL\.md$/m);
  assert.match(out, /^\+\+\+ b\/SKILL\.md$/m);
  assert.match(out, /^@@ -1,5 \+1,5 @@$/m);
  assert.match(out, /^-three$/m);
  assert.match(out, /^\+THREE$/m);
  assert.match(out, /^ two$/m);
});

test("diff: identical files produce no output", () => {
  assert.equal(unifiedDiff("SKILL.md", "a\nb\n", "a\nb\n"), "");
});

test("diff: added and removed lines are grouped into hunks", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
  const after = before.replace("line2", "LINE2").replace("line17", "LINE17");
  const out = unifiedDiff("x.md", before, after);
  // Two far-apart changes must produce two hunks, not one giant hunk.
  assert.equal(out.match(/^@@/gm).length, 2);
});

test("invisible: tag and zero-width characters are counted and marked", () => {
  const text = "clean\u{E0001}text\u200Bmore";
  assert.equal(countInvisible(text), 2);
  assert.equal(markInvisible(text), "clean⟦U+E0001⟧text⟦U+200B⟧more");
  assert.equal(countInvisible("plain ascii"), 0);
});

test("refs: npm install lines map to the npm registry", () => {
  const refs = extractRefs("    npm install prettier\n    npm install -g typescript@5.6.3\n", "SKILL.md");
  assert.deepEqual(
    refs.map((r) => [r.name, r.registry]),
    [
      ["prettier", "npm"],
      ["typescript", "npm"],
    ],
  );
});

test("refs: pip install lines map to PyPI, version specifiers stripped", () => {
  const refs = extractRefs("    pip install requests==2.32.0\n    pip3 install numpy\n", "SKILL.md");
  assert.deepEqual(
    refs.map((r) => [r.name, r.registry]),
    [
      ["requests", "pypi"],
      ["numpy", "pypi"],
    ],
  );
});

test("refs: require/import map to npm; JS import-from never becomes a PyPI ref", () => {
  const refs = extractRefs(
    "const p = require('prettier');\nimport fs from 'node:fs';\nimport { x } from 'lodash';\n",
    "SKILL.md",
  );
  assert.deepEqual(
    refs.map((r) => [r.name, r.registry]),
    [
      ["prettier", "npm"],
      ["lodash", "npm"],
    ],
  );
});

test("refs: Python imports map to PyPI, stdlib is skipped", () => {
  const refs = extractRefs("import requests\nimport os\nfrom urllib.parse import urlparse\n", "SKILL.md");
  assert.deepEqual(
    refs.map((r) => [r.name, r.registry]),
    [["requests", "pypi"]],
  );
});

test("refs: URLs are extracted and trailing punctuation trimmed", () => {
  const refs = extractRefs("See https://example.com/docs, and https://api.example.org/v1.\n", "SKILL.md");
  assert.deepEqual(
    refs.map((r) => [r.name, r.registry]),
    [
      ["https://example.com/docs", "url"],
      ["https://api.example.org/v1", "url"],
    ],
  );
});

test("lockfile: init round trip verifies clean, then catches one-byte drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-lock-"));
  const skillsDir = join(dir, ".claude", "skills");
  mkdirSync(join(skillsDir, "review-helper"), { recursive: true });
  writeFileSync(join(skillsDir, "review-helper", "SKILL.md"), "# Review\n");
  const { skills, files } = discover([".claude/skills"], dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "review-helper");
  assert.deepEqual(files, []);
  const lock = {
    version: 1,
    generatedBy: "skill-lock 0.1.0",
    approvedBy: "tester",
    approvedAt: "2026-11-06T00:00:00.000Z",
    skills: {
      "review-helper": {
        path: skills[0].relDir,
        files: hashFiles(skills[0].absDir, skills[0].files),
      },
    },
    files: {},
  };
  const lockPath = join(dir, "skill-lock.json");
  saveLockfile(lockPath, lock);
  const loaded = loadLockfile(lockPath);
  let result = verifyLockfile(loaded, dir);
  assert.equal(result.ok, 1);
  assert.equal(result.changed, 0);
  // One-byte edit must be caught.
  appendFileSync(join(skillsDir, "review-helper", "SKILL.md"), "x");
  result = verifyLockfile(loaded, dir);
  assert.equal(result.changed, 1);
  assert.equal(result.rows[0].status, "CHANGED");
  // Approve re-baselines; verify is clean again.
  approveLockfile(loaded, dir, "tester");
  result = verifyLockfile(loaded, dir);
  assert.equal(result.ok, 1);
  assert.equal(result.changed, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("lockfile: added and removed files are reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-lock2-"));
  const skillsDir = join(dir, ".claude", "skills", "review-helper");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "SKILL.md"), "# Review\n");
  const { skills } = discover([".claude/skills"], dir);
  const lock = {
    version: 1,
    generatedBy: "skill-lock 0.1.0",
    approvedBy: "tester",
    approvedAt: "2026-11-06T00:00:00.000Z",
    skills: {
      "review-helper": {
        path: skills[0].relDir,
        files: hashFiles(skills[0].absDir, skills[0].files),
      },
    },
    files: {},
  };
  writeFileSync(join(skillsDir, "scripts.sh"), "echo hi\n");
  let result = verifyLockfile(lock, dir);
  assert.equal(result.added, 1);
  assert.equal(result.rows.find((r) => r.file === "scripts.sh")?.status, "NEW");
  rmSync(join(skillsDir, "SKILL.md"));
  result = verifyLockfile(lock, dir);
  assert.equal(result.removed, 1);
  assert.equal(result.rows.find((r) => r.file === "SKILL.md")?.status, "REMOVED");
  rmSync(dir, { recursive: true, force: true });
});

test("lockfile: skill name comes from SKILL.md frontmatter", () => {
  const { skills } = discover([join(FIXTURES, "skills")], FIXTURES);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["deploy-notes", "refs-demo", "review-helper"]);
});

/** Local registry stand-in: npm and PyPI shapes on one server. */
function startRegistryServer() {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/prettier") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "prettier" }));
    } else if (url === "/pypi/requests/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ info: { name: "requests" } }));
    } else if (url === "/ok") {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolveServer({ server, port });
    });
  });
}

test("check-refs: local registry stand-in distinguishes real from ghost", async () => {
  const { server, port } = await startRegistryServer();
  process.env.SKILL_LOCK_NPM_REGISTRY = `http://127.0.0.1:${port}`;
  process.env.SKILL_LOCK_PYPI_BASE = `http://127.0.0.1:${port}`;
  const { checkRefs } = await import("../dist/refs.js");
  const dir = mkdtempSync(join(tmpdir(), "sl-refs-"));
  const result = await checkRefs(
    [
      { name: "prettier", registry: "npm", source: "SKILL.md:1" },
      { name: "skill-lock-demo-ghost-9x7q", registry: "npm", source: "SKILL.md:2" },
      { name: "requests", registry: "pypi", source: "SKILL.md:3" },
      { name: "no-such-pkg-9x7q", registry: "pypi", source: "SKILL.md:4" },
      { name: `http://127.0.0.1:${port}/ok`, registry: "url", source: "SKILL.md:5" },
      { name: `http://127.0.0.1:${port}/gone`, registry: "url", source: "SKILL.md:6" },
    ],
    { offline: false, allowlist: new Set(), cwd: dir },
  );
  assert.equal(result.exists, 3);
  assert.equal(result.missing, 3);
  const byName = Object.fromEntries(result.findings.map((f) => [f.name, f.status]));
  assert.equal(byName["prettier"], "EXISTS");
  assert.equal(byName["skill-lock-demo-ghost-9x7q"], "MISSING");
  assert.equal(byName["requests"], "EXISTS");
  assert.equal(byName["no-such-pkg-9x7q"], "MISSING");
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("check-refs: offline mode reads the snapshot; unknown names do not fail", async () => {
  const { server, port } = await startRegistryServer();
  process.env.SKILL_LOCK_NPM_REGISTRY = `http://127.0.0.1:${port}`;
  process.env.SKILL_LOCK_PYPI_BASE = `http://127.0.0.1:${port}`;
  const { checkRefs } = await import("../dist/refs.js");
  const dir = mkdtempSync(join(tmpdir(), "sl-off-"));
  // Online run writes the snapshot.
  await checkRefs(
    [{ name: "prettier", registry: "npm", source: "SKILL.md:1" }],
    { offline: false, allowlist: new Set(), cwd: dir },
  );
  // Offline run: known name resolves from the snapshot, unknown stays UNKNOWN.
  const result = await checkRefs(
    [
      { name: "prettier", registry: "npm", source: "SKILL.md:1" },
      { name: "never-checked-9x7q", registry: "npm", source: "SKILL.md:2" },
    ],
    { offline: true, allowlist: new Set(), cwd: dir },
  );
  assert.equal(result.exists, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.missing, 0);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("check-refs: allowlisted names never fail", async () => {
  const { server, port } = await startRegistryServer();
  process.env.SKILL_LOCK_NPM_REGISTRY = `http://127.0.0.1:${port}`;
  process.env.SKILL_LOCK_PYPI_BASE = `http://127.0.0.1:${port}`;
  const { checkRefs } = await import("../dist/refs.js");
  const dir = mkdtempSync(join(tmpdir(), "sl-allow-"));
  const result = await checkRefs(
    [{ name: "internal-only-pkg", registry: "npm", source: "SKILL.md:1" }],
    { offline: false, allowlist: new Set(["internal-only-pkg"]), cwd: dir },
  );
  assert.equal(result.allowed, 1);
  assert.equal(result.missing, 0);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("hash: createHash sanity — test file itself is not the product", () => {
  assert.equal(createHash("sha256").update("abc").digest("hex"), sha256Text("abc"));
});
