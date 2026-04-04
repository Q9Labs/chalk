## 2026-04-03 11:30:09 PKT

- Task: read and understand the API database architecture, especially relationships and isolation across tenants, rooms, workspaces, users, sessions/accounts, and related auth scope.
- Inspected schema/migrations: `apps/api/db/migrations/001_initial_schema.sql`, `003_tenant_config.sql`, `004_metadata.sql`, `006_transcription.sql`, `008_internal_tenant_users.sql`, `015_workspaces.sql`, `016_tenant_api_key_lookup_hash.sql`.
- Inspected query layer: `apps/api/db/queries/tenants.sql`, `internal_tenants.sql`, `workspaces.sql`, `rooms.sql`, `participants.sql`, `users.sql`, `user_sessions.sql`, `tenant_claims.sql`, `recordings.sql`.
- Inspected runtime/auth/scoping code: `apps/api/internal/interfaces/http/middleware/auth.go`, `handlers/auth.go`, `handlers/internal_auth.go`, `handlers/first_party_scope.go`, `handlers/rooms.go`, `handlers/participants.go`, `handlers/tenants.go`, `internal/domain/room/service.go`, `internal/domain/participant/service.go`, `internal/infrastructure/auth/tenant_lookup.go`, `internal/interfaces/http/router.go`.
- Main findings:
- `tenants` is the primary isolation boundary for the API. Most domain data hangs directly from `tenant_id` or indirectly through `rooms`.
- `rooms` originally belonged directly to a tenant; later `workspace_id` and `created_by_user_id` were added so first-party Chalk apps can scope rooms inside per-user workspaces.
- There is no separate DB `accounts` table in the API. Auth identity is modeled as `users` plus hashed `user_sessions`.
- First-party internal auth now uses a shared internal tenant named `Chalk First Party`, with a personal workspace per user, instead of one internal tenant per user for the steady-state path.
- Temporary anonymous first-party usage is modeled with `tenant_claims`: an unowned internal tenant can be created, claimed later by a user, then marked used.
- Cross-tenant isolation is enforced mainly in application code and SQL query filters, not via Postgres row-level security.
- Important distinction: authenticated first-party `users` are not the same as room `participants`. Participants are room-scoped attendance records and may only carry `external_user_id`.

## 2026-04-03 11:57:25 PKT

- Follow-up analysis: tenant-agnostic mobile participation versus tenant-scoped hosting.
- Inspected mobile client flow: `apps/mobile/src/lib/chalk.ts`, `apps/mobile/src/lib/newMeeting.ts`, `apps/mobile/src/screens/HomeScreen.tsx`, `apps/mobile/App.tsx`, `apps/mobile/src/meeting/MobileMeetingScreen.tsx`.
- Inspected SDK join/auth path: `packages/sdk-core/src/api-client.ts`, `packages/sdk-core/src/client.ts`, `packages/sdk-core/src/conference-client/join-session.ts`, `packages/sdk-core/src/token-provider.ts`.
- Inspected backend public invite flow: `apps/api/internal/interfaces/http/handlers/internal_links.go`.
- Main findings:
- Mobile participant join is already conceptually tenant-agnostic when it starts from a Chalk join token. The app calls the public unauthenticated `/api/v1/public/join-token/exchange`, receives a room-scoped access token plus canonical room id, and then joins using that room-scoped token.
- Mobile meeting creation is not tenant-agnostic. It uses a host token provider backed by a configured API key or local bootstrap-created tenant, then creates rooms via `/api/v1/rooms`.
- The safe bounded direction is: make participant flows tenantless in the app shell, but keep host/admin/create/list flows explicitly tenant-scoped.
- Main risks to watch if proceeding:
- do not accidentally use Chalk first-party/internal auth as a universal tenant override
- do not make room management APIs tenantless just because participant join becomes tenant-agnostic
- be explicit that invite/join artifacts establish room authority for participant entry
- confirm whether the failing real-world path is based on Chalk join links or some tenant-specific deep link format that mobile does not currently parse
