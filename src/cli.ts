#!/usr/bin/env node
/**
 * skill-lock — pre-run integrity for AI agent skills.
 *
 * Pin approved skill files by SHA-256, diff drift before the agent runs,
 * and verify every package and URL a skill references actually exists.
 * Zero dependencies. Exit codes: 0 clean, 1 drift/ghost found, 2 usage/config error.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  BASELINE_DIR,
  DEFAULT_SKILL_DIRS,
  LOCKFILE_NAME,
  approveLockfile,
  discover,
  hashFiles,
  loadLockfile,
  readBaselineFile,
  saveLockfile,
  verifyLockfile,
  writeBaseline,
} from "./lockfile.js";
import type { Lockfile, SkillEntry } from "./types.js";
import { unifiedDiff } from "./diff.js";
import { countInvisible, markInvisible } from "./invisible.js";
import {
  checkRefs,
  extractRefs,
  extractRefsFromManifests,
  loadAllowlist,
  type RawRef,
} from "./refs.js";

const VERSION = "0.1.0";
const GENERATED_BY = `skill-lock ${VERSION}`;

interface Flags {
  lock?: string;
  format?: string;
  offline?: boolean;
  allowlist?: string;
  by?: string;
}

function printUsage(): void {
  console.log(`skill-lock ${VERSION} — pre-run integrity for AI agent skills

USAGE
  skill-lock init [dirs...] [--by <name>]
      Scan skill directories (default: .claude/skills .agents/skills) and
      loose instruction files, and write skill-lock.json: SHA-256 per file.
      Human approval is the only way a baseline is created.
  skill-lock verify [skill...] [--format table|json]
      Re-hash every pinned file and compare with skill-lock.json.
      Exit 1 on any drift (changed, added, or removed file).
  skill-lock diff [skill]
      Line-level unified diff of changed skill files against the approved
      baseline, so a human sees exactly what moved before approving.
  skill-lock approve [skill] [--by <name>]
      Re-baseline after human review. No --force, no auto-approve.
  skill-lock check-refs [skill] [--offline] [--allowlist <file>] [--format table|json]
      Check that every package and URL a skill references actually exists
      (npm registry, PyPI JSON API, HTTP HEAD for URLs). Exit 1 on any
      ghost reference. --offline uses the cached registry snapshot.

OPTIONS
  --lock <path>       lockfile path (default: skill-lock.json)
  --format table|json output format for verify and check-refs
  --offline           check-refs: use the cached snapshot, no network
  --allowlist <file>  check-refs: one private/internal name per line
  --by <name>         approver recorded in the lockfile (default: $USER)

EXIT CODES
  0 clean · 1 drift or ghost reference found · 2 usage or config error`);
}

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--lock") flags.lock = args[++i];
    else if (a === "--format") flags.format = args[++i];
    else if (a === "--offline") flags.offline = true;
    else if (a === "--allowlist") flags.allowlist = args[++i];
    else if (a === "--by") flags.by = args[++i];
    else if (a.startsWith("--lock=")) flags.lock = a.slice("--lock=".length);
    else if (a.startsWith("--format=")) flags.format = a.slice("--format=".length);
    else if (a.startsWith("--allowlist=")) flags.allowlist = a.slice("--allowlist=".length);
    else if (a.startsWith("--by=")) flags.by = a.slice("--by=".length);
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else positionals.push(a);
  }
  if (flags.format && flags.format !== "table" && flags.format !== "json") {
    throw new Error(`--format must be table or json, got '${flags.format}'.`);
  }
  return { positionals, flags };
}

function lockPath(cwd: string, flags: Flags): string {
  return resolve(cwd, flags.lock ?? LOCKFILE_NAME);
}

function approver(flags: Flags): string {
  return flags.by ?? process.env.USER ?? process.env.LOGNAME ?? "operator";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printVerifyTable(rows: ReturnType<typeof verifyLockfile>["rows"]): void {
  const skillW = Math.max(5, ...rows.map((r) => r.skill.length));
  const fileW = Math.max(4, ...rows.map((r) => r.file.length));
  console.log(`${pad("skill", skillW)}  ${pad("file", fileW)}  status    sha256`);
  for (const r of rows) {
    const hash = r.status === "REMOVED" ? `(was ${r.approved})` : (r.current ?? "");
    console.log(`${pad(r.skill, skillW)}  ${pad(r.file, fileW)}  ${pad(r.status, 8)}  ${hash}`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function cmdInit(cwd: string, positionals: string[], flags: Flags): number {
  const path = lockPath(cwd, flags);
  if (existsSync(path)) {
    fail(
      `lockfile already exists: ${relative(cwd, path)}\nDelete it to start over, or run 'skill-lock approve' after reviewing a diff.`,
    );
  }
  const { skills, files } = discover(positionals, cwd);
  if (skills.length === 0 && files.length === 0) {
    fail(
      `no skills found. Scanned: ${(positionals.length > 0 ? positionals : DEFAULT_SKILL_DIRS).join(", ")}\nPass skill directories (each holding a SKILL.md) or instruction files such as AGENTS.md.`,
    );
  }
  const by = approver(flags);
  const lock: Lockfile = {
    version: 1,
    generatedBy: GENERATED_BY,
    approvedBy: by,
    approvedAt: new Date().toISOString(),
    skills: {},
    files: {},
  };
  let totalFiles = 0;
  for (const skill of skills) {
    const entry: SkillEntry = { path: skill.relDir, files: hashFiles(skill.absDir, skill.files) };
    lock.skills[skill.name] = entry;
    totalFiles += skill.files.length;
    console.log(`  skill ${skill.name} (${skill.relDir}): ${skill.files.length} file(s) pinned`);
  }
  for (const rel of files) {
    const full = join(cwd, rel);
    lock.files[rel] = { sha256: _sha256File(full), size: statSync(full).size };
    totalFiles++;
    console.log(`  file ${rel}: pinned`);
  }
  saveLockfile(path, lock);
  writeBaseline(cwd, lock);
  console.log(
    `wrote ${relative(cwd, path)} (${totalFiles} file(s), ${skills.length} skill(s), approved by ${by})`,
  );
  console.log(`baseline copies kept in ${BASELINE_DIR}/ for 'skill-lock diff'. Commit the lockfile; the baseline is a local review aid.`);
  return 0;
}

import { sha256File as _sha256File } from "./hash.js";

function cmdVerify(cwd: string, positionals: string[], flags: Flags): number {
  const lock = loadLockfile(lockPath(cwd, flags));
  const result = verifyLockfile(lock, cwd);
  let rows = result.rows;
  if (positionals.length > 0) {
    const wanted = new Set(positionals);
    const filtered = rows.filter(
      (r) =>
        wanted.has(r.skill) ||
        wanted.has(r.file) ||
        Object.values(lock.skills).some((s) => s.path === r.skill && wanted.has(s.path)),
    );
    if (filtered.length === 0 && rows.length > 0) {
      const known = [...Object.keys(lock.skills), ...Object.keys(lock.files)].join(", ");
      fail(`no such skill or file: ${positionals.join(", ")} (known: ${known || "none"})`);
    }
    rows = filtered;
  }
  if (flags.format === "json") {
    console.log(
      JSON.stringify(
        {
          lockfile: relative(cwd, lockPath(cwd, flags)),
          summary: {
            ok: rows.filter((r) => r.status === "OK").length,
            changed: rows.filter((r) => r.status === "CHANGED").length,
            added: rows.filter((r) => r.status === "NEW").length,
            removed: rows.filter((r) => r.status === "REMOVED").length,
          },
          rows,
        },
        null,
        2,
      ),
    );
  } else {
    if (rows.length === 0) {
      console.log("lockfile is empty — nothing pinned.");
    } else {
      printVerifyTable(rows);
    }
    const drift = result.changed + result.added + result.removed;
    if (drift === 0) {
      console.log(`\nCLEAN: all ${result.ok} file(s) match the approved baseline.`);
    } else {
      console.log(
        `\nDRIFT: ${result.changed} changed, ${result.added} added, ${result.removed} removed — review with 'skill-lock diff', then 'skill-lock approve'.`,
      );
      for (const r of rows) {
        if (r.status === "CHANGED" && (r.invisibleCount ?? 0) > 0) {
          console.log(`note: ${r.invisibleCount} non-printing character(s) in ${r.skill}/${r.file} — see 'skill-lock diff'.`);
        }
      }
    }
  }
  const drift = rows.filter((r) => r.status !== "OK").length;
  return drift === 0 ? 0 : 1;
}

function cmdDiff(cwd: string, positionals: string[], flags: Flags): number {
  const lock = loadLockfile(lockPath(cwd, flags));
  const result = verifyLockfile(lock, cwd);
  const drifted = result.rows.filter((r) => r.status !== "OK");
  let selected = drifted;
  if (positionals.length > 0) {
    const wanted = new Set(positionals);
    selected = drifted.filter((r) => wanted.has(r.skill) || wanted.has(r.file));
    const knownSkills = Object.keys(lock.skills);
    for (const w of positionals) {
      if (!knownSkills.includes(w) && !selected.some((r) => r.file === w)) {
        fail(`no such skill: ${w} (known: ${knownSkills.join(", ") || "none"})`);
      }
    }
  }
  if (selected.length === 0) {
    console.log("no drift — every pinned file matches the approved baseline.");
    return 0;
  }
  for (const row of selected) {
    const skillEntry = lock.skills[row.skill];
    const skillPath = skillEntry ? skillEntry.path : null;
    const displayPath = skillPath ? `${skillPath}/${row.file}` : row.file;
    console.log(`\n== ${row.status} ${displayPath} ==`);
    if (row.status === "REMOVED") {
      console.log(`file removed (was sha256 ${row.approved}…).`);
      continue;
    }
    if (row.status === "NEW") {
      const full = join(cwd, skillPath ?? "", row.file);
      const text = readFileSync(full, "utf8");
      const invisible = countInvisible(text);
      if (invisible > 0) console.log(`note: ${invisible} non-printing character(s) in this file — shown as ⟨U+XXXX⟩.`);
      for (const line of text.split("\n")) console.log(`+${markInvisible(line)}`);
      continue;
    }
    // CHANGED
    const baseline = readBaselineFile(cwd, skillPath, row.file);
    if (baseline === null) {
      console.log(`baseline copy missing (.skill-lock/baseline) — cannot show lines.`);
      console.log(`hash ${row.approved}… -> ${row.current}…`);
      continue;
    }
    const full = join(cwd, skillPath ?? "", row.file);
    const current = readFileSync(full, "utf8");
    const invisible = countInvisible(current) + countInvisible(baseline);
    if (invisible > 0) {
      console.log(`note: ${invisible} non-printing character(s) in this file — shown as ⟨U+XXXX⟩.`);
    }
    const out = unifiedDiff(displayPath, baseline, current);
    console.log(out || "(no line-level difference — binary or whitespace-only change)");
  }
  return 1;
}

function cmdApprove(cwd: string, positionals: string[], flags: Flags): number {
  const path = lockPath(cwd, flags);
  const lock = loadLockfile(path);
  const by = approver(flags);
  if (positionals.length > 1) fail("approve takes at most one skill.");
  const changed = approveLockfile(lock, cwd, by, positionals[0]);
  saveLockfile(path, lock);
  console.log(`re-baselined ${changed.join(", ")} — approved by ${by} at ${lock.approvedAt}.`);
  console.log("Review the diff first next time: 'skill-lock diff' shows exactly what moved.");
  return 0;
}

function collectSkillTexts(lock: Lockfile, cwd: string, skillArg?: string): Array<{ label: string; text: string; dir: string }> {
  const out: Array<{ label: string; text: string; dir: string }> = [];
  const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);
  const readText = (full: string): string | null => {
    if (!existsSync(full)) return null;
    const buf = readFileSync(full);
    return isBinary(buf) ? null : buf.toString("utf8");
  };
  for (const [name, skill] of Object.entries(lock.skills)) {
    if (skillArg && skillArg !== name && skillArg !== skill.path) continue;
    for (const rel of Object.keys(skill.files)) {
      const text = readText(join(cwd, skill.path, rel));
      if (text !== null) out.push({ label: `${name}/${rel}`, text, dir: join(cwd, skill.path) });
    }
  }
  if (!skillArg) {
    for (const rel of Object.keys(lock.files)) {
      const text = readText(join(cwd, rel));
      if (text !== null) out.push({ label: rel, text, dir: cwd });
    }
  }
  return out;
}

async function cmdCheckRefs(cwd: string, positionals: string[], flags: Flags): Promise<number> {
  const lock = loadLockfile(lockPath(cwd, flags));
  if (positionals.length > 1) fail("check-refs takes at most one skill.");
  const skillArg = positionals[0];
  if (skillArg && !lock.skills[skillArg] && !Object.values(lock.skills).some((s) => s.path === skillArg)) {
    fail(`no such skill: ${skillArg} (known: ${Object.keys(lock.skills).join(", ") || "none"})`);
  }
  const texts = collectSkillTexts(lock, cwd, skillArg);
  const refs: RawRef[] = [];
  for (const t of texts) refs.push(...extractRefs(t.text, t.label));
  for (const [name, skill] of Object.entries(lock.skills)) {
    if (skillArg && skillArg !== name && skillArg !== skill.path) continue;
    refs.push(...extractRefsFromManifests(join(cwd, skill.path), name));
  }
  if (refs.length === 0) {
    console.log("no package or URL references found in the selected skill(s).");
    return 0;
  }
  const allowlist = loadAllowlist(flags.allowlist ? resolve(cwd, flags.allowlist) : undefined);
  const result = await checkRefs(refs, { offline: flags.offline ?? false, allowlist, cwd });
  if (flags.format === "json") {
    console.log(JSON.stringify({ summary: {
      exists: result.exists, missing: result.missing, unknown: result.unknown,
      skipped: result.skipped, allowed: result.allowed, errors: result.errors,
    }, findings: result.findings }, null, 2));
  } else {
    const nameW = Math.max(9, ...result.findings.map((f) => f.name.length));
    console.log(`${pad("reference", nameW)}  registry  status    source`);
    for (const f of result.findings) {
      console.log(`${pad(f.name, nameW)}  ${pad(f.registry, 8)}  ${pad(f.status, 8)}  ${f.source}`);
    }
    const parts = [`${result.exists} exist`, `${result.missing} missing`];
    if (result.unknown > 0) parts.push(`${result.unknown} unknown (not in snapshot)`);
    if (result.allowed > 0) parts.push(`${result.allowed} allowlisted`);
    if (result.errors > 0) parts.push(`${result.errors} unreachable`);
    console.log(`\n${parts.join(", ")} — ${result.findings.length} reference(s) checked.`);
    if (result.missing > 0) {
      console.log("GHOST REFERENCE FOUND: a skill tells the agent to install or call something that does not exist. Review before approving.");
    } else if (result.errors > 0) {
      console.log("Some references could not be checked (network error). Failing closed — retry when the registry is reachable.");
    } else if (!flags.offline) {
      console.log("Snapshot updated (.skill-lock/refs-snapshot.json) for offline runs.");
    }
  }
  return result.missing > 0 || result.errors > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printUsage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(`skill-lock ${VERSION}`);
    return 0;
  }
  const cwd = process.cwd();
  const { positionals, flags } = parseFlags(rest);
  switch (cmd) {
    case "init":
      return cmdInit(cwd, positionals, flags);
    case "verify":
      return cmdVerify(cwd, positionals, flags);
    case "diff":
      return cmdDiff(cwd, positionals, flags);
    case "approve":
      return cmdApprove(cwd, positionals, flags);
    case "check-refs":
      return cmdCheckRefs(cwd, positionals, flags);
    default:
      throw new Error(`unknown command: ${cmd}\nRun 'skill-lock --help' for usage.`);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`skill-lock: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
