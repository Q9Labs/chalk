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
