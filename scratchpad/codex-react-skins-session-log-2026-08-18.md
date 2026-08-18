# React skins session log

## 2026-08-18: Scope confirmed

- Add a typed `classic | chalk` skin dimension to the web React SDK theme.
- Keep the existing typed palette and texture dimensions independent from skin.
- Make `classic` the default and preserve the current hand-drawn UI as `chalk`.
- Make `COSMIC_CHALK_THEME` select the chalk skin.
- Preserve behavior and accessibility fixes from `ef32c45d`; do not revert the commit wholesale.
- Update the turnkey `<Chalk />` and standalone `Entrance` surfaces, settings, previews, contracts, tests, docs, and changelog.
- React Native is explicitly out of scope for this pass.

The clean classic visual reference is `ef32c45d^` (`819575f1`). The first implementation tried one component tree with a skin context and skin-aware primitives; live review later proved that this could not restore the old layout.

## 2026-08-18: Skin seam integrated

- Added the skin catalog and public type while keeping the existing public appearance type source-compatible.
- Turnkey, Entrance, Space, Settings, and preview surfaces now carry the selected skin explicitly.
- Direct `Chalk*` primitives remain hand-drawn by default; the owned surfaces provide the selected skin through context.
- Classic primitives use live palette tokens, so changing skin, palette, or texture in Settings updates the whole Space without rebuilding the component tree.
- Cosmic palette colors stay usable with either skin. Its star and dashed-focus decoration is limited to the chalk skin, while `COSMIC_CHALK_THEME` selects that skin as a preset.

## 2026-08-18: Focused integration gate green

- React SDK type-checking passes.
- Nine focused React test files pass: 66 tests covering the public contract, bindings, Entrance, Space, Settings, primitives, theme, and preview fixtures.
- The shared UI skin selector tests pass: 2 tests.
- The web SDK preview state, toolbar, and gallery tests pass: 35 tests.
- A first Settings test run exposed an ambiguous accessible-name query because palette names also contain “Chalk”; the test now targets the full skin-choice label and the rerun is green.
- The exact dogfood server for this session is `http://127.0.0.1:3072/sdk-preview`; ports 3070 and 3071 belonged to other shared sessions.

## 2026-08-18: Classic renderer corrected

The first Classic implementation reused the post-`ef32c45d` renderer tree and only changed the visual primitives. Live review showed that this preserved the redesigned layout, especially in Entrance, and did not satisfy the request to restore the prior UI.

- Stopped the visual recording before treating the wrong implementation as evidence.
- Replaced the Classic Entrance and Space shells with separate renderers sourced from `ef32c45d^`.
- Kept the current renderer tree behind `skin: "chalk"`.
- The wrapper owns the skin choice while each renderer owns its own hooks, so a live skin switch cannot change hook order.
- Reopened the broader Space work to restore pre-redesign control, panel, dialog, and participant structures under the inherited Classic skin context.

## 2026-08-18: Exact Classic surface and polished Chalk Entrance

- Classic now dispatches to pre-redesign renderers across Entrance, Space, controls, participant surfaces, panels, dialogs, settings, and atomic status UI. The current hand-drawn renderers remain behind `skin: "chalk"`.
- The Chalk Entrance layout bug came from putting the responsive grid on `ChalkPanel` while the panel placed its content inside a single wrapper. The grid now lives on that content wrapper and forms a real `640px / 384px` split at the inspected desktop viewport.
- The camera preview fills the left frame, device controls sit below it, and the name/join form occupies the right column. The chalk strokes and palette remain unchanged.
- Skin switches while Settings is open now keep the dialog open on Appearance, including the SDK preview path.
- Focused verification is green: 46 React integration tests, 24 web preview tests, and the React SDK type check.
- Live Helium inspection confirmed seven rough frames under Chalk and no stacked lobby content. Evidence: `scratchpad/screenshots/react-skins-2026-08-18-chalk-entrance.png`.

## 2026-08-18: Final visual dogfood

- Helium dogfood passed Classic and Chalk Entrance on desktop and at a 390 × 844 mobile viewport, plus both Space skins, Cosmic palette composition, independent textures, empty-name validation, warning states, and live Settings switches in both directions.
- The pass found one low-contrast selected Classic skin card after switching from Chalk on a dark palette. The Classic renderer now uses the palette’s active-control background, border, and text tokens.
- Re-dogfood measured the fixed card at `rgb(244, 243, 238)` text on `rgb(38, 57, 65)` with an `rgb(101, 180, 208)` border. Appearance stays open and Audio does not replace it.
- Final evidence includes `scratchpad/screenshots/react-skins-2026-08-18-final-chalk-entrance.png`, `scratchpad/screenshots/react-skins-2026-08-18-final-classic-entrance.png`, and `scratchpad/screenshots/react-skins-2026-08-18-final-classic-appearance-fixed.png`.
- The final recording was cropped to the 1600 × 900 app viewport, normalized to H.264 at 30 fps, visually inspected, uploaded to Drive, and verified through its anonymous share URL.

## 2026-08-18: Task-only gate preparation

- The exact 147-file staged task diff passes formatting, React SDK type-checking, and focused changed-code analysis.
- Changed-code analysis caught copied public type exports in the new internal Classic renderers. Those renderers now import their canonical public prop types from the stable wrapper files, keeping the SDK surface single-source without changing rendered markup.
- The copied Classic toast renderer no longer re-exports the public `toast` helper; the stable `ToastStack` module remains its only export source.
- On the M4 test machine, the clean 193-file task-only gate passes routing, language, hygiene, secret scanning, formatting, changed-code analysis, static security, test presence, and the React SDK/shared UI type checks.
- The canonical gate stops on the untouched base-branch error `apps/web/src/lib/chalk-access.test.ts:81` (`TS2322`, unbranded `AccessGrantSource`). A separate clean base checkout reproduces the same error.
- All checks after that gate stop were run with the exact task diff: shared UI tests pass (19 files, 34 tests), React SDK tests pass (86 files, 188 tests), web tests pass (85 files, 423 tests), the packed consumer check passes, and all selected builds, Publint checks, and package TypeScript-resolution checks pass.
