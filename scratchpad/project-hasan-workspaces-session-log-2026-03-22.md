# Workspace Migration Session Log

- 2026-03-22 17:17:26 PKT
  Scope: implement first-party `tenant -> workspace -> room` shift for Chalk web/dashboard without changing mobile host flow.

- 2026-03-22 17:17:26 PKT
  Backend:
  Added `workspaces` + `workspace_memberships`, backfill migration, shared first-party tenant bootstrap, `rooms.workspace_id`, `rooms.created_by_user_id`, workspace-aware SQL queries, JWT `workspace_id`, shared-tenant/personal-workspace auth resolution, workspace-scoped meeting/recording listing, and room-access helpers.

- 2026-03-22 17:17:26 PKT
  Join-path change:
  first-party joins now require canonical room UUID / room-scoped token; legacy room-name auto-create stays only on non-workspace flows. Goal: kill same-code/different-Cloudflare-room fork.

- 2026-03-22 17:17:26 PKT
  Web + SDK:
  `/j/:joinToken` now redirects by `room_id`, join context keys by room UUID, room page mints/shows real guest `/j/:token` links, SDK meeting room accepts explicit `meetingLink` so invite modal/toast stop copying host URL.

- 2026-03-22 17:17:26 PKT
  Verification:
  `go test ./internal/interfaces/http/handlers ./internal/domain/participant ./internal/domain/room ./internal/infrastructure/auth`
  `bun test apps/web/src/lib/internalAuth.test.ts apps/web/src/lib/joinLinkRedirect.test.ts`
  `bun run lint`
  `bun run check-types`
  `bun run test`

- 2026-03-22 17:17:26 PKT
  Follow-up:
  mobile still uses legacy host/API-key path; not migrated to workspace-aware first-party auth in this pass.

- 2026-03-22 18:18:00 PKT
  Browser join flake follow-up:
  fixed web root auth selection so `/room/*` and `/j/*` always use room-scoped/internal token resolution even when `VITE_CHALK_API_KEY` is present, and added route-sensitive `ChalkProvider` session cache keys so stale SDK auth state is disposed on room/auth context switches.

- 2026-03-22 18:18:00 PKT
  Browser proof:
  two isolated browsers opened the same `/j/:token`, both redirected to the same canonical `/room/ab4bbc6b-e337-4ea4-a4e6-0b5f1eaaa9fd?roomName=Browser+Proof+Workspace+Room`, both joined successfully after triggering the prejoin CTA, and backend verification showed `active_participant_count=2` on one room with one `cloudflare_meeting_id=bbb66318-e7d3-49e7-bfe4-b356d058c527`.

- 2026-03-22 18:18:00 PKT
  New blocker found while trying exact "host browser creates room" proof:
  internal room creation can 500 with `rooms_created_by_user_id_fkey` if a local first-party token subject parses as a UUID that does not exist in `users`. Not fixed in this browser-join pass.
