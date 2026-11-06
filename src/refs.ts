import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckRefsResult, RefFinding, RefRegistry, RefStatus } from "./types.js";
import { SNAPSHOT_FILE } from "./lockfile.js";

// Env overrides are read per call (not at module load) so tests and
// long-lived processes can point at a local registry mirror.
function npmBase(): string {
  return process.env.SKILL_LOCK_NPM_REGISTRY ?? "https://registry.npmjs.org";
}
function pypiBase(): string {
  return process.env.SKILL_LOCK_PYPI_BASE ?? "https://pypi.org";
}
const FETCH_TIMEOUT_MS = 10_000;

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "timers", "tls", "tty", "url",
  "util", "v8", "vm", "worker_threads", "zlib",
]);

const PYTHON_STDLIB = new Set([
  "__future__", "abc", "argparse", "ast", "asyncio", "atexit", "base64", "binascii",
  "bisect", "builtins", "bz2", "calendar", "cmath", "cmd", "code", "codecs",
  "codeop", "collections", "colorsys", "compileall", "concurrent", "configparser",
  "contextlib", "contextvars", "copy", "copyreg", "csv", "ctypes", "curses",
  "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis", "distutils",
  "doctest", "email", "encodings", "enum", "errno", "faulthandler", "fcntl",
  "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools", "gc",
  "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib",
  "heapq", "hmac", "html", "http", "imaplib", "importlib", "inspect", "io",
  "ipaddress", "itertools", "json", "keyword", "linecache", "locale", "logging",
  "lzma", "mailbox", "marshal", "math", "mimetypes", "mmap", "multiprocessing",
  "numbers", "operator", "optparse", "os", "pathlib", "pdb", "pickle", "pipes",
  "pkgutil", "platform", "plistlib", "poplib", "pprint", "profile", "pstats",
  "pty", "pwd", "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random",
  "re", "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched",
  "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal",
  "site", "smtplib", "socket", "socketserver", "sqlite3", "ssl", "stat",
  "statistics", "string", "struct", "subprocess", "sys", "sysconfig", "syslog",
  "tabnanny", "tarfile", "telnetlib", "tempfile", "termios", "textwrap",
  "threading", "time", "timeit", "tkinter", "token", "tokenize", "tomllib",
  "trace", "traceback", "tracemalloc", "tty", "turtle", "types", "typing",
  "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings", "wave",
  "weakref", "webbrowser", "winreg", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib",
]);

export interface RawRef {
  name: string;
  registry: RefRegistry;
  source: string;
}

function cleanVersionToken(token: string): string | null {
  const t = token.trim().replace(/,$/, "");
  if (!t || t.startsWith("-") || t.startsWith("@") && t === "@") return null;
  // Strip version specifiers: pkg@1.2.3, pkg>=1.0, pkg==1.0, pkg[extra].
  const m = t.match(/^(@?[^@<>=!~\s\[]+)(?:\[[^\]]*\])?/);
  if (!m) return null;
  const name = m[1];
  if (!/^[a-z0-9@][a-z0-9._\-/]*$/i.test(name)) return null;
  if (name.startsWith(".") || name.startsWith("/")) return null;
  return name;
}

function npmNameOk(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("/")) return false;
  if (name.startsWith("node:")) return false;
  const base = name.startsWith("@") ? name.split("/")[1] ?? "" : name;
  return !NODE_BUILTINS.has(base) && !NODE_BUILTINS.has(name);
}

/** Extract package and URL references from one skill file's text. */
export function extractRefs(text: string, source: string): RawRef[] {
  const refs: RawRef[] = [];
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const at = `${source}:${idx + 1}`;
    // npm install / npx
    const npmInstall = line.match(/^\s*(?:npm\s+(?:install|i)|npx)\s+(.+)$/);
    if (npmInstall) {
      const rest = npmInstall[1].split(/&&|\||;/)[0];
      for (const tok of rest.split(/\s+/)) {
        const name = cleanVersionToken(tok);
        if (name && npmNameOk(name)) refs.push({ name, registry: "npm", source: at });
      }
    }
    // pip install
    const pipInstall = line.match(/^\s*pip3?\s+install\s+(.+)$/);
    if (pipInstall) {
      const rest = pipInstall[1].split(/&&|\||;/)[0];
      for (const tok of rest.split(/\s+/)) {
        if (tok === "-r" || tok.startsWith("-")) continue;
        const name = cleanVersionToken(tok);
        if (name) refs.push({ name, registry: "pypi", source: at });
      }
    }
    // require('pkg')
    for (const m of line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (npmNameOk(m[1])) refs.push({ name: m[1], registry: "npm", source: at });
    }
    // import ... from 'pkg' / import 'pkg'
    for (const m of line.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (npmNameOk(m[1])) refs.push({ name: m[1], registry: "npm", source: at });
    }
    for (const m of line.matchAll(/^\s*import\s+['"]([^'"]+)['"]/g)) {
      if (npmNameOk(m[1])) refs.push({ name: m[1], registry: "npm", source: at });
    }
    // Python: import x / from x import y
    const pyFrom = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
    if (pyFrom) {
      const top = pyFrom[1].split(".")[0];
      if (!PYTHON_STDLIB.has(top)) refs.push({ name: top, registry: "pypi", source: at });
    }
    const pyImport = line.match(/^\s*import\s+([\w.]+)/);
    // JS `import x from '...'` has quotes / a `from` — never a Python import.
    if (pyImport && !pyFrom && !/['"]/.test(line) && !/\bfrom\b/.test(line)) {
      const top = pyImport[1].split(".")[0];
      if (!PYTHON_STDLIB.has(top)) refs.push({ name: top, registry: "pypi", source: at });
    }
    // URLs
    for (const m of line.matchAll(/https?:\/\/[^\s)'"`\]}>,;]+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      refs.push({ name: url, registry: "url", source: at });
    }
  });
  return refs;
}

/** Extract refs from a package.json / requirements.txt inside a skill dir. */
export function extractRefsFromManifests(skillDir: string, skillName: string): RawRef[] {
  const refs: RawRef[] = [];
  const pkgJson = join(skillDir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const dep of Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })) {
        refs.push({ name: dep, registry: "npm", source: `${skillName}/package.json` });
      }
    } catch {
      // A broken package.json is the skill author's problem, not a ref.
    }
  }
  const reqTxt = join(skillDir, "requirements.txt");
  if (existsSync(reqTxt)) {
    for (const line of readFileSync(reqTxt, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("-")) continue;
      const name = cleanVersionToken(t);
      if (name) refs.push({ name, registry: "pypi", source: `${skillName}/requirements.txt` });
    }
  }
  return refs;
}

async function checkOne(ref: RawRef): Promise<RefStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    if (ref.registry === "npm") {
      const res = await fetch(`${npmBase()}/${encodeURIComponent(ref.name)}`, {
        signal: controller.signal,
      });
      return res.status === 200 ? "EXISTS" : res.status === 404 ? "MISSING" : "ERROR";
    }
    if (ref.registry === "pypi") {
      const res = await fetch(`${pypiBase()}/pypi/${encodeURIComponent(ref.name)}/json`, {
        signal: controller.signal,
      });
      return res.status === 200 ? "EXISTS" : res.status === 404 ? "MISSING" : "ERROR";
    }
    let res = await fetch(ref.name, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(ref.name, { signal: controller.signal, redirect: "follow" });
    }
    if (res.status >= 200 && res.status < 400) return "EXISTS";
    if (res.status === 404 || res.status === 410) return "MISSING";
    return "ERROR";
  } catch {
    return "ERROR";
  } finally {
    clearTimeout(timer);
  }
}

export interface Snapshot {
  version: 1;
  updatedAt: string;
  entries: Record<string, RefStatus>;
}

export function loadSnapshot(cwd: string): Snapshot | null {
  const path = join(cwd, SNAPSHOT_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(cwd: string, findings: RefFinding[]): void {
  const path = join(cwd, SNAPSHOT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const entries: Record<string, RefStatus> = {};
  for (const f of findings) {
    if (f.status === "EXISTS" || f.status === "MISSING") {
      entries[`${f.registry}:${f.name}`] = f.status;
    }
  }
  const snap: Snapshot = { version: 1, updatedAt: new Date().toISOString(), entries };
  writeFileSync(path, JSON.stringify(snap, null, 2) + "\n", "utf8");
}

export function loadAllowlist(path: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!path) return out;
  if (!existsSync(path)) throw new Error(`allowlist file not found: ${path}`);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) out.add(t.toLowerCase());
  }
  return out;
}

function isAllowlisted(ref: RawRef, allowlist: Set<string>): boolean {
  if (allowlist.has(ref.name.toLowerCase())) return true;
  if (ref.registry === "url") {
    for (const entry of allowlist) if (ref.name.toLowerCase().includes(entry)) return true;
  }
  return false;
}

export async function checkRefs(
  refs: RawRef[],
  opts: { offline: boolean; allowlist: Set<string>; cwd: string },
): Promise<CheckRefsResult> {
  const findings: RefFinding[] = [];
  const seen = new Set<string>();
  const deduped = refs.filter((r) => {
    const key = `${r.registry}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (opts.offline) {
    const snap = loadSnapshot(opts.cwd);
    if (!snap) {
      throw new Error(
        "no registry snapshot found (.skill-lock/refs-snapshot.json).\nRun 'skill-lock check-refs' online once to build it, then retry with --offline.",
      );
    }
    for (const ref of deduped) {
      if (isAllowlisted(ref, opts.allowlist)) {
        findings.push({ name: ref.name, registry: ref.registry, status: "ALLOWED", source: ref.source });
        continue;
      }
      const status = snap.entries[`${ref.registry}:${ref.name}`];
      findings.push({
        name: ref.name,
        registry: ref.registry,
        status: status ?? "UNKNOWN",
        source: ref.source,
        detail: status ? undefined : "not in snapshot",
      });
    }
  } else {
    for (const ref of deduped) {
      if (isAllowlisted(ref, opts.allowlist)) {
        findings.push({ name: ref.name, registry: ref.registry, status: "ALLOWED", source: ref.source });
        continue;
      }
      const status = await checkOne(ref);
      findings.push({
        name: ref.name,
        registry: ref.registry,
        status,
        source: ref.source,
        detail: status === "ERROR" ? "registry unreachable or returned an unexpected status" : undefined,
      });
    }
    saveSnapshot(opts.cwd, findings);
  }
  const count = (s: RefStatus) => findings.filter((f) => f.status === s).length;
  return {
    findings,
    exists: count("EXISTS"),
    missing: count("MISSING"),
    unknown: count("UNKNOWN"),
    skipped: count("SKIPPED"),
    allowed: count("ALLOWED"),
    errors: count("ERROR"),
  };
}
