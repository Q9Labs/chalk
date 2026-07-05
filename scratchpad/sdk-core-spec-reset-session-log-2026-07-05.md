# SDK Core Spec Reset Session Log - 2026-07-05

## 2026-07-05

- Hasan asked to completely trim and almost delete `packages/sdk-core`, replacing
  it with a Markdown spec in natural language with no technical details.
- The repo had unrelated dirty changes before this work, mostly under
  `apps/api` plus root documentation. Those were left untouched.
- `packages/sdk-core` had 150 tracked files plus local generated artifacts under
  `dist`, `coverage`, `.turbo`, and `node_modules`.
- The package is still referenced by web, mobile, React, React Native, UI,
  TypeScript path aliases, and the lockfile. This reset intentionally removes
  the package implementation only; downstream imports are expected to fail until
  the new product direction is wired back into those surfaces.
- Replaced the package directory with `packages/sdk-core/README.md`, a
  plain-English product spec for the desired shared meeting experience.

