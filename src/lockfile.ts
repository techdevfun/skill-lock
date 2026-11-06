import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { sha256File } from "./hash.js";
import type { FileStatus, Lockfile, PinnedFile, SkillEntry, VerifyResult, VerifyRow } from "./types.js";
import { countInvisible } from "./invisible.js";

export const LOCKFILE_NAME = "skill-lock.json";
export const BASELINE_DIR = ".skill-lock/baseline";
export const SNAPSHOT_FILE = ".skill-lock/refs-snapshot.json";

export const DEFAULT_SKILL_DIRS = [".claude/skills", ".agents/skills"];

const EXCLUDED_NAMES = new Set([LOCKFILE_NAME, ".skill-lock", ".git", "node_modules"]);

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function skillNameFromFrontmatter(skillDir: string): string | null {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  const text = readFileSync(skillMd, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const nameLine = m[1].split("\n").find((l) => /^name\s*:/.test(l.trim()));
  if (!nameLine) return null;
  const value = nameLine.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
  return value || null;
}

export interface DiscoveredSkill {
  name: string;
  /** Path relative to the project root, posix style. */
  relDir: string;
  absDir: string;
  /** File paths relative to the skill dir, posix style. */
  files: string[];
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Find every skill under one scanned directory. */
export function discoverInDir(dirAbs: string, cwd: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return found;
  const candidates: string[] = [];
  if (existsSync(join(dirAbs, "SKILL.md"))) {
    candidates.push(dirAbs);
  } else {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dirAbs, entry.name);
      if (existsSync(join(sub, "SKILL.md"))) candidates.push(sub);
    }
  }
  for (const skillDir of candidates) {
    const files = walkFiles(skillDir).map((f) => toPosix(relative(skillDir, f)));
    found.push({
      name: skillNameFromFrontmatter(skillDir) ?? basename(skillDir),
      relDir: toPosix(relative(cwd, skillDir)),
      absDir: skillDir,
      files,
    });
  }
  return found;
}

export interface Discovery {
  skills: DiscoveredSkill[];
  /** Loose instruction files, paths relative to the project root. */
  files: string[];
}

/**
 * Resolve init/verify inputs: directories are scanned for skills, plain
 * files are pinned as loose instruction files. With no inputs, the two
 * default skill directories are scanned.
 */
export function discover(inputs: string[], cwd: string): Discovery {
  const skills: DiscoveredSkill[] = [];
  const files: string[] = [];
  const dirs = inputs.length > 0 ? inputs : DEFAULT_SKILL_DIRS;
  for (const input of dirs) {
    const abs = resolve(cwd, input);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) {
      files.push(toPosix(relative(cwd, abs)));
    } else {
      skills.push(...discoverInDir(abs, cwd));
    }
  }
  return { skills, files };
}

export function hashFiles(absDir: string, relFiles: string[]): Record<string, PinnedFile> {
  const out: Record<string, PinnedFile> = {};
  for (const rel of relFiles) {
    const full = join(absDir, rel);
    out[rel] = { sha256: sha256File(full), size: statSync(full).size };
  }
  return out;
}

export function loadLockfile(path: string): Lockfile {
  if (!existsSync(path)) {
    throw new Error(`lockfile not found: ${path}\nRun 'skill-lock init' first to approve a baseline.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`lockfile is not valid JSON: ${path}`);
  }
  const lock = parsed as Lockfile;
  if (!lock || lock.version !== 1 || typeof lock.skills !== "object" || typeof lock.files !== "object") {
    throw new Error(`lockfile has an unsupported format (expected version 1): ${path}`);
  }
  return lock;
}

export function saveLockfile(path: string, lock: Lockfile): void {
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

function baselineSkillDir(cwd: string, relDir: string): string {
  return join(cwd, BASELINE_DIR, relDir);
}

function baselineFilePath(cwd: string, rel: string): string {
  return join(cwd, BASELINE_DIR, "__files__", rel);
}

/** Copy the current on-disk files into the local baseline snapshot. */
export function writeBaseline(cwd: string, lock: Lockfile): void {
  for (const [name, skill] of Object.entries(lock.skills)) {
    const destDir = baselineSkillDir(cwd, skill.path);
    rmSync(destDir, { recursive: true, force: true });
    for (const rel of Object.keys(skill.files)) {
      const src = join(cwd, skill.path, rel);
      if (!existsSync(src)) continue;
      const dest = join(destDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
    void name;
  }
  for (const rel of Object.keys(lock.files)) {
    const src = join(cwd, rel);
    if (!existsSync(src)) continue;
    const dest = baselineFilePath(cwd, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

export function readBaselineFile(cwd: string, skillPath: string | null, rel: string): string | null {
  const full = skillPath === null ? baselineFilePath(cwd, rel) : join(baselineSkillDir(cwd, skillPath), rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

export function verifyLockfile(lock: Lockfile, cwd: string): VerifyResult {
  const rows: VerifyRow[] = [];
  for (const [name, skill] of Object.entries(lock.skills)) {
    const skillDir = join(cwd, skill.path);
    const onDisk = new Set<string>();
    if (existsSync(skillDir) && statSync(skillDir).isDirectory()) {
      for (const f of walkFiles(skillDir)) onDisk.add(toPosix(relative(skillDir, f)));
    }
    for (const [rel, pinned] of Object.entries(skill.files)) {
      const full = join(skillDir, rel);
      if (!existsSync(full)) {
        rows.push({ skill: name, file: rel, status: "REMOVED", approved: pinned.sha256.slice(0, 8) });
        continue;
      }
      const current = sha256File(full);
      if (current === pinned.sha256) {
        rows.push({ skill: name, file: rel, status: "OK", current: current.slice(0, 8), approved: pinned.sha256.slice(0, 8) });
      } else {
        const text = readFileSync(full, "utf8");
        rows.push({
          skill: name,
          file: rel,
          status: "CHANGED",
          current: current.slice(0, 8),
          approved: pinned.sha256.slice(0, 8),
          invisibleCount: countInvisible(text),
        });
      }
    }
    for (const rel of [...onDisk].sort()) {
      if (!(rel in skill.files)) {
        rows.push({ skill: name, file: rel, status: "NEW", current: sha256File(join(skillDir, rel)).slice(0, 8) });
      }
    }
  }
  for (const [rel, pinned] of Object.entries(lock.files)) {
    const full = join(cwd, rel);
    if (!existsSync(full)) {
      rows.push({ skill: "(instructions)", file: rel, status: "REMOVED", approved: pinned.sha256.slice(0, 8) });
      continue;
    }
    const current = sha256File(full);
    if (current === pinned.sha256) {
      rows.push({ skill: "(instructions)", file: rel, status: "OK", current: current.slice(0, 8), approved: pinned.sha256.slice(0, 8) });
    } else {
      const text = readFileSync(full, "utf8");
      rows.push({
        skill: "(instructions)",
        file: rel,
        status: "CHANGED",
        current: current.slice(0, 8),
        approved: pinned.sha256.slice(0, 8),
        invisibleCount: countInvisible(text),
      });
    }
  }
  const count = (s: FileStatus) => rows.filter((r) => r.status === s).length;
  return { rows, ok: count("OK"), changed: count("CHANGED"), added: count("NEW"), removed: count("REMOVED") };
}

/**
 * Re-baseline after human review: the current on-disk state becomes the new
 * approved baseline. `skillName` limits the re-baseline to one skill;
 * without it, every skill and loose file is re-baselined. Missing skills
 * and files are dropped from the lockfile. Returns the names that changed.
 */
export function approveLockfile(lock: Lockfile, cwd: string, by: string, skillName?: string): string[] {
  const changed: string[] = [];
  const now = new Date().toISOString();
  const approveSkill = (name: string, entry: SkillEntry): boolean => {
    const skillDir = join(cwd, entry.path);
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
      delete lock.skills[name];
      changed.push(name);
      return true;
    }
    const files = walkFiles(skillDir).map((f) => toPosix(relative(skillDir, f)));
    entry.files = hashFiles(skillDir, files);
    changed.push(name);
    return true;
  };
  if (skillName) {
    const entry = lock.skills[skillName];
    if (!entry) throw new Error(`no skill named '${skillName}' in the lockfile.`);
    approveSkill(skillName, entry);
  } else {
    for (const [name, entry] of Object.entries({ ...lock.skills })) approveSkill(name, entry);
    const hadLoose = Object.keys(lock.files).length > 0;
    const nextFiles: Record<string, PinnedFile> = {};
    for (const rel of Object.keys(lock.files)) {
      const full = join(cwd, rel);
      if (existsSync(full)) nextFiles[rel] = { sha256: sha256File(full), size: statSync(full).size };
    }
    lock.files = nextFiles;
    if (hadLoose) changed.push("(instructions)");
  }
  lock.approvedBy = by;
  lock.approvedAt = now;
  writeBaseline(cwd, lock);
  return changed;
}
