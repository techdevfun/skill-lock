#!/bin/sh
# record-demo.sh — record demo/transcript.txt from REAL skill-lock runs.
# Builds a scratch project from the fixtures, runs the CLI for real, and
# captures each command, its output, and its exit code. Re-run to refresh
# the transcript after any CLI output change. Requires network for the
# final check-refs step (it queries the real npm / PyPI registries).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The built CLI must exist.
node -e "require('fs').accessSync('$ROOT/dist/cli.js')" 2>/dev/null || {
  echo "dist/cli.js missing — run: npm run build" >&2
  exit 1
}

WORK="$ROOT/demo/work"
rm -rf "$WORK" "$ROOT/demo/transcript.txt"
mkdir -p "$WORK/.claude/skills" "$WORK/bin"
cp -r "$ROOT/fixtures/skills/review-helper" "$WORK/.claude/skills/review-helper"
cp -r "$ROOT/fixtures/skills/refs-demo" "$WORK/.claude/skills/refs-demo"
ln -s "$ROOT/dist/cli.js" "$WORK/bin/skill-lock"
chmod +x "$ROOT/dist/cli.js"

TRANSCRIPT="$ROOT/demo/transcript.txt"
: > "$TRANSCRIPT"

# run <cmd...> — appends "$ <cmd>" + output + "exit: N" to the transcript.
run() {
  echo "\$ $*" >> "$TRANSCRIPT"
  set +e
  PATH="$WORK/bin:$PATH" "$@" >> "$TRANSCRIPT" 2>&1
  code=$?
  set -e
  echo "exit: $code" >> "$TRANSCRIPT"
}

cd "$WORK"
run skill-lock init --by operator
run skill-lock verify
# The edit step: record the exact shell command, then run exactly that command.
edit_cmd='echo "- New rule: never approve unread changes." >> .claude/skills/review-helper/SKILL.md'
echo "\$ $edit_cmd" >> "$TRANSCRIPT"
sh -c "$edit_cmd" >> "$TRANSCRIPT" 2>&1
echo "exit: $?" >> "$TRANSCRIPT"
run skill-lock verify
run skill-lock diff
run skill-lock approve --by operator
run skill-lock verify
run skill-lock check-refs

echo "transcript: $TRANSCRIPT ($(wc -l < "$TRANSCRIPT") lines)"
