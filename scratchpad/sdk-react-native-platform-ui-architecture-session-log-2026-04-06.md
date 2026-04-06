## 2026-04-06 14:33:44 PKT

- Task: Inspect `packages/sdk-react-native/src/components` and propose a practical platform-separated meeting UI architecture for Android, iOS, iPadOS, macOS, with tvOS considered as a future platform.
- Scope: Recommendation only. No implementation requested.
- Read:
  - `packages/sdk-react-native/src/components/NativeVideoConference.tsx`
  - `packages/sdk-react-native/src/components/NativeMeetingRoom.tsx`
  - `packages/sdk-react-native/src/components/NativeMeetingPanel.tsx`
  - `packages/sdk-react-native/src/components/NativeMeetingActionsSheet.tsx`
  - `packages/sdk-react-native/src/components/native-meeting-room/NativeMeetingStage.tsx`
  - `packages/sdk-react-native/src/components/native-meeting-room/NativeMeetingGrid.tsx`
  - `packages/sdk-react-native/src/components/NativePreJoinLobby.tsx`
  - `packages/sdk-react-native/src/components/NativeJoiningLoadingScreen.tsx`
  - `packages/sdk-react-native/src/components/NativeEndScreen.tsx`
  - `packages/sdk-react-native/src/components/NativeMediaView.tsx`
  - `packages/sdk-react-native/src/components/NativeReactionPicker.tsx`
  - `packages/sdk-react-native/src/components/native-meeting-room/useNativeMeetingRoomDerived.ts`
  - `packages/sdk-react-native/src/utils/native-meeting-layout.ts`
  - `packages/sdk-react-native/src/hooks/usePanels.ts`
  - `packages/sdk-react-native/src/hooks/useLayout.ts`
- Key observations:
  - `NativeMeetingRoom` is the orchestration hotspot and currently owns both shared state wiring and direct UI for top bar, stage, dock, sheet, panel, and reactions.
  - `NativeMeetingGrid` already mixes phone and tablet layout rules in one file.
  - `NativeMeetingPanel` and `NativeMeetingActionsSheet` are strongly mobile-sheet oriented, which will not scale cleanly to macOS and likely not to iPadOS.
  - `NativeVideoConference` lifecycle flow is comparatively thin and can remain shared longer if desired.
- Next: deliver architecture recommendation with explicit keep-shared vs split guidance, folder boundaries, phased migration, and risks.

## 2026-04-06 15:07:34 PKT

- Clarified screen ownership:
  - `PreJoinLobby` is currently a single shared SDK component in `packages/sdk-react-native/src/components/NativePreJoinLobby.tsx`.
  - `MeetingRoom` is currently a single shared SDK component in `packages/sdk-react-native/src/components/NativeMeetingRoom.tsx`.
  - `HomeScreen` is app-owned, not part of `sdk-react-native`, and currently lives at `apps/mobile/src/screens/HomeScreen.tsx`.
- Clarified current state:
  - Screen-level JSX is still mostly shared today across platforms.
  - Current separation is mainly runtime branching (`Platform.OS`, width/compact checks, modal/sheet assumptions), not file-level platform isolation.
- Product-direction agreement from discussion:
  - Explicit platform separation is desired for `PreJoinLobby` and `MeetingRoom`.
  - `HomeScreen` should stay mostly shared for now, with layout-only splits for iPadOS and macOS first.
  - `NativeFaceAvatar` should be shared across platforms.
  - `NativeMediaView` is also approved to stay shared across platforms.
  - Foundation sharing is desirable: core design system, theme tokens, colors, typography, blur, animations, borders, buttons, and related primitives should be shared by default unless a platform has a strong reason not to use them.
- Architecture rule refined:
  - Share foundation + logic.
  - Keep screen chrome and layout platform-owned.
  - Prefer duplicate JSX/styles over cross-platform conditional UI when that reduces regressions.
- Created draft spec:
  - `scratchpad/sdk-react-native-platform-ui-architecture-spec-2026-04-06.md`

## 2026-04-06 15:16:39 PKT

- Additional alignment captured:
  - `NativeReactionPicker` should stay shared as a primitive for now and only split later if needed.
  - Chat bubble visuals can stay shared for now even when panel shells split by platform.
  - The shared design system/foundation for this effort should live inside `sdk-react-native`.
- Lifecycle surface decision:
  - `JoiningLoadingScreen` should also split by platform.
  - `EndScreen` should also split by platform.
- Implementation intent clarified by Hasan and adopted into the spec:
  - the platform split is an architecture/isolation pass first, not a design pass
  - separate platform files without materially changing the current UI
  - preserve existing look/behavior as closely as possible while moving to platform-owned JSX
  - defer intentional platform-specific UI improvements to a later frontend design expert pass
- Key phrasing to preserve in the final spec:
  - adjust the JSX/code structure without intentionally adjusting the UI itself yet
  - isolate first, redesign later

## 2026-04-06 15:32:35 PKT

- Spec audit notes to discuss before final approval:
  - Need an explicit platform-variant selection rule for iPadOS and macOS rather than implying filename resolution alone will handle all cases.
  - Need a dependency/boundary note for `HomeScreen` consuming shared DS/foundation from `sdk-react-native` since `HomeScreen` is app-owned.
  - Need explicit parity verification guidance so the isolation pass does not accidentally drift the UI while splitting files.
- Requested next deliverable:
  - a chronological execution checklist separated into logical phases so it can be incorporated into the final spec.

## 2026-04-06 16:06:58 PKT

- Execution strategy refinements requested:
  - precondition-style planning phases should be excluded from the execution spec
  - `PreJoinLobby` controller extraction should be its own sub-phase
  - `MeetingRoom` controller extraction should be its own sub-phase
  - `JoiningLoadingScreen` split should be its own sub-phase
  - `EndScreen` split should be its own sub-phase
  - Phase 10 should include a `gpt-5.4` high-reasoning subagent review against the spec
  - checklist execution should be dependency-tracked to reduce conflicts during implementation
- Blindspots identified for clarification in spec:
  - explicit platform-variant resolution
  - file naming/export selection pattern
  - `HomeScreen` boundary for shared foundation consumption
  - definition of parity for the isolation pass
  - allowed functional deviations
  - state ownership boundaries
  - explicit parallelization rule

## 2026-04-06 16:29:50 PKT

- Parallelization direction refined:
  - shared foundation extraction / contract establishment may be delegated to a blocking subagent
  - the main agent should explicitly own the remaining central responsibilities and orchestration
  - preferred parallelization model remains platform-scoped ownership after contracts are stable
  - “Waves” framing is preferred language for the execution strategy section

## 2026-04-06 16:33:24 PKT

- Finalized the spec:
  - changed status from draft to final
  - converted remaining ambiguity items into explicit execution rules
  - locked platform variant resolution, file selection/export pattern, `HomeScreen` shared-foundation boundary, parity definition, allowed deviations, state ownership, and parallelization conditions
- Final spec path:
  - `scratchpad/sdk-react-native-platform-ui-architecture-spec-2026-04-06.md`

## 2026-04-06 17:28:10 PKT

- Started implementation of final platform UI spec.
- Worktree was clean on `master`; creating branch `feat/sdk-rn-platform-ui-split`.
- Next: establish shared foundation/variant routing, then extract controllers, then split platform-owned renderers phase by phase.

## 2026-04-06 18:02:11 PKT

- Implemented the structural platform split across the current scope of the spec:
  - added shared platform variant resolution in `sdk-react-native`
  - moved shared foundation exports into `sdk-react-native` for cross-surface consumption
  - split `PreJoinLobby` into platform-owned renderer files with a shared controller
  - split `JoiningLoadingScreen` and `EndScreen` into platform-owned renderer files
  - split `MeetingRoom` into a platform router plus platform-owned shells
  - split the core `MeetingRoom` surfaces (`TopBar`, `Stage`, `BottomDock`, `ActionSheet`, `Panel`) into platform-owned renderer files
  - split `HomeScreen` routing so iPadOS and macOS now own separate layout files while Android and iPhone remain on the shared path
- Current focus moved to stabilization and verification:
  - fix controller/router mistakes introduced during the split
  - run root-level lint, typecheck, and tests from the workspace context
  - patch any parity-preserving breakages surfaced by the gate

## 2026-04-06 18:51:44 PKT

- Stabilization / verification pass results:
  - fixed the shared `MeetingRoom` controller so `roomName` now resolves from the screen props or active room state instead of the unrelated `features` object
  - `sdk-react-native` tests passed after the split via `pnpm --dir packages/sdk-react-native run test`
  - `git diff --check` passed with no whitespace/conflict-marker issues
- Workspace gate status:
  - root `bun run lint` and `bun run check-types` are currently blocked by pre-existing workspace dependency / build issues centered in `packages/sdk-core`
  - root `bun run test` is currently blocked by unrelated workspace test-environment issues, including missing `@mdx-js/rollup` for `apps/web`
  - `pnpm --dir apps/mobile run test` is currently blocked by missing `effect` resolution from `packages/sdk-core`
  - package-local `lint` for `sdk-react-native` and `apps/mobile` is currently blocked by missing local install/type environment state (`react`, `react-native`, built `sdk-core` declarations, `expo/types`)
- Current conclusion:
  - the platform split implementation is structurally complete for the requested phases
  - remaining verification blockers are environment / workspace-state issues outside the migration scope, not newly identified logic regressions inside the split itself

## 2026-04-06 18:50:27 PKT

- Verification pass status:
  - root `bun run lint` and `bun run check-types` are blocked by pre-existing workspace issues in `packages/sdk-core` plus missing local dependency/type resolution (`effect`, `@cloudflare/*`, built `sdk-core` declarations, etc.)
  - root `bun run test` is blocked by unrelated monorepo test environment issues, including missing `@mdx-js/rollup` for `apps/web`
  - `pnpm --dir packages/sdk-react-native run test` passed (`10` files, `35` tests)
  - `pnpm --dir apps/mobile run test` is blocked by the same underlying missing `effect` dependency chain through `packages/sdk-core`
  - package-local lint runs for `sdk-react-native` and `apps/mobile` are also blocked by missing local install/type state (`react`, `react-native`, `expo/types`, built declarations), not by a newly surfaced migration-specific runtime failure
- Migration-specific stabilization completed:
  - fixed the shared `MeetingRoom` controller to derive `roomName` from `NativeMeetingRoomProps` / room state rather than a non-existent feature flag field
  - normalized generated split files with `oxfmt`
  - confirmed `git diff --check` is clean
- Final phase review requested:
  - spawned a `gpt-5.4` high-reasoning review pass against the finalized platform split spec before handoff
