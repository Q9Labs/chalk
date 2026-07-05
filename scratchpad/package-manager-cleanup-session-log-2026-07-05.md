# Package Manager Cleanup Session Log - 2026-07-05

## Progress

- Replaced legacy runtime command examples in root and web app docs with pnpm commands.
- Switched the web app public asset sync script to `pnpm exec tsx`.
- Removed the old OpenTUI incident terminal UI entrypoint and its root script/dependencies.
- Removed the matching lockfile records for the deleted terminal UI dependency chain.

## Verification

- Exact legacy runtime/tooling search returned no matches.
- Filename search for the legacy runtime/tooling name returned no matches.
- OpenTUI incident terminal UI search returned no matches.
- `pnpm --dir apps/web run sync:public` passed. Node printed a `module.register()` deprecation warning from the runtime hook.
- `git diff --check` passed for the touched files.
- `pnpm install --lockfile-only` could not run because the earlier intentional `packages/sdk-core` reset removed the workspace package still referenced by other workspaces.
