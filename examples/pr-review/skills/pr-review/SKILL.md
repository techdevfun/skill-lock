---
name: pr-review
description: Review a pull request diff for obvious defects before a human looks at it.
---

# PR Review

Use this skill when the agent is asked to review a pull request.

## Steps

1. Read the diff with `git diff --stat` and `git diff`.
2. Run the project's checks first: `scripts/check.sh`.
3. Report findings grouped by severity: blocker, major, nit.
4. Never approve a change you have not read in full.

## Rules

- Quote the exact lines you object to.
- Do not rewrite the author's code; suggest, do not apply.
- If a check fails, say so and stop — do not guess the result.
