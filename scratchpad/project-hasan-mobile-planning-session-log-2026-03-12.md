# Chalk Mobile Planning Session Log — 2026-03-12

Append-only. Short entries. No secrets.

- `2026-03-12 16:53 PKT` official cross-platform app discussion started. Evaluated `React Native` vs `Flutter` for Chalk-specific realtime/mobile needs.
- `2026-03-12 16:54 PKT` hard-native feasibility check covered: WebRTC bridge quality, CallKit / Android ConnectionService, push + wake + rejoin, screen share, audio interruptions / Bluetooth. Conclusion: all feasible in `React Native`, with native work required for call-critical paths.
- `2026-03-12 16:55 PKT` stack direction locked: `React Native`.
- `2026-03-12 16:56 PKT` planning correction: keep product language role-neutral; use existing neutral terms already present in the codebase for naming consistency.
- `2026-03-12 16:58 PKT` product decisions updated: auth-less by default for joining meetings; optional Google sign-in for dashboard-style access such as transcripts. `Chat` confirmed as `V1`. Product target clarified: mobile should stay as close to the current web experience as practical.
- `2026-03-12 17:01 PKT` repo parity check: existing neutral terms are already `participant`, `host`, and fallback `guest`. Current web entry points are `join link` (`/j/$joinToken`), direct `room` route (`/room/$roomId`), dashboard internal-entry flow (`?auth=internal`), and public recording/transcript share links (`/share/$token`). This aligns well with the mobile direction of auth-less join plus optional dashboard sign-in.
- `2026-03-14 09:05 PKT` scope cut approved after first Android bring-up: mobile V1 is now meeting-only. Removed auth, dashboard, history, account, and public share-detail work from the active plan. Focus narrowed to `join existing meeting`, `create new meeting`, `lobby/prejoin`, and `live meeting room` correctness so implementation energy stays on the highest-signal product slice.
