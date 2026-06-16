# Permissions, Trust, and Moderation Deep Dive

Research date: 2026-05-30

Scope: Chalk tenant policies, roles, JWT/session refresh, room/participant APIs,
host controls, recording, whiteboard permissions, mute/kick, API/SDK
authorization, and lessons from LiveKit, Matrix, Discord, Jitsi,
BigBlueButton, and Google Meet.

## Executive Summary

Chalk should move from role strings and JWT boolean permissions toward a
server-authoritative capability model. Roles should remain product vocabulary
and UI defaults, but all sensitive decisions should be evaluated by a single
authorizer against tenant policy, room policy, durable room-control state,
participant status, explicit grants/denies, and active session state.

The highest-risk current gap is participant role escalation during join. The
SDK forwards `options.role`; the API accepts `role` on `POST
/rooms/:id/participants`; public join-token exchange mints a room-scoped
participant token; and `JoinRoom` honors an input role of `host`. That creates a
likely path where a public invite can request `role: "host"` and receive host
capabilities.

Kick/revoke semantics are also too soft. Chalk removes the participant from
Cloudflare and marks them left, but WebSocket handshakes validate only the JWT
and do not re-check active participant/session status. A kicked participant can
likely reconnect to Chalk signaling until the access token expires. The WS
handler also intentionally does not disconnect on token expiry.

Whiteboard permissions are split-brain today. A `whiteboard_permissions` table
exists, but grant/revoke is in-memory only. Cross-instance pub/sub rebroadcasts
permission events to clients without applying them to the receiving instance's
local enforcement map, so one instance can show a permission change while still
enforcing stale local policy.

Moderation should be represented as durable room-control events. Matrix shows
the value of modeling moderation as room state; LiveKit shows token revocation
and participant permission updates must be tied together; Discord shows
permission precedence must be deterministic; Google Meet and BigBlueButton show
host locks and role changes must apply to late joiners. Chalk should add
append-only `room_control_events` plus a materialized `room_policy_state`.

The SDK should expose permission state as a versioned, possibly stale snapshot,
not as a promise of authorization. UI can use `can(...)` hints to enable
controls, but every mutation must be prepared for a server 403 with a current
decision reason and policy version.

## Current Chalk Findings

Line numbers refer to the working tree on 2026-05-30.

### Current Permission Shape

Chalk's JWT claims carry both identity and authorization hints:

- `apps/api/internal/domain/auth/types.go:9` defines `Claims` with tenant,
  workspace, room, display name, `Role`, `Permissions`, and Cloudflare auth
  token.
- `apps/api/internal/domain/auth/types.go:28` defines only four permission
  booleans: `CanRecord`, `CanScreenShare`, `CanKick`, `CanMute`.
- `apps/api/internal/domain/auth/types.go:36` grants hosts all four booleans
  and participants only screen-share by default.
- `apps/api/internal/infrastructure/auth/jwt.go:29` defaults access tokens to
  15 minutes and refresh tokens to 7 days.
- `apps/api/internal/infrastructure/auth/jwt.go:62` embeds role and permission
  booleans into access tokens.
- `apps/api/internal/infrastructure/auth/jwt.go:88` creates refresh tokens with
  tenant and subject only. They do not carry room, participant, session, token
  version, or revocation identifiers.
- `apps/api/internal/infrastructure/auth/jwt.go:130` validates signature,
  expiration, and type. It does not check tenant active status, participant
  liveness, room status, session revocation, or policy version.

The middleware then treats those JWT fields as authority:

- `apps/api/internal/interfaces/http/middleware/auth.go:30` validates JWTs and
  stores claims in request context.
- `apps/api/internal/interfaces/http/middleware/auth.go:68` has
  `RequirePermission(check)` which evaluates the permission booleans from the
  JWT.
- `apps/api/internal/interfaces/http/middleware/auth.go:98` has `RequireHost`,
  which only checks `claims.Role == "host"`.

This is workable for a prototype, but it makes tokens the permission source of
truth. Any role change, kick, room policy update, tenant lock, or per-participant
override can become stale until token expiry unless every enforcement point also
checks authoritative state.

### Tenant and Room Policy Surface

There are early signs of a policy layer:

- `apps/api/internal/infrastructure/postgres/postgres.go:130` creates
  `whiteboard_config` with defaults such as `default_access: "all"` and
  `host_can_override: true`.
- `apps/api/internal/infrastructure/postgres/postgres.go:138` creates
  `tenant_config` defaults including recording behavior, duplicate join policy,
  retention days, timeout behavior, and `allow_early_join`.
- `apps/api/internal/infrastructure/postgres/postgres.go:250` creates a
  `whiteboard_permissions` table keyed by `room_id` and `participant_id`.

The issue is that the policy is not yet joined up. Critical room-control state
is not modeled as durable state, and the existing whiteboard table is not used
by WebSocket grant/revoke enforcement.

### Route-Level Enforcement

The router has mixed route-level and handler-level checks:

- `apps/api/internal/interfaces/http/router.go:267` protects `/rooms` with JWT.
- `apps/api/internal/interfaces/http/router.go:271` makes create/schedule/list
  host-only, and `router.go:285` makes update/delete/end host-only.
- `apps/api/internal/interfaces/http/router.go:289` exposes
  `POST /:id/participants` without `RequireHost`; that is necessary for joins,
  but it means the handler must strictly control requested roles.
- `apps/api/internal/interfaces/http/router.go:290` exposes participant update
  without route-level host checks; the handler partially gates it.
- `apps/api/internal/interfaces/http/router.go:292` makes participant delete
  host-only.
- `apps/api/internal/interfaces/http/router.go:304` makes join-token creation
  host-only.
- `apps/api/internal/interfaces/http/router.go:307` makes room recording
  start/stop/archive/sync host-only.
- `apps/api/internal/interfaces/http/router.go:345` protects global
  `/recordings` with `CanRecord`, and share token creation is also host-only.

The route map is not inherently wrong, but it highlights why role and
capability checks need to happen after the concrete resource is loaded. A
room-scoped participant token can be allowed to join, but it must not be
allowed to choose a host role or mutate another participant.

### Highest-Risk Gaps

| Severity | Finding                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why It Matters                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Public join-token users can likely self-promote to host by sending `role: "host"`.                                                      | Public exchange mints a room-scoped participant token in `apps/api/internal/interfaces/http/handlers/internal_links.go:83`; `AddParticipant` accepts role from request body in `apps/api/internal/interfaces/http/handlers/participants.go:76`; `JoinRoom` honors `input.Role == "host"` in `apps/api/internal/domain/participant/service.go:461`; SDK forwards role in `packages/sdk-core/src/conference-client/join-session.ts:50` and `packages/sdk-core/src/api-client.ts:372`. | Host role unlocks host-only room controls, participant removal, recording start/stop, and join-token creation.                                                              |
| Critical | Kick/revoke does not immediately revoke Chalk signaling access.                                                                         | WS validates JWT only in `apps/api/internal/interfaces/http/handlers/websocket.go:60`; the handler comments that it does not proactively disconnect on JWT expiry at `websocket.go:140`; it parses participant ID after upgrade at `websocket.go:274` but does not reject inactive/left/kicked participants. `KickParticipant` marks a participant left after removing from Cloudflare in `apps/api/internal/domain/participant/service.go:954`.                                    | A removed participant can reconnect to Chalk WS with a stale JWT and keep using non-Cloudflare signaling paths until token expiry.                                          |
| High     | Participant update, kick, and refresh use the path room for authorization but do not prove the target participant belongs to that room. | Update path checks room access, then calls service with the target ID in `apps/api/internal/interfaces/http/handlers/participants.go:280`; kick does similar at `participants.go:396`; token refresh at `participants.go:444` calls `RefreshToken(participantID)` without room match. Service-side `KickParticipant` loads participant by ID and room by path room at `apps/api/internal/domain/participant/service.go:954`.                                                        | This is a confused-deputy shape: a valid host on room A can potentially act on a participant ID from room B if the ID is guessed or leaked.                                 |
| High     | Whiteboard permission grants are local-memory only and diverge across instances.                                                        | Hub keeps `whiteboardPermissions` in memory at `apps/api/internal/interfaces/websocket/hub.go:61`; grants/revokes mutate memory in `apps/api/internal/interfaces/websocket/client.go:674` and `client.go:708`; room cleanup clears memory at `hub.go:379`; Redis fanout rebroadcasts messages at `hub.go:711` without applying permission state to the remote instance's enforcement map.                                                                                           | In a multi-instance deployment, the same participant may be allowed on one instance and denied on another.                                                                  |
| High     | Participant tokens generated by normal join/refresh omit permission booleans.                                                           | `JoinRoom` token generation passes role and Cloudflare token but omits `Permissions` at `apps/api/internal/domain/participant/service.go:513` and `service.go:582`; participant refresh omits permissions at `service.go:991`.                                                                                                                                                                                                                                                      | Role and permission booleans can disagree. `RequireHost` may pass while `CanRecord` fails, or future checks may silently deny legitimate hosts.                             |
| Medium   | Recording room state changes do not appear to broadcast recording events.                                                               | Recording message types exist in `apps/api/internal/interfaces/websocket/messages.go:27`; `StartRecording` updates DB/Redis/hub at `apps/api/internal/domain/recording/service.go:70`; `StopRecording` does similar at `service.go:116`; no clear broadcast of `recording.started` or `recording.stopped` is visible there.                                                                                                                                                         | SDK managers listen for those events in `packages/sdk-core/src/managers/recording-manager.ts:103`; other participants may not observe recording state changes in real time. |
| Medium   | Whiteboard file upload presign checks room membership but not draw/upload permission.                                                   | `apps/api/internal/interfaces/http/handlers/whiteboard_files.go:34` requires a room-scoped token and room access, but not `can_draw` or a whiteboard upload capability.                                                                                                                                                                                                                                                                                                             | A view-only participant can upload assets into the room's whiteboard storage path.                                                                                          |
| Medium   | SDK permission surfaces are local UI hints, not authoritative decisions.                                                                | `packages/sdk-react/src/hooks/useWhiteboardPermissions.ts:49` gates grant UI on `localParticipant?.role === "host"`; `packages/sdk-core/src/conference-session/whiteboard-actions.ts:12` computes local draw permission; `packages/sdk-react/src/hooks/features/useRecording.ts:77` exposes start/stop without a permission snapshot.                                                                                                                                               | SDK state can be stale or attacker-controlled. It should guide UI, but never be framed as truth.                                                                            |

### Join and Role Escalation Details

The public invite flow is especially sensitive:

- `apps/api/internal/interfaces/http/handlers/internal_links.go:50` creates a
  join token with 24-hour expiry. It is scoped to tenant and room target, but
  has no `jti`, one-time-use tracking, audience, or max-role constraint.
- `apps/api/internal/interfaces/http/handlers/internal_links.go:107` exchanges
  the join token for an access token with subject `"join"`, room ID, role
  `participant`, and participant default permissions.
- `apps/api/internal/interfaces/http/handlers/participants.go:76` then accepts
  a `role` value from the join request body.
- `apps/api/internal/domain/participant/service.go:461` maps `input.Role ==
"host"` directly to the Cloudflare host preset before applying the
  first-participant fallback.

Short-term fix: ignore client-supplied role unless the caller is already
authorized to grant that role. A public join token should produce at most the
role/capabilities encoded in the signed invite, and the default should be
participant/viewer.

### Token Refresh and Session Boundaries

There are two different session models:

- First-party internal auth uses `user_sessions` with hashed tokens and
  revocation checks. `apps/api/internal/interfaces/http/handlers/internal_auth.go:426`
  loads current session by hashed cookie and `apps/api/db/queries/user_sessions.sql:16`
  requires `revoked_at IS NULL` and `expires_at > NOW()`.
- Generic `/auth/refresh` is much looser. `apps/api/internal/interfaces/http/handlers/auth.go:100`
  validates refresh token claims and rebuilds tenant host claims, checking only
  tenant active status.

Participant access should adopt the first-party session discipline: hashed
refresh tokens, rotation, per-participant session rows, explicit revocation, and
an auth epoch or token version that can invalidate all older access tokens after
kick, ban, role downgrade, or room end.

### WebSocket Trust Boundary

`apps/api/internal/interfaces/http/handlers/websocket.go` is currently a major
trust boundary:

- It accepts bearer material from the WebSocket subprotocol or query string at
  `websocket.go:60`. Subprotocol is preferable; query strings are often logged
  by proxies and should be deprecated for production clients.
- It logs token expiry but does not proactively disconnect at `websocket.go:140`.
- It requires `RoomID` and `Subject` claims at `websocket.go:145`.
- If the `room` query mismatches the token room, it logs and continues with the
  token room at `websocket.go:184`.
- It parses participant ID after upgrade at `websocket.go:274`, then registers
  the client even if participant metadata hydration fails later.
- It hydrates metadata and whiteboard policy best-effort at `websocket.go:346`.

WS handshake should reject if the room is not active, the participant does not
belong to the room and tenant, the participant is not active, the participant
session is revoked, or the token was issued before the participant/room auth
epoch.

Established sockets also need a revocation path. Kick, ban, room end, and severe
role downgrade should close local sockets and publish a cross-instance
disconnect command.

### Whiteboard Permission Boundary

Whiteboard enforcement is currently local:

- `apps/api/internal/interfaces/websocket/whiteboard_permissions.go:10`
  defines policy values `all`, `host_only`, and `none`.
- `apps/api/internal/interfaces/websocket/whiteboard_permissions.go:95`
  checks explicit in-memory overrides, then host metadata, then default policy.
- `apps/api/internal/interfaces/websocket/client.go:553` checks draw access
  before update/clear/cursor messages.
- `apps/api/internal/interfaces/websocket/client.go:674` and `client.go:708`
  let hosts grant/revoke in memory and broadcast `permission.changed`.

There are three correctness issues:

1. The existing SQL table is unused for live grant/revoke.
2. Cross-instance enforcement diverges.
3. Cursor updates require draw access, so a view-only user cannot even show a
   pointer. That may be product-correct, but it should be an explicit
   capability decision (`whiteboard.cursor`) instead of an accident of
   `can_draw`.

### Recording Boundary

Recording is route-gated by host checks for room recording endpoints and
`CanRecord` for global recording endpoints:

- `apps/api/internal/interfaces/http/handlers/recordings.go:32` starts room
  recording after verifying claims, room path, room access, and no active
  recording.
- `apps/api/internal/domain/recording/service.go:70` calls Cloudflare, creates a
  DB recording, updates Redis room state, and updates hub state.
- `packages/sdk-core/src/managers/recording-manager.ts:103` listens for
  `recording.started` and `recording.stopped`.

Recording should become capability-based:

- `recording.start` and `recording.stop` are room capabilities.
- `recording.download`, `recording.share`, and `recording.delete` are artifact
  capabilities and may depend on tenant/workspace policy, not just current room
  host role.
- Recording start/stop should append durable control events and fan them out to
  every instance before or with Redis/hub state updates.

## Lessons From Production Systems

### LiveKit

Sources:

- [LiveKit tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [LiveKit participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/)
- [LiveKit Go auth package](https://pkg.go.dev/github.com/livekit/protocol/auth)

LiveKit's token model is close to Chalk's underlying media dependency and is the
most directly applicable model.

Key lessons:

- A token should encode participant identity, room, and explicit grants. LiveKit
  uses signed JWT access tokens with standard fields like `exp`, `iss`, `sub`,
  and `nbf`, plus a `video` grant containing room and capability fields.
- Grants separate service-level permissions from in-room media permissions.
  LiveKit's video grant includes `roomJoin`, `roomAdmin`, `roomRecord`,
  `canPublish`, `canPublishData`, `canPublishSources`, `canSubscribe`, and
  `canUpdateOwnMetadata`.
- Participant management is a backend operation. Updating participant
  permissions, removing participants, and muting tracks require the `roomAdmin`
  grant.
- Permission updates are live events. LiveKit documents that clients are
  notified through `ParticipantPermissionChanged`, and revoking publish
  permissions unpublishes tracks.
- Token refresh and revocation are coupled to permission changes. LiveKit Cloud
  proactively issues refreshed tokens, automatically refreshes tokens when
  name/permission/metadata changes, and revokes existing tokens when a
  participant is removed or permissions change.
- LiveKit Cloud's revocation is `nbf`-based: the server records a timestamp and
  rejects subsequent connections with tokens issued before that time.
- LiveKit self-hosted deployments do not get the same revocation feature by
  default; the docs recommend short TTLs and not issuing a new token after
  removal.
- Remote unmute is intentionally constrained. LiveKit requires a project/server
  setting for admins to remotely unmute tracks because surprising remote unmute
  is a user-safety issue.

What Chalk should copy:

- Keep short-lived access tokens, but add a server-side participant auth epoch
  or `not_before` timestamp per room participant and per room.
- Treat token grants as connection bootstrap and SDK hints, not as the only
  source of authorization for Chalk HTTP/WS mutations.
- On role/permission changes, revoke older tokens, issue a fresh token, and
  send a permissions-changed event with a policy version.
- On kick/ban, revoke tokens before attempting Cloudflare removal, so Chalk
  control-plane access is closed even if the media provider call fails.
- Model "remote unmute" as disabled by default. Prefer `request_unmute` unless
  a tenant explicitly enables remote unmute and the target client confirms it.

### Matrix

Sources:

- [Matrix `m.room.power_levels`](https://spec.matrix.org/latest/client-server-api/index.html#mroompower_levels)
- [Matrix `m.room.member`](https://spec.matrix.org/latest/client-server-api/index.html#mroommember)
- [Matrix kick endpoint](https://spec.matrix.org/latest/client-server-api/index.html#post_matrixclientv3roomsroomidkick)
- [Matrix ban endpoint](https://spec.matrix.org/latest/client-server-api/index.html#post_matrixclientv3roomsroomidban)

Matrix is the strongest model for durable moderation state.

Key lessons:

- Room authority is state, not client memory. `m.room.power_levels` is a state
  event defining user levels, default levels, per-event requirements, and
  membership action thresholds for invite/kick/ban.
- Moderation actions are durable membership state transitions. A kick changes
  the target member state to `leave` with an optional reason. A ban changes it
  to `ban`, prevents rejoin/invite until unbanned, and is represented in the
  same room state system.
- Authorization errors are explicit. Matrix kick/ban endpoints return 403 for
  cases such as actor not in room, target not in room, or insufficient power.
- State is replayable. Clients and servers can reconstruct current room
  authority from event state rather than trusting an ephemeral command.

What Chalk should copy:

- Add append-only room-control events and materialize current policy/grants from
  them.
- Represent kick, ban, role change, whiteboard grant, recording start, and room
  end as durable events with actor, target, reason, sequence, idempotency key,
  and policy version.
- Make ban distinct from kick. Kick removes a participant from the current
  meeting. Ban prevents rejoin for a defined scope until unbanned or expired.
- Return structured authorization errors with `requiredCapability`,
  `policyVersion`, and a stable reason code.

### Discord

Sources:

- [Discord permissions](https://docs.discord.com/developers/topics/permissions)

Discord is the best public model for deterministic permission evaluation across
roles and overrides.

Key lessons:

- Permissions are atomic flags combined into larger role bundles.
- Base permissions are computed from default membership and roles; channel-level
  overwrites then apply in a defined order.
- There are explicit allow and deny layers, and the order is documented:
  everyone base, role base, everyone deny/allow, role deny/allow, member
  deny/allow.
- Some authority is hierarchical. A bot/user can only grant roles below its
  highest role and can only kick/ban/edit users below its highest role.
- `ADMINISTRATOR` bypasses many overwrites, but that makes it a very sharp tool.
- Some permissions imply other denials in practice: if a user cannot view a
  channel, send-message-like permissions are ignored.

What Chalk should copy:

- Use explicit capability names and a deterministic evaluator.
- Make target-sensitive moderation hierarchical. A cohost should not be able to
  demote/kick the room owner or another cohost unless explicitly granted.
- Distinguish permission ceilings from overrides. Tenant policy can cap what a
  room host may grant.
- Avoid an all-powerful "admin" flag for normal room hosts. Keep emergency
  tenant/service-admin paths separate, audited, and unavailable to public
  clients.
- Define implicit prerequisites: `whiteboard.upload_asset` requires
  `whiteboard.view`; `recording.share` requires `recording.view`;
  `media.publish_screen` requires room membership and active session.

### Jitsi

Sources:

- [Jitsi token authentication](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/)
- [Jitsi secure domain setup](https://jitsi.github.io/handbook/docs/devops-guide/secure-domain/)
- [Jitsi Docker authentication](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/#authentication)
- [Jitsi FAQ](https://jitsi.github.io/handbook/docs/faq/)
- [Jitsi iframe commands](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-commands/)

Jitsi shows the operational tradeoff between frictionless joins and controlled
moderation.

Key lessons:

- Secure-domain/JWT setups separate authenticated room creators/moderators from
  guest participants. Jitsi's secure-domain page explicitly says authenticated
  users create rooms and anonymous users can join after creation.
- Jitsi token authentication uses Prosody `authentication = "token"` and the
  `token_verification` module. Docker deployments expose `ENABLE_AUTH`,
  `ENABLE_GUESTS`, `AUTH_TYPE=jwt`, issuer/audience settings, and
  `JWT_ALLOW_EMPTY`.
- `muc_wait_for_host` and persistent lobby patterns prevent guests from
  starting rooms before a trusted host arrives.
- The FAQ warns that room passwords only affect future joiners and can be shared
  onward.
- Moderators can mute everyone or a specific participant; they cannot unmute
  other people's microphones, and participants can unmute themselves.
- Iframe commands mark many actions as moderator-only: end conference, mute
  everyone, mute remote participant, create/remove breakout rooms, send
  participant to a room, and toggle lobby.

What Chalk should copy:

- Replace "first participant becomes host" as a default for public rooms with
  "wait for trusted host" or "host claim required".
- Public invite tokens should never grant host by request body. If a workflow
  needs guest cohosts, encode `max_role` or explicit capabilities in the signed
  invite and require a trusted issuer.
- Treat lobby/admit as durable room-control state, not a local UI feature.
- Keep remote unmute as a request, not a forced action, unless tenant policy and
  client platform explicitly support it.

### BigBlueButton

Sources:

- [BigBlueButton API reference](https://docs.bigbluebutton.org/development/api/)

BigBlueButton is useful because it has a mature classroom/webinar control
surface.

Key lessons:

- BBB API calls are server-to-server and require a checksum computed with a
  shared secret. End users should not be able to forge or alter API calls.
- Meeting creation includes role join credentials historically represented as
  `attendeePW` and `moderatorPW`, with newer role parameters replacing those in
  some flows.
- Recording policy is room policy. `autoStartRecording` and
  `allowStartStopRecording` decide whether moderators can pause/restart or
  whether the whole session is recorded.
- Lock settings are explicit room policy: disable camera, disable mic, disable
  private/public chat, disable notes, hide user list, apply locks on join, and
  decide whether locks are configurable.
- `allowModsToUnmuteUsers` defaults false, matching the user-safety stance from
  Jitsi and LiveKit.
- `multiUserWhiteboardEnabled` is a room-level default that grants drawing
  access to all users when they join.

What Chalk should copy:

- Put locks in `room_policy`: audio lock, video lock, chat lock, screen-share
  lock, whiteboard default access, recording start/stop policy, and whether
  locks apply to late joiners.
- Make late join behavior explicit. If a host locks microphones, every new
  participant should join under that lock until it is changed.
- Keep server-to-server admin APIs separate from participant-issued room
  operations.
- Make recording policy a tenant/room decision, not just a button controlled by
  whoever currently has host role.

### Google Meet

Sources:

- [Google Meet host controls](https://support.google.com/meet/answer/16229038)
- [Google Meet co-hosts](https://support.google.com/meet/answer/10885841)
- [Google Meet audio/video lock](https://support.google.com/meet/answer/11274707)
- [Google Meet add/remove people](https://support.google.com/meet/answer/9303164)
- [Google Meet view-only roles](https://support.google.com/meet/answer/13658394)

Google Meet is useful because its public safety docs show product semantics
normal users expect.

Key lessons:

- Host Management is a room policy switch. When on, only hosts can access
  controls such as add/remove people, chat moderation, audio/video locks,
  view-only roles, and cohost assignment.
- Cohosts are bounded. Some editions support up to 25 cohosts, and artifact
  sharing has separate setup-time rules.
- Host Management has persistence nuance. Some settings are saved for recurring
  meetings or reused meeting codes; ad-hoc in-meeting cohost changes do not
  necessarily grant future artifact access.
- Audio/video locks apply to all participants except hosts/cohosts and affect
  all device types.
- Remove and block are different. Remove ejects now; block prevents rejoin to
  the current meeting or concurrent meetings using the same code until manually
  invited back.
- View-only roles explicitly remove audio/video, screen share, and chat while
  still allowing low-risk participation such as hand raise, Q&A/polls, and
  reactions.

What Chalk should copy:

- Treat host controls as a policy layer, not just role strings.
- Model cohost as a capability grant that can be temporary, scoped, and audited.
- Separate `participant.kick` from `participant.block_current_room` and
  `participant.ban`.
- Add a first-class viewer role for webinar/classroom scenarios.
- Keep meeting artifacts such as recordings and attendance/reporting under
  artifact permissions, not only live room host permissions.

## Proposed Chalk Permissions Model

### Design Principles

1. JWTs identify a principal and bootstrap a session; they do not decide
   sensitive authorization alone.
2. Roles are named bundles for humans. Capabilities are the enforcement units.
3. Permission decisions are server-side, resource-aware, target-aware, and
   versioned.
4. Every moderation action becomes a durable room-control event.
5. Revocation should be immediate for Chalk control-plane access, even if the
   media provider call is delayed or fails.
6. Cross-instance enforcement must converge before, or at the same time as,
   clients are told a permission changed.
7. SDK permission state is a UI hint with freshness metadata.

### Principals and Scopes

Principals:

- `tenant_service_account`: API key or trusted backend integration.
- `workspace_user`: first-party authenticated user/session.
- `room_participant`: a joined participant tied to a `room_participants` row.
- `join_invite`: a pre-participant invite token with constrained join rights.
- `system_agent`: recorder, transcription, bot, diagnostics, or migration actor.

Scopes:

- `tenant`: across all rooms and artifacts in a tenant.
- `workspace`: across a workspace/project.
- `room`: a live or scheduled room.
- `participant`: a target participant within a room.
- `artifact`: recording, transcript, whiteboard file, export, or report.
- `feature`: whiteboard, chat, media, recording, transcript, controls.

### Capability Catalog

The exact names can change, but the model should be explicit and searchable:

| Area                   | Capabilities                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room lifecycle         | `room.create`, `room.read`, `room.update`, `room.end`, `room.update_policy`, `room.manage_hosts`                                                                                                                            |
| Join/admit             | `room.join`, `participant.invite`, `participant.admit`, `participant.deny_entry`, `participant.block_entry`                                                                                                                 |
| Participant moderation | `participant.update_self`, `participant.update_role`, `participant.kick`, `participant.ban`, `participant.unban`, `participant.mute_audio`, `participant.mute_video`, `participant.request_unmute`, `participant.move_room` |
| Media                  | `media.publish_audio`, `media.publish_video`, `media.publish_screen`, `media.publish_data`, `media.subscribe`                                                                                                               |
| Recording              | `recording.start`, `recording.stop`, `recording.view`, `recording.download`, `recording.share`, `recording.delete`                                                                                                          |
| Whiteboard             | `whiteboard.view`, `whiteboard.draw`, `whiteboard.cursor`, `whiteboard.manage_permissions`, `whiteboard.upload_asset`, `whiteboard.clear`                                                                                   |
| Chat/reactions         | `chat.send`, `chat.moderate`, `reaction.send`, `hand.raise`                                                                                                                                                                 |
| Artifacts              | `transcript.view`, `transcript.manage`, `attendance.view`, `artifact.share`                                                                                                                                                 |

Capabilities should include prerequisites in code, not just documentation. For
example, `whiteboard.upload_asset` should require `whiteboard.view` and usually
`whiteboard.draw`; `recording.share` should require artifact access and tenant
policy allowing shares.

### Role Presets

Suggested room roles:

- `owner`: creator/scheduler or tenant-assigned room owner. Can manage hosts,
  policy, artifacts, and room lifecycle. Not granted by public join.
- `host`: can manage live meeting controls, admit/remove participants, manage
  whiteboard permissions, and start/stop recording if room policy allows.
- `cohost`: a narrower host grant. Can moderate live participants and locks, but
  cannot remove owner, change durable artifact ownership, or grant owner/host
  unless explicitly allowed.
- `presenter`: can publish audio/video/screen and draw/present, but cannot kick,
  record, or grant permissions.
- `participant`: can publish default media, chat, and use whiteboard according
  to room policy.
- `viewer`: can subscribe/watch, raise hand, react, maybe Q&A, but cannot
  publish audio/video/screen/chat unless promoted.
- `recorder` / `bot`: system roles with narrow service capabilities.

Roles are defaults. Actual decisions are computed capabilities after policy,
locks, target hierarchy, and explicit grants.

### Policy Precedence

Use a deterministic evaluator with a small number of layers:

1. Tenant policy and entitlements. This is the ceiling. A room host cannot grant
   recording if the tenant disables recording.
2. Workspace/project policy. Optional middle layer for enterprise org structure.
3. Room policy. Includes defaults, locks, lobby, recording mode, whiteboard
   default access, max role from public invites, and whether hosts can override.
4. Participant role preset. Grants the default capability bundle.
5. Explicit participant grants/denies. These are durable, target one participant
   or class, and can expire.
6. Temporary session constraints. Active participant, not kicked/banned, session
   not revoked, room active, token issued after relevant auth epoch.
7. Target hierarchy. Actor must be allowed to act on that target. Cohost cannot
   kick owner; host cannot grant capabilities above its own grant or above room
   policy.

Recommended conflict rule: tenant/workspace/room ceilings and explicit denies
win over allows. Temporary allows can add capability only within ceilings.

This is slightly more deny-biased than Discord channel overwrites, but safer for
enterprise video rooms where tenant policy must be enforceable.

### Decision Object

Every server-side authorization check should return a structured decision:

```go
type Decision struct {
    Allowed       bool
    Capability    Capability
    Resource      ResourceRef
    Actor         PrincipalRef
    Target        *PrincipalRef
    ReasonCode    string
    Reason        string
    Source        string
    PolicyVersion int64
    CheckedAt     time.Time
    ExpiresAt     *time.Time
}
```

HTTP 403 responses should expose safe fields:

```json
{
  "error": {
    "code": "permission_denied",
    "message": "Host controls are required for this action.",
    "requiredCapability": "participant.kick",
    "reasonCode": "target_role_not_below_actor",
    "policyVersion": 42
  }
}
```

The SDK can use this to refresh local permission hints and show accurate UI
state without guessing.

## Durable Room-Control Events

Moderation and room policy should be command-driven and event-recorded.

### Event Types

Start with these:

- `room.policy.updated`
- `room.host_management.enabled`
- `room.host_management.disabled`
- `room.ended`
- `participant.joined`
- `participant.admitted`
- `participant.entry_denied`
- `participant.kicked`
- `participant.banned`
- `participant.unbanned`
- `participant.role.changed`
- `participant.grant.created`
- `participant.grant.revoked`
- `participant.audio.locked`
- `participant.audio.unlocked`
- `participant.video.locked`
- `participant.video.unlocked`
- `participant.audio.muted_by_moderator`
- `participant.video.muted_by_moderator`
- `participant.unmute_requested`
- `whiteboard.permission.granted`
- `whiteboard.permission.revoked`
- `whiteboard.cleared`
- `recording.started`
- `recording.stopped`
- `recording.share.created`
- `recording.share.revoked`

### Event Record

Suggested table:

```sql
CREATE TABLE room_control_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID,
  room_id UUID NOT NULL,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_participant_id UUID,
  target_participant_id UUID,
  target_user_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  reason TEXT,
  idempotency_key TEXT,
  policy_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, seq),
  UNIQUE (room_id, idempotency_key)
);
```

Use an outbox pattern or transactionally publish after commit:

1. Validate command with current authorizer.
2. Insert event with next room sequence.
3. Update materialized policy/participant state in the same transaction.
4. Revoke sessions/auth epochs if needed.
5. Publish event to Redis/stream for all API instances.
6. Perform external side effects, such as Cloudflare remove/mute/recording.
7. Retry external side effects idempotently if they fail.

Security-sensitive effects should happen before best-effort provider calls. For
example, kick should revoke Chalk sessions before calling Cloudflare.

### Materialized State

Suggested tables:

```sql
CREATE TABLE room_policy_state (
  room_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  version BIGINT NOT NULL,
  default_role TEXT NOT NULL,
  host_management_enabled BOOLEAN NOT NULL,
  lobby_enabled BOOLEAN NOT NULL,
  recording_policy JSONB NOT NULL,
  media_locks JSONB NOT NULL,
  whiteboard_policy JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE room_participant_grants (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  room_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  expires_at TIMESTAMPTZ,
  granted_by_participant_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (room_id, participant_id, capability, effect)
);

CREATE TABLE room_bans (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  room_id UUID NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  banned_by_participant_id UUID,
  reason TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
```

`whiteboard_permissions` can either be migrated into
`room_participant_grants` or become a feature-specific projection maintained
from the same events. Avoid two independent sources of truth.

## Session and Token Architecture

### Access Token Contents

Access token should carry:

- `tenant_id`
- `workspace_id`, if scoped
- `room_id`, if scoped
- `participant_id`, if joined
- `session_id`
- `subject`
- `aud`
- `iat`
- `nbf`
- `exp`
- `policy_version` as a hint
- `auth_epoch` or `participant_not_before`
- optional `role_hint` for display only

Avoid making JWT `permissions` the authoritative surface. If retained for
backward compatibility, mark it as `permissions_hint` and version it.

### Participant Sessions

Add a participant session table:

```sql
CREATE TABLE participant_sessions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  room_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  refresh_token_hash TEXT,
  access_token_jti TEXT,
  auth_epoch BIGINT NOT NULL DEFAULT 0,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  last_seen_at TIMESTAMPTZ
);
```

Refresh flow:

1. Validate refresh token signature and token type.
2. Hash token and find active `participant_sessions` row.
3. Load tenant, room, participant.
4. Reject if tenant inactive, room ended, participant not active, participant
   kicked/banned, session revoked, or token issued before participant/room auth
   epoch.
5. Rotate refresh token.
6. Issue short-lived access token with current `policy_version`.

Revocation triggers:

- participant kicked
- participant banned
- participant role downgraded below required current session grants
- participant removed from room
- room ended
- tenant/workspace security reset
- public join token revoked or consumed if one-time

### Public Join Tokens

Current public join tokens should become signed invites with explicit
constraints:

- `tenant_id`
- `room_id`
- `aud: "chalk.join"`
- `jti`
- `max_role`
- optional allowed capability list
- `expires_at`
- optional `single_use`
- optional `allowed_email_domain` or `external_user_id`
- optional `lobby_bypass`
- issuer actor and room policy version at issue time

Exchange should create a constrained pre-join principal. The subsequent join
should ignore any requested role above `max_role`. For public links, default
`max_role` should be `participant` or `viewer`.

## Server Authorizer

Add a central authorizer package, likely in `apps/api/internal/domain/authz` or
`apps/api/internal/application/authz`, used by both HTTP and WebSocket layers.

Sketch:

```go
type Capability string

type Principal struct {
    TenantID      uuid.UUID
    WorkspaceID   *uuid.UUID
    RoomID        *uuid.UUID
    ParticipantID *uuid.UUID
    SessionID     *uuid.UUID
    Subject       string
    Kind          PrincipalKind
}

type Resource struct {
    TenantID      uuid.UUID
    WorkspaceID   *uuid.UUID
    RoomID        *uuid.UUID
    ParticipantID *uuid.UUID
    ArtifactID    *uuid.UUID
    Kind          ResourceKind
}

type Authorizer interface {
    Can(ctx context.Context, principal Principal, capability Capability, resource Resource) (Decision, error)
}
```

HTTP middleware should authenticate only. Authorization should happen after the
handler loads the target resource, because the authorizer needs tenant, room,
participant, artifact, target role, current policy version, and session state.

Replace checks like `RequireHost` and `RequirePermission` gradually with:

- `AuthorizeRoom(ctx, claims, roomID, "recording.start")`
- `AuthorizeParticipantTarget(ctx, claims, roomID, targetParticipantID,
"participant.kick")`
- `AuthorizeArtifact(ctx, claims, recordingID, "recording.download")`

Every participant-targeting handler should prove:

1. Path room exists and belongs to caller tenant/workspace scope.
2. Target participant exists.
3. Target participant belongs to the same path room and tenant.
4. Actor is active in that room unless actor is a tenant service account.
5. Actor capability and target hierarchy allow the action.

## Cross-Instance Enforcement

Use the database as source of truth and Redis/stream as the low-latency
distribution layer.

Requirements:

- Every room-control event has a monotonically increasing `seq`.
- Every API instance keeps a room policy cache keyed by room ID and version.
- Event consumers update local materialized/cached state before broadcasting to
  local clients.
- If an instance receives event `seq=N+2` while it has `N`, it must pause
  sensitive enforcement for that room, reload from DB, then resume.
- If Redis/pubsub is unavailable, privileged mutations can still commit to DB,
  but WS feature mutations should fail closed when local policy is stale beyond
  a short TTL.
- Kick/ban/room-end events publish explicit disconnect commands:
  `disconnect participant_id where room_id and session_id`.

This fixes the current whiteboard divergence shape and gives the same mechanism
to recording, chat, lobby, and media locks.

## SDK Contract

SDK should expose permissions as a versioned snapshot:

```ts
type PermissionSnapshot = {
  status: "authoritative" | "stale" | "unknown";
  policyVersion: number;
  checkedAt: string;
  expiresAt?: string;
  roleHint?: "owner" | "host" | "cohost" | "presenter" | "participant" | "viewer";
  capabilities: Record<string, boolean>;
  reasons?: Record<string, string>;
};
```

APIs:

- `session.permissions.getSnapshot()`
- `session.permissions.refresh()`
- `session.permissions.subscribe(listener)`
- `session.permissions.can(capability, resource?)`
- React: `usePermissions()`, `useCan(capability, resource?)`

Important semantics:

- `can(...)` is a UI hint. Documentation should state that server authorization
  is final.
- Mutating SDK methods should not silently rely on local role. They should call
  the server and handle 403 by updating the permission snapshot from the error
  response.
- On `permissions.changed` or any room-control event with a newer
  `policyVersion`, the SDK should mark the snapshot stale and either fetch or
  accept an included snapshot delta.
- Join options should not expose a privileged `role` for public clients. If the
  SDK keeps `role` for trusted server/API-key flows, type it so browser public
  join paths cannot request `host` without a signed grant.
- Recording and whiteboard hooks should expose `canStart`, `canStop`,
  `canDraw`, `canGrant`, and `reasonCode` from the permission snapshot, while
  still handling server rejection.

## API Additions and Changes

Keep existing endpoints during migration, but internally route them through
command handlers that append room-control events.

Suggested public/SDK endpoints:

- `GET /api/v1/rooms/:roomId/permissions`
- `GET /api/v1/rooms/:roomId/participants/:participantId/permissions`
- `PATCH /api/v1/rooms/:roomId/policy`
- `POST /api/v1/rooms/:roomId/participants/:participantId/role`
- `POST /api/v1/rooms/:roomId/participants/:participantId/grants`
- `DELETE /api/v1/rooms/:roomId/participants/:participantId/grants/:capability`
- `POST /api/v1/rooms/:roomId/participants/:participantId/kick`
- `POST /api/v1/rooms/:roomId/participants/:participantId/ban`
- `POST /api/v1/rooms/:roomId/participants/:participantId/unban`
- `POST /api/v1/rooms/:roomId/participants/:participantId/mute`
- `POST /api/v1/rooms/:roomId/locks/audio`
- `DELETE /api/v1/rooms/:roomId/locks/audio`
- `POST /api/v1/rooms/:roomId/recordings/start`
- `POST /api/v1/rooms/:roomId/recordings/:recordingId/stop`

Suggested internal command names:

- `JoinRoom`
- `AdmitParticipant`
- `ChangeParticipantRole`
- `GrantParticipantCapability`
- `RevokeParticipantCapability`
- `KickParticipant`
- `BanParticipant`
- `UpdateRoomPolicy`
- `StartRecording`
- `StopRecording`
- `GrantWhiteboardDraw`
- `RevokeWhiteboardDraw`

Command handlers should be idempotent where possible and accept an
`Idempotency-Key`.

## Migration Plan

### Phase 0: Immediate Risk Fixes

1. Prevent role escalation on join.
   - Ignore `role` from public join-token and room-scoped participant callers.
   - Only tenant service account, workspace owner, or existing authorized host
     can create another host/cohost.
   - Public join token can include `max_role`, default `participant`.
2. Populate permissions consistently in participant tokens or stop checking JWT
   permissions for participant room flows.
3. Reject WS handshakes for inactive/left/kicked participants and ended rooms.
4. Add room/tenant match checks for update/kick/refresh participant handlers.
5. Persist whiteboard grants or route them through a generic grants table; do
   not rely only on hub memory.
6. Require `whiteboard.draw` or `whiteboard.upload_asset` for presign upload.
7. Broadcast recording started/stopped events when recording state changes.

### Phase 1: Central Authorizer

1. Add capability constants and `Authorizer.Can`.
2. Replace `RequireHost`/`RequirePermission` on high-risk handlers first:
   participant update/kick/refresh, recording start/stop/share, join-token
   creation, room end, whiteboard file upload.
3. Add structured 403 error responses.
4. Add focused regression tests around join, kick, and room mismatch.

### Phase 2: Room-Control Events

1. Add `room_control_events` and `room_policy_state`.
2. Dual-write current actions to events while keeping existing state writes.
3. Materialize whiteboard grants and recording state from events.
4. Add room sequence/version to WebSocket events.
5. Build replay tests that reconstruct room state from events.

### Phase 3: Session Revocation

1. Add participant sessions with hashed rotating refresh tokens.
2. Add participant/room auth epoch.
3. Check active session on refresh and WS handshake.
4. Publish cross-instance disconnect on kick/ban/room end.
5. Add race tests for kick versus reconnect and role downgrade versus action.

### Phase 4: SDK Permission Snapshot

1. Add permission snapshot endpoint and WS `permissions.changed` payload.
2. Add `session.permissions` in SDK core.
3. Update React hooks to use capability hints instead of local role checks.
4. Mark snapshots stale on newer room policy version.
5. Document that SDK permission state is UI guidance, not enforcement.

### Phase 5: Product Policy Surface

1. Add tenant/workspace policy migration and admin API.
2. Add room policy controls for lobby, host management, locks, recording, and
   whiteboard default access.
3. Add viewer/cohost roles.
4. Add artifact permission model for recordings/transcripts/reports.

## Tests and Abuse Plan

### API Regression Tests

- Public join token exchange followed by `POST /participants` with
  `role:"host"` returns participant/viewer, not host.
- Participant token cannot self-promote through participant update.
- Room-scoped host for room A cannot update, kick, or refresh a participant from
  room B, even if it knows the UUID.
- Kicked participant cannot refresh token.
- Kicked participant cannot open a new WebSocket.
- Existing WebSocket for kicked participant is closed locally and remotely.
- Host cannot kick owner or equal/higher role unless explicit policy allows.
- Tenant policy disabling recording blocks room host recording start.
- `whiteboard.host_only` blocks participant updates and file uploads.
- Whiteboard grant persists across API instance restart.
- Whiteboard revoke immediately blocks subsequent update and upload.

### WebSocket and Multi-Instance Tests

- Instance A grants whiteboard draw; participant connected to instance B can draw
  only after B applies the event.
- Instance A revokes whiteboard draw; participant connected to B is rejected
  before or with the `permission.changed` event.
- Instance A kicks participant; B disconnects participant and rejects reconnect.
- Redis event gap triggers room policy resync before sensitive enforcement.
- Expired token on existing WS triggers refresh or disconnect according to the
  chosen policy.

### Race Tests

- Kick versus reconnect.
- Role downgrade versus recording start.
- Whiteboard revoke versus in-flight draw update.
- Room end versus join.
- Recording start versus room end.
- Join token revoke/consume versus exchange retry.

### Property Tests for Authorizer

- Tenant deny always wins.
- Room policy lock applies to late joiners.
- Actor cannot grant a capability it does not have.
- Actor cannot act on target outside actor's room scope.
- Explicit participant deny beats role allow.
- Temporary grant expires at `expires_at`.
- Viewer cannot publish media even if SDK sends media publish command.
- Service account can act only within tenant/workspace scope.

### Abuse Cases

- Stolen participant access token after kick.
- Replayed public join token.
- Public invite link shared outside intended audience.
- Role supplied by malicious browser client.
- Modified SDK that sends forbidden WS messages.
- Query-string token captured from logs.
- Guessed participant UUID in route path.
- Cross-tenant room ID/path mismatch.
- Cross-instance stale whiteboard permission cache.
- Redis outage during kick/ban.
- Cloudflare remove participant fails after Chalk revocation.
- Participant opens multiple sessions before being kicked.
- Host demotes another host while they are performing moderation.
- View-only participant attempts upload, chat, screen share, and data publish.

## Open Decisions

- Should Chalk keep "first participant is host"? Recommendation: only for
  trusted tenant/API-key room creation or explicit local demo mode, never for
  public join links.
- What is the canonical role vocabulary: `owner/host/cohost/presenter/participant/viewer`
  or a smaller set?
- Is remote unmute ever allowed? Recommendation: default no; support only
  tenant opt-in plus target-client confirmation.
- Are public join tokens reusable invite links or one-time admission tickets?
  Chalk likely needs both, with different names and audit behavior.
- What is the revocation SLA? Recommendation: immediate for refresh/WS
  reconnect, best-effort under 5 seconds for existing sockets across instances.
- Should bans be keyed by participant ID, external user ID, email, anonymous
  fingerprint, IP, or tenant identity? Recommendation: support scoped ban
  subjects, but avoid IP-only as the primary model.
- Should recording artifact access belong to room hosts, room owners, workspace
  admins, or tenant policy? Recommendation: artifact access should survive the
  live room and be governed by room owner/workspace/tenant policy.
- How much capability state should be embedded in JWTs? Recommendation: only
  hints and version, never the final source for privileged operations.
- Should whiteboard cursor visibility be separate from draw access?
- Should chat moderation and Q&A use the same room-control event system from
  day one? Recommendation: yes for event schema, even if product UI comes later.

## Source Index

### External Primary Sources

- LiveKit: [tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- LiveKit: [participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/)
- LiveKit source/API: [Go auth package](https://pkg.go.dev/github.com/livekit/protocol/auth)
- Matrix: [`m.room.power_levels`](https://spec.matrix.org/latest/client-server-api/index.html#mroompower_levels)
- Matrix: [`m.room.member`](https://spec.matrix.org/latest/client-server-api/index.html#mroommember)
- Matrix: [kick endpoint](https://spec.matrix.org/latest/client-server-api/index.html#post_matrixclientv3roomsroomidkick)
- Matrix: [ban endpoint](https://spec.matrix.org/latest/client-server-api/index.html#post_matrixclientv3roomsroomidban)
- Discord: [permissions](https://docs.discord.com/developers/topics/permissions)
- Jitsi: [token authentication](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/)
- Jitsi: [secure domain setup](https://jitsi.github.io/handbook/docs/devops-guide/secure-domain/)
- Jitsi: [Docker authentication settings](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/#authentication)
- Jitsi: [FAQ](https://jitsi.github.io/handbook/docs/faq/)
- Jitsi: [iframe commands](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-commands/)
- BigBlueButton: [API reference](https://docs.bigbluebutton.org/development/api/)
- Google Meet: [host controls](https://support.google.com/meet/answer/16229038)
- Google Meet: [co-hosts](https://support.google.com/meet/answer/10885841)
- Google Meet: [audio/video lock](https://support.google.com/meet/answer/11274707)
- Google Meet: [add/remove people](https://support.google.com/meet/answer/9303164)
- Google Meet: [view-only roles](https://support.google.com/meet/answer/13658394)

### Local Chalk References

- `apps/api/internal/domain/auth/types.go`
- `apps/api/internal/infrastructure/auth/jwt.go`
- `apps/api/internal/interfaces/http/middleware/auth.go`
- `apps/api/internal/interfaces/http/router.go`
- `apps/api/internal/interfaces/http/handlers/auth.go`
- `apps/api/internal/interfaces/http/handlers/internal_auth.go`
- `apps/api/internal/interfaces/http/handlers/internal_links.go`
- `apps/api/internal/interfaces/http/handlers/participants.go`
- `apps/api/internal/interfaces/http/handlers/websocket.go`
- `apps/api/internal/interfaces/http/handlers/whiteboard_files.go`
- `apps/api/internal/interfaces/http/handlers/recordings.go`
- `apps/api/internal/domain/participant/service.go`
- `apps/api/internal/domain/recording/service.go`
- `apps/api/internal/domain/room/service.go`
- `apps/api/internal/infrastructure/postgres/postgres.go`
- `apps/api/internal/infrastructure/redis/room_state.go`
- `apps/api/internal/interfaces/websocket/client.go`
- `apps/api/internal/interfaces/websocket/hub.go`
- `apps/api/internal/interfaces/websocket/messages.go`
- `apps/api/internal/interfaces/websocket/whiteboard_permissions.go`
- `apps/api/internal/interfaces/websocket/whiteboard_state.go`
- `apps/api/internal/interfaces/websocket/whiteboard_state_persist.go`
- `apps/api/db/queries/recordings.sql`
- `apps/api/db/queries/user_sessions.sql`
- `packages/sdk-core/src/api-client.ts`
- `packages/sdk-core/src/conference-client/join-session.ts`
- `packages/sdk-core/src/conference-client/client-room-ops.ts`
- `packages/sdk-core/src/conference-session/whiteboard-actions.ts`
- `packages/sdk-core/src/conference-session/ws-signaling.ts`
- `packages/sdk-core/src/managers/recording-manager.ts`
- `packages/sdk-core/src/session/chalk-session.ts`
- `packages/sdk-react/src/hooks/useWhiteboardPermissions.ts`
- `packages/sdk-react/src/hooks/features/useRecording.ts`
