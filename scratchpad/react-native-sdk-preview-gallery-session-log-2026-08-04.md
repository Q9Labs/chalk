# React Native SDK preview gallery session log

## 2026-08-04 14:40 PKT

- Discovery found a development-only `sdk-preview` route with normalized,
  serializable query state for Entrance and Space views. Supported native deep
  links can open a specific state, and release runtimes reject the route before
  rendering the gallery.
- The native gallery renders the production `PreJoinScreen`, `JoiningScreen`,
  `JoinFailedScreen`, `EndScreen`, and `ConferenceView` surfaces over a local,
  deterministic `ChalkProvider` fixture. Entrance and Space states do not
  request device permissions or network access.
- Its URL and control contract exposes only supported native knobs for
  lifecycle state, panels, dialogs, stage, layout, appearance, Participant and
  chat data, microphone, camera, raised hand, and preview chrome. Unsupported
  values normalize away; no toast or transcript controls exist.

## 2026-08-04 14:41 PKT

- Luna orchestration supplied parallel discovery and implementation workstreams
  for the route contract, production surface composition, supported native knobs,
  and React Native lifecycle surfaces. Integration remained in the parent lane,
  preserving the shared worktree and the owned documentation boundary.
- React Native lifecycle surface parity now covers joining message rotation,
  join-failure title, support-code, and back semantics, plus accessible ended
  state actions while retaining existing compatibility props.

## 2026-08-04 14:42 PKT

- Focused verification recorded for the React Native surface: three Vitest
  files with five tests, package TypeScript checks, and the owned formatter
  check passed. Native preview tests cover route and state normalization,
  deterministic fixture snapshots, production surface wiring, and exclusion of
  network and media APIs.
- No production environment, deployment, or external service was touched. The
  preview is development-only and the release bundle uses the non-gallery
  entry stub.
- Verification pending: the parent-owned final gate has not been supplied, so
  this log does not claim the full gate.

## 2026-08-04 15:35 PKT

- Reconciled the handoff with the exact native implementation: Entrance uses
  `PreJoinScreen`, `JoiningScreen`, and `JoinFailedScreen`; Space uses
  `ConferenceView`, `JoinFailedScreen`, and `EndScreen`; all live-space states
  share the local deterministic `ChalkProvider` fixture.
- Controlled mounted-state verification is complete. The key-based remount was
  removed; controlled production state sync keeps `ConferenceView` mounted while
  updating layout, panels, sheets, whiteboard, duration, and leave confirmation.
  The native appearance provider independently syncs palette and texture without
  replacing its mounted child.

## 2026-08-04 15:36 PKT

- Focused identity and hook verification passed: the React Native suite covered
  five files and seven tests, and the mobile controlled-state suite covered ten
  tests. Together they prove the production surface stays mounted while the
  supported state and appearance inputs sync. The full remote gate remains
  pending.

## 2026-08-04 16:14 PKT

- The first isolated staged remote gate stopped at the vocabulary ratchet after
  untracked local changes were not visible; this was recorded as local-blindness
  complaint #3520.
- Luna's glossary pass left mobile with zero legacy-term increases and tightened
  the baseline by `meeting -1`, `conference -1`, and `videoconference -2`.
  The RN baseline tightened by `room -3` and `session -1`.
- The second full gate remains pending.
