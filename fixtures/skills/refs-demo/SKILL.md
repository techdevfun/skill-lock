---
name: refs-demo
description: Fixture skill for check-refs — references one real npm package, one real PyPI package, one ghost fixture name, and two URLs.
---

# Refs Demo

This skill is a fixture. It exists so `skill-lock check-refs` has something
real to verify. Do not install anything listed here by hand.

## Tooling

Format code before committing:

    npm install prettier

Summarise HTTP responses in Python:

    pip install requests

Read the API contract first:

    https://example.com

## Deliberately fake references (fixtures, never published)

The following name is invented for the demo. It does not exist on npm,
and nothing here will ever publish it:

    npm install skill-lock-demo-ghost-9x7q

The following URL uses a reserved TLD that never resolves:

    https://skill-lock-demo-ghost-9x7q.invalid/docs
