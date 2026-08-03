# Space/Episode schema design — contract wave — 2026-08-03

Design for the contract/schema rename wave that carries the durability
re-scoping. Grounded in `apps/api/db/schema.sql` as of `1346f73f` and the
locked rulings in `GLOSSARY.md` and
`scratchpad/ubiquitous-language-decision-session-log-2026-08-03.md`.
Sections marked **DECIDE** need Hasan's call before implementation; everything
else follows mechanically from locked rulings.

## What the current schema gets wrong (per the rulings)

- `rooms` is a durable shell with nothing in it: all policy (three capability
  grids, host-exit, durations) lives per `room_sessions`, so config dies with
  the session instead of living on the Space and snapshotting into Episodes.
- Roles are hard-coded `host/cohost/participant` in check functions
  (`sync_v3_valid_role_capabilities`), with a one-host-per-session unique
  index. Ruling: roles are customer-definable bundles with shipped defaults
  owner/collaborator/observer and no built-in host.
- `sync_chat_streams` and `sync_whiteboard_scenes` are keyed
  `(tenant, room, session)` and die with the session. Ruling D3: both are
  Space-scoped canonical content that Episodes write into.
- There is no durable Space membership and no external identity: `users` is a
  global email-keyed account table serving both console staff and end users,
  and `memberships` is tenant-level console access. Rulings D2 and the
  identity lock: registered identities are per-tenant, keyed by the
  customer's `external_id`, and Members attach Space+Role to them.
- The capability vocabulary contains `endMeeting`.

## Target tables

### spaces (renames rooms, absorbs policy)

Keeps: id, tenant_id, name, slug `unique(tenant_id, slug)` (the join target),
media_plane, metadata, recurring_policy, created_by. Gains the config that
moves up from per-session:

- `admission_policy` (open / knock / members_only shape, jsonb)
- `default_episode_duration_seconds` and the ceiling pair (the tenant hard
  ceiling stays a ceiling; live extensions are capability-gated)
- `linger_window_seconds` for natural end (last leave + linger)

`status` on rooms today is lifecycle noise; a Space is created and lives.
Keep only if something real reads it (verify during implementation).

### space_roles (new; replaces the hard-coded grids)

`(id, tenant_id, space_id, name, capabilities text[])`, unique per space on
name. Seeded on Space creation with the three defaults: **owner** (all),
**collaborator** (publish media, subscribe, raise hand, rename self, send
chat and reactions, draw whiteboard), **observer** (subscribe, send
reactions). Default bundles are product taste and adjustable; the mechanism
is not. Customers rename, edit, and add roles freely, including calling one
"host". Capability names are validated against the closed set below; the
three separate grids (media, room-action, whiteboard) collapse into this one
namespace.

### episodes (renames room_sessions)

Keeps: id, space_id, tenant_id, status (active/ending/ended), started_at,
ended_at, metadata, the deadline machinery exactly as built (deadline_at,
deadline_generation, generation-advance trigger). Gains:

- `config_snapshot` jsonb not null: the full frozen copy of Space policy at
  start (roles with capabilities, admission policy, durations, linger). One
  document, one immutability trigger blocking any update to it. This replaces
  the three per-session grid columns and their per-column immutability
  checks.
- `end_reason` text check in ('explicit', 'natural', 'deadline').

Dies: `host_exit_policy` (require_transfer / promote_cohost) and the
one-host-per-session index. Both exist only because host is a built-in role.
With customer-defined roles there is no platform notion of "the host left";
natural end + linger covers the empty-room case, and role assignment is a
generic capability-gated action. **DECIDE** below.

### identities (new; the external-identity lock)

`(id, tenant_id, kind check in ('user','agent'), external_id, display_name,
metadata)`, `unique(tenant_id, external_id)`. Chalk mints id; external_id is
the customer's reference and never the primary key. Agents are rows of kind
'agent', full peers. Guests have no row: a guest is an episode-scoped
admission with an expiring role, which is already what
`sync_admission_requests` models. Promotion to Member creates the identity
row (via the customer's backend or identity handshake) and then a
space_members row.

The existing `users` + `auth_identities` + `memberships` tables are a
different bounded context: Chalk's own console (dashboard staff, org roles
owner/admin/member/viewer). They stay untouched this wave. Chalk's own web
app then consumes the platform like any customer: its signed-in users map to
`identities` rows in its tenant. `participants.user_id` therefore becomes
`identity_id`.

### space_members (new; D2)

`(id, tenant_id, space_id, identity_id, role_id references space_roles)`,
`unique(space_id, identity_id)`. This is what standing access, durable roles,
dormant-roster visibility, and history continuity hang off.

### participants (stays; re-keyed to episodes)

Per-episode seats, as today: episode_id (was session_id), identity_id
nullable (null = guest) with guest display name, the resolved role name +
capabilities frozen at admission (today's `capabilities text[]` already does
this), generation, status, joined_at/left_at. This row set is the Episode's
attendance record, which the metrics ruling wants per-participant, so it
gains nothing and loses only `eligible_roles`/role check constraints tied to
the fixed three roles.

### Sync tables: the re-keying rule

Every `sync_*` table falls into one of two buckets:

- **Live coordination** (session_control, lifecycle_intents, control_events,
  command_receipts, admission_requests, screen_share_leases,
  publication_fences, grant_reservations, external_operations,
  sync_recordings): Episode-scoped. `session_id` becomes `episode_id`,
  nothing else moves.
- **Content** (chat_streams, chat_messages, chat_attachments,
  chat_read_receipts, whiteboard_scenes, whiteboard_elements,
  whiteboard_permissions, whiteboard_operation_receipts, whiteboard_files):
  Space-scoped canonical copies. Primary keys re-anchor from
  `(tenant, session)` to `(tenant, space)`; rows gain an `episode_id` stamp
  recording which Episode wrote them (chat messages, whiteboard operations).
  Episode chat ranges and whiteboard activity are derived from the stamps,
  not stored copies. The stream/scene quota checks carry over per Space.

Recordings/transcripts pipelines already attach to sessions and simply follow
the episode rename; they are Episode artifacts.

The optional "clear Space state" action truncates Space content under a
`clearSpaceContent` capability; it is an explicit command, never automatic.

### Capability vocabulary (closed set, replaces the three namespaces)

publishAudio, publishVideo, publishScreen, subscribe, raiseHand, renameSelf,
sendChat, sendReaction, drawWhiteboard, manageWhiteboard, manageAdmission,
assignRoles, muteOthers, stopVideoOthers, stopScreenOthers,
requestMediaOthers, removeParticipant, manageRecording, startEpisode,
extendEpisode, endEpisode, manageMembers, clearSpaceContent.

Renames within it: `endMeeting` becomes `endEpisode`; `promoteDemote` and
`transferHost` collapse into `assignRoles` (generic role assignment).
Casing stays camelCase to match the existing wire style; these are wire
identifiers, not error codes.

## DECIDE (Hasan)

1. **Migration shape: squash to a clean baseline (my rec) or additive rename
   migrations.** No users exist. A clean baseline (rewrite schema.sql plus
   the embedded startup migrations, recreate deployed databases) is honest
   and cheap now and never again; additive migrations preserve the prod repro
   data and the migration-history habit at the cost of a long, lying rename
   chain. Rec: squash, and accept losing existing prod rows.
2. **Kill host_exit_policy and one-host-per-session.** Entailed by
   customer-defined roles, but it deletes a shipped behavior (host transfer
   ceremony), so saying it out loud: the platform no longer knows what a
   "host" is; products build transfer ceremonies from assignRoles. Rec: kill.
3. **One capability namespace** instead of media/room-action/whiteboard
   grids, with the closed set above. Rec: yes; the split was an
   implementation artifact.
4. **Chat posting requires a live Episode** (the D3 corollary): every chat
   message and whiteboard operation carries a non-null episode_id; reading is
   always allowed. Keeps Chalk out of async-messaging scope for now, and the
   stamp is how Episode ranges are derived. Rec: yes initially.
5. **Default role bundles** for owner/collaborator/observer as listed under
   space_roles. Taste call, cheap to change later.

## Execution shape (after DECIDE)

One wave, one worktree: schema + migrations, sqlc regeneration, Go domain
renames along the chain (service/repository/HTTP), sync-server Elixir
authority keys (Session → Episode, the `Live.Session` and
`Sessions.Coordinator` true names land here), contract JSON schemas + codegen
so the SDK sees spaces/episodes, and the route surface (`/spaces`,
`/spaces/{id}/episodes`). The client SDK wave (ChalkSession split) follows on
top of the regenerated contract. Wave zero (sync v1 renumber) must merge
first; this wave builds on it.
