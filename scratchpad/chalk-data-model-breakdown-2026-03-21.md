# Chalk Data Model Breakdown

Date: 2026-03-21

## Goal

1. Capture the current database model as it exists today.
2. Show the important relationships.
3. Propose a cleaner first-party model for Chalk web + mobile with accounts/workspaces.

## Current Schema

Primary sources used:

- `apps/api/db/migrations/*.sql`
- `apps/api/internal/infrastructure/postgres/db/models.go`

### `tenants`

Purpose:

- Root app/customer boundary.
- Originally meant for consuming apps/customers/integrations.
- Later overloaded for first-party Chalk internal workspaces.

Fields:

| Field                            | Type                   | Notes                                                            |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `id`                             | `uuid`                 | PK                                                               |
| `name`                           | `varchar(255)`         | Tenant name                                                      |
| `api_key_hash`                   | `varchar(255)`         | Unique hashed API key                                            |
| `config`                         | `jsonb`                | General config                                                   |
| `max_concurrent_rooms`           | `int`                  | Limit                                                            |
| `max_participants_per_room`      | `int`                  | Limit                                                            |
| `max_recording_duration_minutes` | `int`                  | Limit                                                            |
| `max_total_minutes_of_meetings`  | `int`                  | Limit                                                            |
| `is_active`                      | `bool`                 | Active/inactive                                                  |
| `created_at`                     | `timestamptz`          | Timestamp                                                        |
| `updated_at`                     | `timestamptz`          | Timestamp                                                        |
| `whiteboard_config`              | `jsonb`                | Whiteboard defaults/permissions                                  |
| `tenant_config`                  | `jsonb`                | Feature flags/config: recording, transcription, early join, etc. |
| `tenant_kind`                    | `text`                 | `external` or `internal`                                         |
| `owner_user_id`                  | `uuid` nullable        | First-party internal tenant owner                                |
| `claimed_at`                     | `timestamptz` nullable | When internal tenant got claimed                                 |

Important notes:

- `rooms.tenant_id -> tenants.id`
- For internal tenants, there is a hard 1:1 unique index: one user -> one internal tenant.
- This is the core modeling flaw for first-party Chalk.

### `rooms`

Purpose:

- Canonical meeting/session record.
- Maps Chalk room to Cloudflare meeting.

Fields:

| Field                      | Type                    | Notes                             |
| -------------------------- | ----------------------- | --------------------------------- |
| `id`                       | `uuid`                  | PK                                |
| `tenant_id`                | `uuid`                  | FK to `tenants.id`                |
| `cloudflare_meeting_id`    | `varchar(255)`          | Actual Cloudflare room/meeting ID |
| `name`                     | `varchar(255)` nullable | Human title/code/name             |
| `config`                   | `jsonb`                 | Room config                       |
| `status`                   | `varchar(50)`           | `scheduled`, `active`, `ended`    |
| `started_at`               | `timestamptz` nullable  | Actual start                      |
| `ended_at`                 | `timestamptz` nullable  | Actual end                        |
| `created_at`               | `timestamptz`           | Timestamp                         |
| `updated_at`               | `timestamptz`           | Timestamp                         |
| `whiteboard_state`         | `jsonb` nullable        | Excalidraw state                  |
| `metadata`                 | `jsonb`                 | Arbitrary integration metadata    |
| `scheduled_start_at`       | `timestamptz` nullable  | Scheduled start                   |
| `scheduled_end_at`         | `timestamptz` nullable  | Scheduled end                     |
| `allow_early_join_minutes` | `int`                   | Early join window                 |
| `screen_annotation_state`  | `jsonb` nullable        | Screen annotation state           |

Important notes:

- This is the parent for most meeting-related data.
- Today ownership is only expressed indirectly through `tenant_id`.
- There is no `created_by_user_id`, `workspace_id`, or `account_id`.

### `participants`

Purpose:

- One row per room participation.

Fields:

| Field                       | Type                    | Notes                           |
| --------------------------- | ----------------------- | ------------------------------- |
| `id`                        | `uuid`                  | PK                              |
| `room_id`                   | `uuid`                  | FK to `rooms.id`                |
| `cloudflare_participant_id` | `varchar(255)`          | Cloudflare participant ID       |
| `external_user_id`          | `varchar(255)` nullable | External/customer-side identity |
| `display_name`              | `varchar(255)` nullable | User-facing name                |
| `role`                      | `varchar(50)`           | `host` or `participant`         |
| `joined_at`                 | `timestamptz` nullable  | Join time                       |
| `left_at`                   | `timestamptz` nullable  | Leave time                      |
| `created_at`                | `timestamptz`           | Timestamp                       |
| `metadata`                  | `jsonb`                 | Arbitrary metadata              |

Important notes:

- `participants.room_id -> rooms.id`
- No direct FK to first-party `users`
- For authenticated Chalk first-party users, the user identity is not structurally modeled here

### `recordings`

Purpose:

- Recording lifecycle + storage reference.

Fields:

| Field                     | Type                    | Notes                                                               |
| ------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `id`                      | `uuid`                  | PK                                                                  |
| `room_id`                 | `uuid`                  | FK to `rooms.id`                                                    |
| `cloudflare_recording_id` | `varchar(255)` nullable | Cloudflare recording ID                                             |
| `storage_provider`        | `varchar(50)` nullable  | `r2`, etc.                                                          |
| `storage_path`            | `varchar(500)` nullable | Storage path                                                        |
| `size_bytes`              | `bigint` nullable       | Size                                                                |
| `duration_seconds`        | `int` nullable          | Duration                                                            |
| `status`                  | `varchar(50)`           | `recording`, `processing`, `ready`, `archived`, `deleted`, `failed` |
| `started_at`              | `timestamptz` nullable  | Start                                                               |
| `ended_at`                | `timestamptz` nullable  | End                                                                 |
| `archived_at`             | `timestamptz` nullable  | Archive                                                             |
| `created_at`              | `timestamptz`           | Timestamp                                                           |
| `metadata`                | `jsonb`                 | Metadata                                                            |
| `deleted_at`              | `timestamptz` nullable  | Tombstone time                                                      |

### `audit_logs`

Purpose:

- Compliance/debug trail.

Fields:

| Field           | Type                    | Notes              |
| --------------- | ----------------------- | ------------------ |
| `id`            | `uuid`                  | PK                 |
| `tenant_id`     | `uuid` nullable         | FK to `tenants.id` |
| `room_id`       | `uuid` nullable         | FK to `rooms.id`   |
| `actor_id`      | `varchar(255)` nullable | Loose actor string |
| `action`        | `varchar(100)`          | Action             |
| `resource_type` | `varchar(100)` nullable | Type               |
| `resource_id`   | `uuid` nullable         | Resource ID        |
| `metadata`      | `jsonb`                 | Metadata           |
| `ip_address`    | `inet` nullable         | IP                 |
| `created_at`    | `timestamptz`           | Timestamp          |

### `whiteboard_permissions`

Purpose:

- Persistent whiteboard draw permissions.

Fields:

| Field            | Type            | Notes                   |
| ---------------- | --------------- | ----------------------- |
| `id`             | `uuid`          | PK                      |
| `room_id`        | `uuid`          | FK to `rooms.id`        |
| `participant_id` | `uuid`          | FK to `participants.id` |
| `can_draw`       | `bool`          | Permission              |
| `granted_by`     | `uuid` nullable | FK to `participants.id` |
| `created_at`     | `timestamptz`   | Timestamp               |
| `updated_at`     | `timestamptz`   | Timestamp               |

Constraint:

- Unique on `(room_id, participant_id)`

### `transcripts`

Purpose:

- Realtime transcript segments.

Fields:

| Field                       | Type                    | Notes                   |
| --------------------------- | ----------------------- | ----------------------- |
| `id`                        | `uuid`                  | PK                      |
| `room_id`                   | `uuid`                  | FK to `rooms.id`        |
| `participant_id`            | `uuid` nullable         | FK to `participants.id` |
| `cloudflare_participant_id` | `varchar(255)` nullable | Cloudflare participant  |
| `speaker_name`              | `varchar(255)`          | Speaker display         |
| `text`                      | `text`                  | Transcript text         |
| `confidence`                | `real` nullable         | Confidence              |
| `language`                  | `varchar(10)` nullable  | Language                |
| `external_id`               | `varchar(255)` nullable | Upstream event ID       |
| `timestamp`                 | `timestamptz`           | Segment time            |
| `created_at`                | `timestamptz`           | Timestamp               |

### `post_meeting_transcripts`

Purpose:

- Full post-meeting transcription output.

Fields:

| Field              | Type                   | Notes                                          |
| ------------------ | ---------------------- | ---------------------------------------------- |
| `id`               | `uuid`                 | PK                                             |
| `recording_id`     | `uuid`                 | FK to `recordings.id`                          |
| `room_id`          | `uuid`                 | FK to `rooms.id`                               |
| `transcript_text`  | `text` nullable        | Full text                                      |
| `transcript_json`  | `jsonb`                | Segments/speakers/timestamps                   |
| `language`         | `varchar(10)` nullable | Language                                       |
| `duration_seconds` | `int` nullable         | Duration                                       |
| `word_count`       | `int` nullable         | Word count                                     |
| `provider`         | `varchar(50)` nullable | `groq`, `whisper`, etc.                        |
| `summary`          | `text` nullable        | Summary                                        |
| `action_items`     | `text[]`               | Action items                                   |
| `status`           | `varchar(50)`          | `pending`, `processing`, `completed`, `failed` |
| `error_message`    | `text` nullable        | Failure message                                |
| `created_at`       | `timestamptz`          | Timestamp                                      |
| `completed_at`     | `timestamptz` nullable | Completion                                     |

### `webhook_deliveries`

Purpose:

- Retryable webhook delivery history.

Fields:

| Field           | Type                   | Notes                                       |
| --------------- | ---------------------- | ------------------------------------------- |
| `id`            | `uuid`                 | PK                                          |
| `tenant_id`     | `uuid`                 | FK to `tenants.id`                          |
| `room_id`       | `uuid`                 | FK to `rooms.id`                            |
| `recording_id`  | `uuid` nullable        | FK to `recordings.id`                       |
| `transcript_id` | `uuid` nullable        | FK to `post_meeting_transcripts.id`         |
| `event_type`    | `varchar(100)`         | Event name                                  |
| `webhook_url`   | `text`                 | Delivery URL                                |
| `payload`       | `jsonb`                | Payload                                     |
| `status`        | `varchar(50)`          | `pending`, `sending`, `delivered`, `failed` |
| `attempts`      | `int`                  | Count                                       |
| `max_attempts`  | `int`                  | Limit                                       |
| `last_error`    | `text` nullable        | Error                                       |
| `next_retry_at` | `timestamptz` nullable | Retry schedule                              |
| `delivered_at`  | `timestamptz` nullable | Delivered time                              |
| `created_at`    | `timestamptz`          | Timestamp                                   |

### `users`

Purpose:

- First-party end-user identity.

Fields:

| Field        | Type          | Notes                  |
| ------------ | ------------- | ---------------------- |
| `id`         | `uuid`        | PK                     |
| `email`      | `text`        | Unique by lower(email) |
| `created_at` | `timestamptz` | Timestamp              |
| `updated_at` | `timestamptz` | Timestamp              |

Important notes:

- Very thin today.
- No profile, no name, no app-level account/workspace relation.

### `user_sessions`

Purpose:

- Refresh-session storage for first-party auth.

Fields:

| Field                | Type                   | Notes            |
| -------------------- | ---------------------- | ---------------- |
| `id`                 | `uuid`                 | PK               |
| `user_id`            | `uuid`                 | FK to `users.id` |
| `refresh_token_hash` | `text`                 | Stored hashed    |
| `expires_at`         | `timestamptz`          | Expiry           |
| `revoked_at`         | `timestamptz` nullable | Revoked time     |
| `last_used_at`       | `timestamptz` nullable | Last use         |
| `ip_address`         | `inet` nullable        | IP               |
| `user_agent`         | `text` nullable        | UA               |
| `created_at`         | `timestamptz`          | Timestamp        |

### `tenant_claims`

Purpose:

- Temporary claim secret for internal tenant bootstrap / no-signup workspace claim.

Fields:

| Field         | Type                   | Notes              |
| ------------- | ---------------------- | ------------------ |
| `id`          | `uuid`                 | PK                 |
| `tenant_id`   | `uuid`                 | FK to `tenants.id` |
| `secret_hash` | `text`                 | Claim secret hash  |
| `expires_at`  | `timestamptz`          | Expiry             |
| `used_at`     | `timestamptz` nullable | Use time           |
| `created_at`  | `timestamptz`          | Timestamp          |

Important notes:

- This exists because first-party workspace bootstrap is currently modeled as tenant bootstrap.

### `chat_messages`

Purpose:

- Durable room chat.

Fields:

| Field                   | Type           | Notes                   |
| ----------------------- | -------------- | ----------------------- |
| `id`                    | `uuid`         | PK                      |
| `room_id`               | `uuid`         | FK to `rooms.id`        |
| `sender_participant_id` | `uuid`         | FK to `participants.id` |
| `sender_identity_key`   | `text`         | Identity key            |
| `sender_display_name`   | `varchar(255)` | Snapshot display name   |
| `content`               | `text`         | Content                 |
| `created_at`            | `timestamptz`  | Timestamp               |

### `chat_attachments`

Purpose:

- Attachment blobs for chat.

Fields:

| Field                        | Type            | Notes                       |
| ---------------------------- | --------------- | --------------------------- |
| `id`                         | `uuid`          | PK                          |
| `room_id`                    | `uuid`          | FK to `rooms.id`            |
| `message_id`                 | `uuid` nullable | FK to `chat_messages.id`    |
| `uploaded_by_participant_id` | `uuid`          | FK to `participants.id`     |
| `file_name`                  | `varchar(255)`  | Name                        |
| `mime_type`                  | `varchar(255)`  | MIME                        |
| `size_bytes`                 | `bigint`        | <= 25MB                     |
| `kind`                       | `varchar(20)`   | `image`, `document`, `file` |
| `storage_key`                | `varchar(500)`  | Unique storage key          |
| `status`                     | `varchar(20)`   | `pending`, `attached`       |
| `created_at`                 | `timestamptz`   | Timestamp                   |

### `chat_message_reads`

Purpose:

- Read receipts.

Fields:

| Field                   | Type           | Notes                    |
| ----------------------- | -------------- | ------------------------ |
| `message_id`            | `uuid`         | FK to `chat_messages.id` |
| `reader_participant_id` | `uuid`         | FK to `participants.id`  |
| `reader_identity_key`   | `text`         | Identity key             |
| `reader_display_name`   | `varchar(255)` | Display snapshot         |
| `read_at`               | `timestamptz`  | Timestamp                |

Primary key:

- `(message_id, reader_identity_key)`

### `whisper_transcription_jobs`

Purpose:

- Durable history for Whisper queue jobs.

Fields:

| Field                               | Type                    | Notes                                        |
| ----------------------------------- | ----------------------- | -------------------------------------------- |
| `id`                                | `uuid`                  | PK                                           |
| `transcript_id`                     | `uuid`                  | FK to `post_meeting_transcripts.id`          |
| `recording_id`                      | `uuid`                  | FK to `recordings.id`                        |
| `room_id`                           | `uuid`                  | FK to `rooms.id`                             |
| `provider`                          | `varchar(50)`           | Usually `whisper`                            |
| `whisper_job_id`                    | `uuid`                  | Unique upstream job ID                       |
| `queue_key`                         | `text`                  | Queue identifier                             |
| `audio_storage_path`                | `text`                  | Audio path                                   |
| `traceparent`                       | `text` nullable         | Trace                                        |
| `language_hint`                     | `varchar(32)` nullable  | Hint                                         |
| `status`                            | `varchar(50)`           | `queued`, `completed`, `failed`, `timed_out` |
| `queue_depth_at_enqueue`            | `bigint` nullable       | Ops metric                                   |
| `processing_queue_depth_at_enqueue` | `bigint` nullable       | Ops metric                                   |
| `queue_depth_at_timeout`            | `bigint` nullable       | Ops metric                                   |
| `processing_queue_depth_at_timeout` | `bigint` nullable       | Ops metric                                   |
| `result_language`                   | `varchar(10)` nullable  | Result                                       |
| `duration_seconds`                  | `int` nullable          | Duration                                     |
| `word_count`                        | `int` nullable          | Word count                                   |
| `error_message`                     | `text` nullable         | Error                                        |
| `error_class`                       | `varchar(100)` nullable | Error type                                   |
| `error_stage`                       | `varchar(100)` nullable | Stage                                        |
| `download_http_status`              | `int` nullable          | Download status                              |
| `download_size_bytes`               | `bigint` nullable       | Download size                                |
| `created_at`                        | `timestamptz`           | Timestamp                                    |
| `completed_at`                      | `timestamptz` nullable  | Completion                                   |

## Current Relationship Graph

### Core hierarchy

1. `tenant`
2. `room`
3. `participant`, `recording`, `chat_messages`, `transcripts`, `whiteboard_permissions`
4. `post_meeting_transcripts`
5. `whisper_transcription_jobs`

### Auth hierarchy

1. `user`
2. `user_session`
3. `tenant.owner_user_id` only for internal tenants

### Important gap

There is no proper first-party product ownership layer:

- no `account`
- no `workspace`
- no `workspace_membership`
- no `room.created_by_user_id`
- no `room.workspace_id`
- no `participant.user_id`

So for Chalk first-party, `tenant_id` is doing too much:

- app boundary
- ownership boundary
- visibility boundary
- sharing boundary
- room lookup boundary

That is the conceptual bug.

## Current First-Party Problem

Today internal auth effectively does:

- one first-party user
- one internal tenant
- many rooms under that tenant

That means:

- user A’s room exists under tenant A
- user B’s auth resolves to tenant B
- joining by room code/name inside tenant B can miss tenant A’s room
- backend can then auto-create a new room/Cloudflare meeting under tenant B

So the wrong abstraction is:

- "user workspace" == `tenant`

## Proposed Model

### Design principle

Keep `tenant` as infrastructure/app boundary.
Add `workspace` or `account` as product ownership boundary.

For Chalk first-party:

- `apps/web` and `apps/mobile` should live under the same internal tenant per environment
- users/accounts/workspaces should own rooms
- not per-user tenants

## Proposed Tables

### `tenants` (keep, reinterpret)

Purpose:

- Environment/app boundary
- External customers stay here
- First-party Chalk gets one internal tenant per env/app family

Suggested first-party examples:

- `chalk-prod-firstparty`
- `chalk-staging-firstparty`
- `chalk-dev-firstparty`

Keep:

- quotas
- infra config
- webhook config
- feature flags
- tenant_kind

Deprecate first-party dependence on:

- `owner_user_id`
- `claimed_at`
- `tenant_claims` as workspace bootstrap primitive

### `workspaces` or `accounts`

If choosing one layer first, I recommend `workspaces`.

Fields:

| Field                | Type                   | Notes                     |
| -------------------- | ---------------------- | ------------------------- |
| `id`                 | `uuid`                 | PK                        |
| `tenant_id`          | `uuid`                 | FK to `tenants.id`        |
| `name`               | `varchar(255)`         | Workspace name            |
| `slug`               | `varchar(255)`         | Human/URL slug            |
| `kind`               | `varchar(50)`          | personal, team, org, etc. |
| `created_by_user_id` | `uuid`                 | FK to `users.id`          |
| `created_at`         | `timestamptz`          | Timestamp                 |
| `updated_at`         | `timestamptz`          | Timestamp                 |
| `archived_at`        | `timestamptz` nullable | Soft archive              |
| `metadata`           | `jsonb`                | Optional                  |

Why:

- Gives first-party Chalk a real ownership/visibility boundary
- Lets multiple users share one workspace
- Keeps tenant semantics clean

### `workspace_memberships`

Fields:

| Field                | Type                   | Notes                       |
| -------------------- | ---------------------- | --------------------------- |
| `workspace_id`       | `uuid`                 | FK to `workspaces.id`       |
| `user_id`            | `uuid`                 | FK to `users.id`            |
| `role`               | `varchar(50)`          | owner, admin, member, guest |
| `status`             | `varchar(50)`          | active, invited, removed    |
| `invited_by_user_id` | `uuid` nullable        | FK to `users.id`            |
| `joined_at`          | `timestamptz` nullable | Joined                      |
| `created_at`         | `timestamptz`          | Timestamp                   |

Primary key:

- either composite `(workspace_id, user_id)` or surrogate UUID + unique composite index

Why:

- Supports collaboration
- Separates identity from access

### `rooms` (proposed changes)

Add:

| Field                 | Type                    | Notes                            |
| --------------------- | ----------------------- | -------------------------------- |
| `workspace_id`        | `uuid`                  | FK to `workspaces.id`            |
| `created_by_user_id`  | `uuid` nullable         | FK to `users.id`                 |
| `canonical_join_code` | `varchar(255)` nullable | Optional stable user-facing code |

Keep:

- `id`
- `tenant_id`
- `cloudflare_meeting_id`
- scheduling/config/status/etc.

Interpretation after change:

- `tenant_id` = infra/app boundary
- `workspace_id` = ownership/visibility boundary
- `created_by_user_id` = creator attribution
- `id` = canonical join key

### `participants` (proposed changes)

Add:

| Field                     | Type                   | Notes                            |
| ------------------------- | ---------------------- | -------------------------------- |
| `user_id`                 | `uuid` nullable        | FK to `users.id`                 |
| `workspace_membership_id` | `uuid` nullable        | FK to `workspace_memberships`    |
| `join_type`               | `varchar(50)` nullable | member, guest, invitee, external |

Why:

- distinguish authenticated member vs guest vs external participant
- real first-party identity tracing

### `room_share_links` or `room_invites`

Optional but useful if you want durable invite governance.

Fields:

| Field                | Type                   | Notes                        |
| -------------------- | ---------------------- | ---------------------------- |
| `id`                 | `uuid`                 | PK                           |
| `room_id`            | `uuid`                 | FK to `rooms.id`             |
| `created_by_user_id` | `uuid`                 | FK to `users.id`             |
| `token_hash`         | `text`                 | Stored token hash if durable |
| `expires_at`         | `timestamptz` nullable | Expiry                       |
| `revoked_at`         | `timestamptz` nullable | Revoked                      |
| `max_uses`           | `int` nullable         | Limit                        |
| `created_at`         | `timestamptz`          | Timestamp                    |

Not strictly required if stateless signed tokens remain good enough, but useful later.

## Proposed Relationship Graph

### First-party

1. `tenant`
2. `workspace`
3. `workspace_membership`
4. `user`
5. `room`
6. `participant`, `recording`, `chat_messages`, `transcripts`, `whiteboard_permissions`

### In words

- one first-party internal tenant per environment/app family
- many workspaces inside that tenant
- many users in a workspace
- many rooms in a workspace
- participants optionally map back to authenticated users

## What Stays Mostly The Same

These tables can continue to hang off `room_id`:

- `recordings`
- `transcripts`
- `post_meeting_transcripts`
- `whisper_transcription_jobs`
- `chat_messages`
- `chat_attachments`
- `chat_message_reads`
- `whiteboard_permissions`

Possible optional denormalization later:

- add `workspace_id` to `recordings` / `post_meeting_transcripts` / `webhook_deliveries` for faster queries
- not required for the first migration

## Recommended Direction

### Short version

Do this:

1. keep `tenants` for infra/app boundary
2. add `workspaces`
3. add `workspace_memberships`
4. add `rooms.workspace_id`
5. add `rooms.created_by_user_id`
6. add `participants.user_id`
7. make room joins resolve by canonical `room.id`

Do not do this:

1. keep creating one internal tenant per user
2. use room name / room code lookup scoped only by current tenant for first-party Chalk

## My Opinionated Naming Recommendation

If we want minimal moving pieces first:

- `users`
- `workspaces`
- `workspace_memberships`

If we want future billing/org hierarchy:

- `accounts`
- `workspaces`
- `account_memberships`
- `workspace_memberships`

But for Chalk right now, I would start with:

- `workspaces`

It is enough to fix the model without overbuilding.

## Biggest Conceptual Shift

Today:

- `tenant` means customer/app for external users
- `tenant` also means personal workspace for first-party users

Proposed:

- `tenant` always means app/customer/infrastructure boundary
- `workspace` means ownership + collaboration boundary
- `user` means identity

That separation is the real fix.
