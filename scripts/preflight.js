/**
 * Preflight check (Rule 7): scan publishable TEXT files for
 *  - Vietnamese diacritics (public docs must be 100% English)
 *  - internal names that must never leak into a public repo
 * Binary files are skipped (null-byte / extension check). Exits non-zero on hits.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Internal codenames — matched as standalone words so "enables" etc. don't trip it.
// "techdevfun" is the PUBLIC GitHub org and is intentionally allowed.
const FORBIDDEN_WORDS = [
  "tranmyphuc", "luyenthi", "sghasia", "jackapp",
  "NAB", // as a word; the internal "NAB-grade" reference
];
const FORBIDDEN_SUBSTRINGS = ["ivi.asia"]; // contains a dot; word-boundary N/A
const WORD_RE = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILES = new Set(["preflight.js"]);
const BINARY_EXTS = new Set([".gif", ".png", ".jpg", ".jpeg", ".zip", ".ico", ".woff", ".woff2", ".ttf"]);

const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

let failures = 0;
let scanned = 0;

function isBinary(full, head) {
  if (BINARY_EXTS.has(extname(full).toLowerCase())) return true;
  return head.includes(0); // null byte -> binary
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.isFile() && !SKIP_FILES.has(entry)) checkFile(full);
  }
}

function checkFile(full) {
  const rel = relative(ROOT, full);
  const buf = readFileSync(full);
  if (isBinary(full, buf.subarray(0, 8000))) return;
  const text = buf.toString("utf8");
  scanned++;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (VIETNAMESE.test(line)) {
      console.error(`VIETNAMESE DIACRITIC: ${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
      failures++;
    }
  });
  for (const w of FORBIDDEN_WORDS) {
    if (WORD_RE(w).test(text)) {
      console.error(`FORBIDDEN NAME "${w}": ${rel}`);
      failures++;
    }
  }
  for (const s of FORBIDDEN_SUBSTRINGS) {
    if (text.toLowerCase().includes(s)) {
      console.error(`FORBIDDEN NAME "${s}": ${rel}`);
      failures++;
    }
  }
}

walk(ROOT);

if (failures > 0) {
  console.error(`\npreflight FAILED: ${failures} hit(s) in ${scanned} files`);
  process.exit(1);
}
console.log(`preflight OK: ${scanned} text files, 0 Vietnamese diacritics, 0 internal names.`);
