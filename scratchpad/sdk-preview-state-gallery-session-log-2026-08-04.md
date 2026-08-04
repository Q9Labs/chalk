# SDK preview state gallery session log

## 2026-08-04 10:35 PKT

- Started discovery for a development-only, URL-addressable `/sdk-preview` gallery covering Entrance and Space states.
- Loaded the canonical glossary, writing rules, global code standards, and Chalk incident/status workflow.
- Found the root Git config currently marks the repository as bare even though the working tree is present; using explicit `--git-dir=.git --work-tree=.` read-only Git commands to avoid changing shared repository configuration.
- Preserved the existing dirty worktree and will scope all edits and staging to this task.

## 2026-08-04 10:48 PKT

- Completed parallel Luna discovery of the current preview route, production React SDK, historical SDK/preview lineage, and web routing/test architecture.
- Confirmed the current preview is a two-state, non-addressable harness: the active Space is the default, while Entrance is reachable only after confirming leave.
- Confirmed the current production SDK already owns admission, recovery, end, panels, dialogs, toasts, reactions, and rich chat/transcript data states that the preview does not expose.
- Found one relevant production parity gap: React Native has an explicit join-failure screen with retry/back actions, while web only returns to Entrance with an inline error.
- Chose not to revive historical recording, transcription control, PiP, or background-effect switches as shipped states because current client contracts and launch docs intentionally defer them.
- Started four non-overlapping Luna implementation workstreams: typed URL/dev routing, accessible gallery toolbar, production-component gallery composition, and the missing web join-failure component.

## 2026-08-04 11:08 PKT

- Added `SdkPreviewGallery` with deterministic Entrance and Space fixtures, production SDK surfaces, panel/dialog/recovery compositions, URL patches, and all requested state families.
- Updated `ScreenShareMock` to hide its workspace rail on narrow screens and added responsive fixture coverage.
- Focused web tests pass: 20 tests across the gallery and screen-share fixture files. App typechecking is waiting on the refreshed React package declaration for `JoinFailedScreen`.

## 2026-08-04 11:12 PKT

- Extracted gallery fixtures and mapping helpers into `sdk-preview-fixtures.ts`, keeping the component under the repository's split threshold.
- Made the direct Empty Space state override participant, chat, transcript, and admission data while preserving explicit knobs for other states.
- Removed synthetic `MediaStreamTrack` construction; share state now uses the existing `ConferenceView` overlay seam around `ScreenShareMock`.
- Focused web tests pass: 21 tests across the gallery and screen-share fixture files. Only the stale package declaration for `JoinFailedScreen` remains in app typechecking until the React package is rebuilt.

## 2026-08-04 11:24 PKT

- Read the orchestration guide and corrected the implementation sequence: froze the URL-state and SDK producer interfaces before resuming dependent gallery and toolbar work, then kept integration review and verification in the parent lane.
- Rebuilt the React package and passed the integrated web typecheck, 30 focused web tests, and 6 focused React SDK tests.
- Browser verification found two gaps that component tests missed: the production Participant grid rendered a blank zero-Participant Stage, and the hidden preview-chrome restore control overlapped the mobile dock.
- Added the production Participant-grid empty state and moved preview chrome above the mobile dock with explicit light/dark contrast.
- Verified the Entrance failure screen, Space confirmation dialog, direct Empty deep link, reload persistence, hidden-chrome restoration, and a narrow viewport with no horizontal overflow in Chrome on localhost.
- Tightened the language-ratchet baseline after the preview refactor removed 26 legacy-term occurrences from `apps/web`.

## 2026-08-04 11:52 PKT

- Replaced direct-state document navigations with in-place TanStack search updates while preserving real anchor targets for copying, modified clicks, and new tabs.
- Added focused coverage for the anchor target and in-place state patch.
- Verified the fix in Chrome by editing the Entrance display name, selecting the Warning state, and confirming the edited value survived while the URL and rendered state changed.
- Reduced new legacy identifier occurrences at the SDK boundary and tightened only the `apps/web` vocabulary baseline; unrelated mobile and React Native refactor decreases remain unowned.
