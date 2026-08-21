# SDK Preview Parity Work Log

## 2026-08-20

- Confirmed the production baseline is `SpacePage -> Chalk -> Entrance/SpaceView`; the preview reuses `SpaceView` but replaces lifecycle surfaces and supplies a reduced local snapshot.
- Defined parity as deterministic production-visible state with local adapters. Production, RealtimeKit, real media permissions, and real diagnostics remain out of scope.
- Found existing staged and unstaged work across the preview and React Space files. All implementation lanes must preserve those changes and use disjoint write sets.
- Two critique lanes verified missing state dimensions, a nondeterministic snapshot clock, no-op command ambiguity, toolbar focus gaps, and the conflict between production status reuse and the original no-production-edit scope. The spec now permits behavior-preserving shared presentation extraction and defines canonical state plus command outcomes.
- Integration review caught a Role/Capability coupling that violated the glossary. The contract now keeps Role labels independent and gates UI authority only from capabilities.
- Integrated the state, lifecycle, media, whiteboard, and gallery lanes. The preview now renders the production Entrance/status/Space surfaces with deterministic local adapters and URL-addressable parity controls.
- Remote focused verification on `agents-macmini` passes: 67 web tests, 17 React tests, and the web and React TypeScript checks. The remote test workspace is `/tmp/chalk-sdk-preview-parity-20260820-01a01dd3`; no production environment or deployment was touched.
- Started a fresh-context Helium dogfood pass through a local tunnel at `http://127.0.0.1:3079/sdk-preview` before the full repository gate.
- The first Helium pass covered the Entrance and Space lifecycle states, media states, roster sizes, shares, requests, admission, diagnostics, whiteboard, capabilities, features, theme controls, toolbar focus, and malformed URL normalization. It found one high defect: the visible Space Settings button did not project `dialog=settings`, although the tweaker-forced dialog rendered correctly.
- Wired the visible Space Settings command to `dialog=settings`, added a regression test, and reverified the exact click path in Helium. The final clean pass covers Entrance, Space, Settings, the real whiteboard, and a 12-Participant roster.
- Normalized and frame-inspected the 11-second clean recording, uploaded it to the Drive `recordings` folder, shared it read-only to anyone with the link, and verified HTTP 200.
- The first full gate attempt exposed a disposable-remote setup error: its empty Git index hid workspace manifests from the gate planner. Committing a current-tree snapshot inside the disposable repository made all 34 routing self-tests pass; the full-mode gate rerun is the authoritative result.
- The faithful full-mode gate passed all 38 routing tests but stopped at the vocabulary ratchet because unrelated shared-worktree edits added four banned-term counts in dashboard auth, a Stage comment, and a gate fixture. The parity-owned files contain no such added terms, so those other owners must resolve their changes before the whole shared tree can pass.
- A concurrent tabbed tweaker refactor arrived after the first clean pass. Synced its helper modules, updated the toolbar tests for tab navigation and persisted preferences, and reverified 75 web tests plus web typecheck.
- The final current-tree Helium pass verified all five tweaker tabs, dock persistence, the backtick shortcut, focus and Escape behavior, Settings, the real whiteboard, and 12 Participants. Its replacement recording was normalized, frame-inspected, uploaded, shared read-only, and verified with HTTP 200; the superseded first upload was moved to Drive trash.
