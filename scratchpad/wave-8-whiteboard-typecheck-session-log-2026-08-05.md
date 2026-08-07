# Wave 8 whiteboard typecheck — 2026-08-05

## 2026-08-05 15:07:09 +0500 — portable base64 fallback

- Reproduced `pnpm exec tsc --project sdks/typescript/react/tsconfig.check-types.json --noEmit` failure at `packages/whiteboard/src/react/math-elements.ts:33`: `TS2591 Cannot find name 'Buffer'`.
- Cause: the React typecheck follows the `@q9labsai/chalk-whiteboard/react` source path directly under a DOM/browser-oriented TypeScript configuration, where Node ambient globals are intentionally unavailable.
- Changed `packages/whiteboard/src/react/math-elements.ts` to probe an optional `globalThis.Buffer` structurally (without a `node:buffer` import that would be inappropriate for the browser bundle) after the existing `btoa` path, and throw a clear error only if neither encoder exists.
- Verification:
  - `pnpm exec tsc --project sdks/typescript/react/tsconfig.check-types.json --noEmit` — passed.
  - `pnpm exec vitest run packages/whiteboard/src/react/math-elements.test.ts` — 2 tests passed.
  - `pnpm exec oxfmt --check packages/whiteboard/src/react/math-elements.ts` — passed.
  - `pnpm run language:ratchet` — passed; banned-term counts unchanged.

No files were staged or committed. No unrelated paths were edited.
