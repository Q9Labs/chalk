# UI redesign session log — 2026-08-21

## Scope
Redesign of the Space details dialog and the Admission UI inside the Participants panel, in the **classic** skin (the first pass was done on the Chalk skin and rejected: wrong target, card-in-card layout, form-like dialog). Context came from a Luna explorer lane (report: /tmp/chalk-luna/context-report.md).

## Done (classic pass)
- `sdks/typescript/react/src/components/space-info-dialog/ClassicSpaceInfoDialog.tsx` — rewritten. Space name is the title (+ Recording / Transcribing pills, description underneath), close button, then the facts. 560px panel, `role="dialog"` with focus-in on open, Tab loop, Escape closes, focus returns to opener, click-outside closes.
- `.../space-info-dialog/SpaceInfoContent.tsx` — rewritten as one flat `<dl>` (label column 128px): Invite link (mono field + accent "Copy link"), Scan to join (96px token-coloured QR), Duration, Space ID, Connection (`1080p · 28 ms · 0.1% loss` + region), Security, Diagnostic ref (+ small ghost Copy). Footer "Having trouble in this Space? / Send feedback" only when feedback is wired. Shared by the Chalk shell too.
- `.../admission-panel/ClassicAdmissionPanel.tsx` — rewritten as a flat list (no card): "N WAITING" eyebrow + Admit all / Deny all (≥2 only), hairline-divided rows (avatar, name, "Waiting to join"/"Waiting N min", soft-accent Admit + ghost Deny), centered empty state. Inline → `region "Admission requests"`; standalone keeps a floating panel.
- `.../participants-panel/ClassicParticipantsPanel.tsx` — surgical edit: flat ghost tab strip `In Space N | Waiting N` (`role="tablist"`, arrow/Home/End keys, Waiting count pill turns accent when >0) shown only with `manageAdmission`. Waiting tab hides search and renders the admission list; opens on Waiting when people are queued at mount, otherwise In Space. Mobile variant swaps the "Participants" label for the tabs.
- `ParticipantsAdmission.test.tsx` — +3 classic tab tests. `SpaceInfoContent.test.tsx` / `SpaceInfoDialog.test.tsx` — label assertions updated ("Invite link", raw space id).

## Earlier (Chalk pass, left in place)
Chalk-skin shells `SpaceInfoDialog.tsx` / `AdmissionPanel.tsx`, extra icons in `utils/icons.tsx`, preview `stats` in `SdkPreviewGallery.tsx`. Not used in classic; the Chalk dialog renders the new shared content.

## Verification
- `tsc --noEmit` clean. SDK vitest: space-info-dialog + admission-panel + participants-panel 23 passed; SpaceView test passed earlier; apps/web sdk-preview tests 45 passed. oxfmt clean on owned files.
- Token lint: only pre-existing `!text-white` in ClassicParticipantsPanel (other agent's Invite button, present in HEAD).
- Screenshots (classic, Chrome via playwright on a temporary Vite :3071 because the :3070 server belongs to a Codex session and had a stale import cache): /tmp/chalk-luna/shots/classic-{dialog-dark,dialog-light,admission-waiting-dark,admission-roster-dark,admission-empty-dark,admission-waiting-light}.png

## Notes
- Shared worktree; other agents are mid-change in space-header/, logo/. Nothing committed (not asked).
