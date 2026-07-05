# SDK React UI Reset Session Log - 2026-07-05

## 2026-07-05

- Hasan asked to remove stale logic from `packages/sdk-react` while preserving UI and JSX as scaffolding for a future rebuild.
- Deleted the React SDK test suite and replaced runtime/session hooks, context, and logic utilities with inert UI-only placeholders.
- Preserved `src/components`, `src/assets`, and `src/styles` as the visual layer.
- Removed logic-heavy full-screen controller/helper files under `src/components/full` while leaving TSX component shells in place.
- Removed the `@q9labs/chalk-core` dependency from `packages/sdk-react/package.json` because core is now a spec-only package.
- This is an intentional reset; typecheck/build may still need a follow-up UI-shell cleanup pass because preserved JSX may reference removed controller helpers until those components are simplified.
