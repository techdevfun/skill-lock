import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

/** True when the npm registry answers at all; false means offline. */
async function registryReachable() {
  try {
    const res = await fetch("https://registry.npmjs.org/prettier", {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function run(args, cwd) {
  const res = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: process.env });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("live: check-refs on the real registries finds the ghost and keeps the real ones", async (t) => {
  if (!(await registryReachable())) {
    t.skip("npm registry unreachable — offline");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "sl-live-"));
  cpSync(join(FIXTURES, "skills", "refs-demo"), join(dir, "skills", "refs-demo"), { recursive: true });
  let r = run(["init", "skills"], dir);
  assert.equal(r.code, 0, r.stderr);
  r = run(["check-refs"], dir);
  assert.equal(r.code, 1, "a ghost reference must fail the gate");
  assert.match(r.stdout, /skill-lock-demo-ghost-9x7q/);
  assert.match(r.stdout, /MISSING/);
  assert.match(r.stdout, /prettier/);
  assert.match(r.stdout, /EXISTS/);
  assert.match(r.stdout, /requests/);
  assert.match(r.stdout, /example\.com/);
  rmSync(dir, { recursive: true, force: true });
});

test("live: the package name skill-lock is not yet taken on npm", async (t) => {
  if (!(await registryReachable())) {
    t.skip("npm registry unreachable — offline");
    return;
  }
  const res = await fetch("https://registry.npmjs.org/skill-lock", {
    method: "GET",
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(res.status, 404, "npm name skill-lock must still be free");
});
