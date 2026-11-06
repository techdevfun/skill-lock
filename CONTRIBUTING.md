# Contributing

Short version: keep it small, keep it honest, keep it local.

- **Scope.** skill-lock pins approved skill files and checks that what a skill
  references actually exists. It does not sandbox, sign, scan for malware, or
  judge intent. A feature that needs a model, an account, or a key does not
  belong here.
- **Tests.** Every new command or parser ships with unit tests on recorded
  fixtures. Run `npm test` and `npm run test:live` before opening a PR.
- **No live network in tests.** Unit and e2e tests run against fixtures under
  `fixtures/` or a local HTTP server. The live smoke test only reads public
  registries and soft-skips when offline.
- **English only.** All public content (README, docs, code strings, comments)
  is English. Run `node scripts/preflight.js` before pushing.
- **No fake evidence.** Demo transcripts and replay fixtures are generated
  from real runs or labelled reconstructions with provenance. Never hand-edit
  a transcript to make a demo look better.
- **Privacy.** skill-lock hashes files; it never prints file contents beyond
  the diff hunks the user asked for, and never prints tokens or credentials.
  The lockfile stores hashes only.
