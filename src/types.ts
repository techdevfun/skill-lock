export interface PinnedFile {
  sha256: string;
  size: number;
}

export interface SkillEntry {
  path: string;
  files: Record<string, PinnedFile>;
}

export interface Lockfile {
  version: 1;
  generatedBy: string;
  approvedBy: string;
  approvedAt: string;
  skills: Record<string, SkillEntry>;
  /** Loose instruction files pinned by path relative to the project root. */
  files: Record<string, PinnedFile>;
}

export type FileStatus = "OK" | "CHANGED" | "NEW" | "REMOVED";

export interface VerifyRow {
  skill: string;
  file: string;
  status: FileStatus;
  /** Current hash prefix (8 hex chars) when the file exists on disk. */
  current?: string;
  /** Approved hash prefix from the lockfile, when pinned. */
  approved?: string;
  /** Non-printing characters found in a changed file. */
  invisibleCount?: number;
}

export interface VerifyResult {
  rows: VerifyRow[];
  ok: number;
  changed: number;
  added: number;
  removed: number;
}

export type RefRegistry = "npm" | "pypi" | "url";

export type RefStatus = "EXISTS" | "MISSING" | "UNKNOWN" | "SKIPPED" | "ALLOWED" | "ERROR";

export interface RefFinding {
  name: string;
  registry: RefRegistry;
  status: RefStatus;
  /** Where the reference was found: "SKILL.md:12". */
  source: string;
  detail?: string;
}

export interface CheckRefsResult {
  findings: RefFinding[];
  exists: number;
  missing: number;
  unknown: number;
  skipped: number;
  allowed: number;
  errors: number;
}
