# Cosmic Chalk SDK theme

## 2026-08-16 — architecture mapped

- Target: the public TypeScript React SDK, not the earlier Drawably prototype.
- Keep the existing palette + texture model. Add `cosmic-chalk` as a dark palette and expose a reusable `COSMIC_CHALK_THEME` preset.
- Apply the same preset to both `Entrance` and the live Space surface.
- Use the existing `/sdk-preview` route for local Helium screenshots.
- Preserve the shared dirty worktree. The only overlapping file is `packages/ui/src/styles/index.css`; changes there must be added as isolated hunks.

## 2026-08-16 — SDK implementation complete

- Added the public `COSMIC_CHALK_THEME` preset and the `cosmic-chalk` dark palette.
- Entrance now accepts the same `theme` prop as the full `Chalk` Space surface.
- The SDK preview exposes Cosmic Chalk for both Entrance and Space.
- Focus, loading, texture, and cross-platform palette parity are covered by focused tests.
- Visual dogfood is running against the local `/sdk-preview` route.

## 2026-08-16 — visual and integration gate

- Helium passed Entrance and Space at desktop and 390 × 844 with no app console errors or document overflow.
- The first mobile pass exposed a hidden second carousel page. The SDK now shows a compact, keyboard-reachable page pill above the mobile controls.
- Focused gates passed across React, React Native, web preview, and UI.
- The repository gate stopped at the language ratchet because unrelated staged work increased two banned glossary terms; it did not reach this unstaged theme diff.
