## 2026-03-23

### 16:02 PKT
- Goal: fix SDK-side `room not found` regressions after room identity tightened around canonical UUIDs and join tokens.
- Scoped mainline work to Chalk packages first, then consumer upgrades after package publish.

### 16:08 PKT
- Added core invite-link parsing utility and cached `createJoinTokenProvider`.
- Added `ConferenceClient.joinWithJoinToken` and `ConferenceClient.joinWithInviteLink`.
- Added `ChalkSession.joinWithJoinToken` and `ChalkSession.joinWithInviteLink`.

### 16:13 PKT
- Added React support for `joinToken` / `inviteLink` on `VideoConference`.
- Wired new helpers through `ChalkProvider`, `useConnection`, and `useJoinFlow`.
- Updated docs/examples away from friendly string room ids toward canonical UUIDs and invite links.

### 16:20 PKT
- Added core and React regression coverage for join-token provider and invite-link join paths.
- Full gate initially caught stale retry assertions in `packages/sdk-core/src/__tests__/client.test.ts`; updated expectations to current timeout retry semantics.

### 16:26 PKT
- Full repo gate green on rerun: lint, typecheck, tests.
- Release bump target: `0.0.79`.
- Consumer rollout split in parallel: release worker + consumer worker.
