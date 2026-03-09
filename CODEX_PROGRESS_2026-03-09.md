## 2026-03-09

- 00:11 PKT - scoped `/new` instant-room route + in-room self-rename support; traced SDK-first path and confirmed backend participant update endpoint already exists.
- 00:29 PKT - added `/new` route that creates a room then redirects to `/room/$roomId?autoJoin=true`; room route now reads `autoJoin` and hydrates join defaults/name from storage synchronously.
- 00:40 PKT - wired `VideoConference autoJoin` prop into controller one-shot join flow; kept self-rename on the existing SDK path and added focused sdk-core/sdk-react regressions.
- 00:47 PKT - fixed API participant update broadcast to emit the websocket envelope the SDK actually consumes; added Go regression for structured `participant.updated`.
- 00:58 PKT - verified focused sdk-core test, focused sdk-react participant-list test with preload, API participant tests, and `apps/web` production build; web `tsc` still hits unrelated dirty-tree RealtimeKit version mismatch.
- 00:41 PKT - traced missing screen-annotation UI to non-optimistic local session activation; patched `ScreenAnnotationsManager` to seed local share-session/access state immediately and added focused sdk-core regression coverage.
- 01:13 PKT - traced stuck “Connecting annotations...” state to an eager local `requestSync()` race in `ScreenAnnotationsLayer`; local sharer now skips the immediate sync once its own session is active, and a focused sdk-react regression locks that behavior.
- 01:22 PKT - reset the annotation bootstrap latch only on active→inactive transitions so the local sharer can recover from stale session drops without spawning repeated retry timers; added focused layer regressions for open/start and owner-session no-sync behavior.
2026-03-09 14:22:21 PKT
- sdk-react/sdk-core tests start leak investigation; inspect runners/setup; reproduce pending
- 2026-03-09 14:29:00 PKT
- root cause: `turbo test` depended on `build`, fan-out into docs/admin/web + package builds at high concurrency; removed build dependency from `test` task
- 2026-03-09 15:12:00 PKT
- added annotation incident + wide-event telemetry: sdk-core manager lifecycle events, sdk-react UI breadcrumbs around open/sync/fallback, and verified existing websocket-side annotation logs are present on the API path.
