/* eslint-disable */
/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Command: pnpm --dir packages/sdk-core run generate:effect-httpclient
 * Source: apps/api/openapi.yaml
 * Generator: @effect/openapi-generator@4.0.0-beta.48 (Effect v4 beta)
 *
 * Note: sdk-core runtime is currently Effect v3. This file is intentionally
 * kept outside src/ so it does not affect the current build pipeline.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SchemaError } from "effect/Schema";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
// non-recursive definitions
export type Error = { readonly error: string };
export const Error = Schema.Struct({ error: Schema.String.annotate({ description: "Error message", examples: ["invalid request body"] }) });
export type TokenRequest = { readonly api_key: string };
export const TokenRequest = Schema.Struct({ api_key: Schema.String.annotate({ description: "Tenant API key", examples: ["ck_live_abc123xyz"] }) });
export type TokenResponse = { readonly access_token: string; readonly refresh_token: string; readonly token_type: string; readonly expires_in: number };
export const TokenResponse = Schema.Struct({
  access_token: Schema.String.annotate({ description: "JWT access token for API calls", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  refresh_token: Schema.String.annotate({ description: "Token to obtain new access token", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  token_type: Schema.String.annotate({ description: "Token type (always 'Bearer')", examples: ["Bearer"] }),
  expires_in: Schema.Number.annotate({ description: "Access token validity in seconds", examples: [3600] }).check(Schema.isInt()),
});
export type RefreshRequest = { readonly refresh_token: string };
export const RefreshRequest = Schema.Struct({ refresh_token: Schema.String.annotate({ description: "Refresh token from previous authentication", examples: ["eyJhbGciOiJIUzI1NiIs..."] }) });
export type DebugPermissions = { readonly can_record: boolean; readonly can_screen_share: boolean; readonly can_kick: boolean; readonly can_mute: boolean };
export const DebugPermissions = Schema.Struct({ can_record: Schema.Boolean.annotate({ examples: [true] }), can_screen_share: Schema.Boolean.annotate({ examples: [true] }), can_kick: Schema.Boolean.annotate({ examples: [true] }), can_mute: Schema.Boolean.annotate({ examples: [true] }) });
export type Tenant = {
  readonly id: string;
  readonly name: string;
  readonly api_key_hash: string;
  readonly config: { readonly [x: string]: unknown };
  readonly max_concurrent_rooms: number;
  readonly max_participants_per_room: number;
  readonly max_recording_duration_minutes: number;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
};
export const Tenant = Schema.Struct({
  id: Schema.String.annotate({ description: "Tenant unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440000"], format: "uuid" }),
  name: Schema.String.annotate({ description: "Tenant name", examples: ["Acme Education"] }),
  api_key_hash: Schema.String.annotate({ description: "Hashed API key (not the actual key)", examples: ["$argon2id$v=19$m=65536..."] }),
  config: Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "Custom tenant configuration" }),
  max_concurrent_rooms: Schema.Number.annotate({ description: "Maximum number of concurrent rooms allowed", examples: [100] }).check(Schema.isInt()),
  max_participants_per_room: Schema.Number.annotate({ description: "Maximum participants per room", examples: [10] }).check(Schema.isInt()),
  max_recording_duration_minutes: Schema.Number.annotate({ description: "Maximum recording duration in minutes", examples: [120] }).check(Schema.isInt()),
  is_active: Schema.Boolean.annotate({ description: "Whether the tenant is active", examples: [true] }),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
  updated_at: Schema.String.annotate({ description: "Last update timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
});
export type CreateTenantRequest = { readonly name: string; readonly max_concurrent_rooms?: number; readonly max_participants_per_room?: number; readonly max_recording_duration_minutes?: number };
export const CreateTenantRequest = Schema.Struct({
  name: Schema.String.annotate({ description: "Tenant name", examples: ["Acme Education"] }),
  max_concurrent_rooms: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum concurrent rooms (default 100)", examples: [100] }).check(Schema.isInt())),
  max_participants_per_room: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum participants per room (default 10)", examples: [10] }).check(Schema.isInt())),
  max_recording_duration_minutes: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum recording duration in minutes (default 120)", examples: [120] }).check(Schema.isInt())),
});
export type UpdateTenantRequest = { readonly name?: string; readonly max_concurrent_rooms?: number; readonly max_participants_per_room?: number; readonly max_recording_duration_minutes?: number };
export const UpdateTenantRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String.annotate({ description: "New tenant name", examples: ["Acme Education Updated"] })),
  max_concurrent_rooms: Schema.optionalKey(Schema.Number.annotate({ description: "New maximum concurrent rooms", examples: [200] }).check(Schema.isInt())),
  max_participants_per_room: Schema.optionalKey(Schema.Number.annotate({ description: "New maximum participants per room", examples: [20] }).check(Schema.isInt())),
  max_recording_duration_minutes: Schema.optionalKey(Schema.Number.annotate({ description: "New maximum recording duration", examples: [180] }).check(Schema.isInt())),
});
export type RotateApiKeyResponse = { readonly api_key: string };
export const RotateApiKeyResponse = Schema.Struct({ api_key: Schema.String.annotate({ description: "New API key (shown only once!)", examples: ["ck_live_newkey123"] }) });
export type Room = {
  readonly id: string;
  readonly tenant_id: string;
  readonly cloudflare_meeting_id: string;
  readonly name?: string | null;
  readonly config: { readonly max_participants?: number; readonly recording_enabled?: boolean; readonly chat_enabled?: boolean; readonly [x: string]: unknown };
  readonly status: "scheduled" | "active" | "ended";
  readonly scheduled_start_at?: string;
  readonly scheduled_end_at?: string;
  readonly allow_early_join_minutes?: number;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly created_at: string;
  readonly updated_at: string;
};
export const Room = Schema.Struct({
  id: Schema.String.annotate({ description: "Room unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  tenant_id: Schema.String.annotate({ description: "Owning tenant ID", examples: ["550e8400-e29b-41d4-a716-446655440000"], format: "uuid" }),
  cloudflare_meeting_id: Schema.String.annotate({ description: "Cloudflare RealtimeKit meeting ID", examples: ["cf_mtg_abc123"] }),
  name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Room name", examples: ["Math 101 - Session 3"] })),
  config: Schema.StructWithRest(
    Schema.Struct({
      max_participants: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum participants allowed", examples: [10] }).check(Schema.isInt())),
      recording_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether recording is enabled", examples: [true] })),
      chat_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether chat is enabled", examples: [true] })),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ).annotate({ description: "Room configuration" }),
  status: Schema.Literals(["scheduled", "active", "ended"]).annotate({ description: "Room status", examples: ["active"] }),
  scheduled_start_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "Scheduled room start timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  scheduled_end_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "Optional scheduled room end timestamp", examples: [null], format: "date-time" })])),
  allow_early_join_minutes: Schema.optionalKey(Schema.Number.annotate({ description: "Minutes participants can join before scheduled_start_at", examples: [10] }).check(Schema.isInt())),
  started_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the room was started", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  ended_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the room was ended", examples: [null], format: "date-time" })])),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
  updated_at: Schema.String.annotate({ description: "Last update timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
});
export type RoomWithParticipantCount = {
  readonly id: string;
  readonly tenant_id: string;
  readonly cloudflare_meeting_id: string;
  readonly name?: string | null;
  readonly config: { readonly max_participants?: number; readonly recording_enabled?: boolean; readonly chat_enabled?: boolean; readonly [x: string]: unknown };
  readonly status: "scheduled" | "active" | "ended";
  readonly scheduled_start_at?: string;
  readonly scheduled_end_at?: string;
  readonly allow_early_join_minutes?: number;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly participant_count?: number;
};
export const RoomWithParticipantCount = Schema.Struct({
  id: Schema.String.annotate({ description: "Room unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  tenant_id: Schema.String.annotate({ description: "Owning tenant ID", examples: ["550e8400-e29b-41d4-a716-446655440000"], format: "uuid" }),
  cloudflare_meeting_id: Schema.String.annotate({ description: "Cloudflare RealtimeKit meeting ID", examples: ["cf_mtg_abc123"] }),
  name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Room name", examples: ["Math 101 - Session 3"] })),
  config: Schema.StructWithRest(
    Schema.Struct({
      max_participants: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum participants allowed", examples: [10] }).check(Schema.isInt())),
      recording_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether recording is enabled", examples: [true] })),
      chat_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether chat is enabled", examples: [true] })),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ).annotate({ description: "Room configuration" }),
  status: Schema.Literals(["scheduled", "active", "ended"]).annotate({ description: "Room status", examples: ["active"] }),
  scheduled_start_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "Scheduled room start timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  scheduled_end_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "Optional scheduled room end timestamp", examples: [null], format: "date-time" })])),
  allow_early_join_minutes: Schema.optionalKey(Schema.Number.annotate({ description: "Minutes participants can join before scheduled_start_at", examples: [10] }).check(Schema.isInt())),
  started_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the room was started", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  ended_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the room was ended", examples: [null], format: "date-time" })])),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
  updated_at: Schema.String.annotate({ description: "Last update timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
  participant_count: Schema.optionalKey(Schema.Number.annotate({ description: "Number of active participants", examples: [5] }).check(Schema.isInt())),
});
export type CreateRoomRequest = { readonly name?: string; readonly config?: { readonly max_participants?: number; readonly recording_enabled?: boolean; readonly chat_enabled?: boolean } };
export const CreateRoomRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String.annotate({ description: "Room name", examples: ["Math 101 - Session 3"] })),
  config: Schema.optionalKey(
    Schema.Struct({
      max_participants: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum participants (default from tenant)", examples: [10] }).check(Schema.isInt())),
      recording_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Enable recording", examples: [true] })),
      chat_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Enable chat", examples: [true] })),
    }),
  ),
});
export type ScheduleRoomRequest = {
  readonly name?: string;
  readonly config?: { readonly max_participants?: number; readonly recording_enabled?: boolean; readonly chat_enabled?: boolean };
  readonly scheduled_start_at: string;
  readonly scheduled_end_at?: string;
  readonly allow_early_join_minutes?: number;
};
export const ScheduleRoomRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String.annotate({ description: "Room name", examples: ["Math 101 - Session 4"] })),
  config: Schema.optionalKey(
    Schema.Struct({
      max_participants: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum participants (default from tenant)", examples: [10] }).check(Schema.isInt())),
      recording_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Enable recording", examples: [true] })),
      chat_enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Enable chat", examples: [true] })),
    }),
  ),
  scheduled_start_at: Schema.String.annotate({ description: "Scheduled room start timestamp (UTC recommended)", examples: ["2026-03-10T14:00:00Z"], format: "date-time" }),
  scheduled_end_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "Optional scheduled room end timestamp", examples: ["2026-03-10T15:00:00Z"], format: "date-time" })])),
  allow_early_join_minutes: Schema.optionalKey(
    Schema.Number.annotate({ description: "Minutes participants can join before scheduled_start_at", examples: [10] })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type UpdateRoomRequest = { readonly name?: string; readonly config?: { readonly [x: string]: unknown } };
export const UpdateRoomRequest = Schema.Struct({ name: Schema.optionalKey(Schema.String.annotate({ description: "New room name", examples: ["Math 101 - Updated Name"] })), config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "New room configuration" })) });
export type Participant = {
  readonly id: string;
  readonly room_id: string;
  readonly cloudflare_participant_id: string;
  readonly external_user_id?: string | null;
  readonly display_name?: string | null;
  readonly role: "host" | "participant";
  readonly joined_at?: string;
  readonly left_at?: string;
  readonly created_at: string;
};
export const Participant = Schema.Struct({
  id: Schema.String.annotate({ description: "Participant unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440002"], format: "uuid" }),
  room_id: Schema.String.annotate({ description: "Room ID the participant belongs to", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  cloudflare_participant_id: Schema.String.annotate({ description: "Cloudflare RealtimeKit participant ID", examples: ["cf_part_abc123"] }),
  external_user_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "External user identifier from your system", examples: ["user_12345"] })),
  display_name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Display name shown in the room", examples: ["John Doe"] })),
  role: Schema.Literals(["host", "participant"]).annotate({ description: "Participant role", examples: ["participant"] }),
  joined_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the participant joined", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  left_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When the participant left", examples: [null], format: "date-time" })])),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
});
export type AddParticipantRequest = { readonly external_user_id?: string; readonly display_name: string; readonly role?: "host" | "participant"; readonly metadata?: { readonly [x: string]: unknown } };
export const AddParticipantRequest = Schema.Struct({
  external_user_id: Schema.optionalKey(Schema.String.annotate({ description: "Your system's user ID", examples: ["user_12345"] })),
  display_name: Schema.String.annotate({ description: "Name shown in the room", examples: ["John Doe"] }),
  role: Schema.optionalKey(Schema.Literals(["host", "participant"]).annotate({ description: "Participant role (default participant)", examples: ["participant"] })),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "Custom metadata attached to the participant", examples: [{ externalId: "user_12345" }] })),
});
export type RefreshParticipantTokenResponse = { readonly access_token: string; readonly refresh_token: string; readonly token_type: string; readonly expires_in: number; readonly auth_token: string };
export const RefreshParticipantTokenResponse = Schema.Struct({
  access_token: Schema.String.annotate({ description: "New JWT access token", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  refresh_token: Schema.String.annotate({ description: "New refresh token", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  token_type: Schema.String.annotate({ description: "Token type", examples: ["Bearer"] }),
  expires_in: Schema.Number.annotate({ description: "Token validity in seconds", examples: [3600] }).check(Schema.isInt()),
  auth_token: Schema.String.annotate({ description: "New Cloudflare RealtimeKit token", examples: ["cf_auth_token_new"] }),
});
export type UpdateParticipantRequest = { readonly display_name?: string; readonly role?: "host" | "participant" };
export const UpdateParticipantRequest = Schema.Struct({
  display_name: Schema.optionalKey(Schema.String.annotate({ description: "Updated display name", examples: ["Jane Doe"] })),
  role: Schema.optionalKey(Schema.Literals(["host", "participant"]).annotate({ description: "Updated participant role (host only for others)", examples: ["participant"] })),
}).annotate({ description: "Participant fields that can be updated." });
export type CreateJoinTokenResponse = { readonly join_token: string };
export const CreateJoinTokenResponse = Schema.Struct({ join_token: Schema.String.annotate({ description: "Opaque token for public join exchange", examples: ["eyJhbGciOiJIUzI1NiIs..."] }) });
export type ExchangeJoinTokenRequest = { readonly join_token: string };
export const ExchangeJoinTokenRequest = Schema.Struct({ join_token: Schema.String.annotate({ description: "Opaque token created by /rooms/{id}/join-token", examples: ["eyJhbGciOiJIUzI1NiIs..."] }) });
export type ExchangeJoinTokenResponse = { readonly access_token: string; readonly expires_in: number; readonly room_id: string; readonly room_name: string };
export const ExchangeJoinTokenResponse = Schema.Struct({
  access_token: Schema.String.annotate({ description: "JWT access token scoped to the resolved room", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  expires_in: Schema.Number.annotate({ description: "Access token validity in seconds", examples: [3600] }).check(Schema.isInt()),
  room_id: Schema.String.annotate({ description: "Resolved room UUID", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  room_name: Schema.String.annotate({ description: "Resolved room name (falls back to room target)", examples: ["Math 101 - Session 3"] }),
});
export type WhiteboardPresignUploadRequest = { readonly file_id: string; readonly mime_type: string };
export const WhiteboardPresignUploadRequest = Schema.Struct({
  file_id: Schema.String.annotate({ description: "Whiteboard asset identifier (single path segment)", examples: ["wb_file_001.png"] }),
  mime_type: Schema.String.annotate({ description: "MIME type of the image file", examples: ["image/png"] }),
});
export type WhiteboardPresignUploadResponse = { readonly upload_url: string; readonly expires_at_ms: number };
export const WhiteboardPresignUploadResponse = Schema.Struct({
  upload_url: Schema.String.annotate({ description: "Presigned upload URL", examples: ["https://r2.example/upload?sig=..."], format: "uri" }),
  expires_at_ms: Schema.Number.annotate({ description: "Expiration timestamp in Unix milliseconds", examples: [1766022312345], format: "int64" }).check(Schema.isInt()),
});
export type WhiteboardPresignDownloadRequest = { readonly file_id: string };
export const WhiteboardPresignDownloadRequest = Schema.Struct({ file_id: Schema.String.annotate({ description: "Whiteboard asset identifier", examples: ["wb_file_001.png"] }) });
export type WhiteboardPresignDownloadResponse = { readonly download_url: string; readonly expires_at_ms: number };
export const WhiteboardPresignDownloadResponse = Schema.Struct({
  download_url: Schema.String.annotate({ description: "Presigned download URL", examples: ["https://r2.example/download?sig=..."], format: "uri" }),
  expires_at_ms: Schema.Number.annotate({ description: "Expiration timestamp in Unix milliseconds", examples: [1766022312345], format: "int64" }).check(Schema.isInt()),
});
export type ChatPresignUploadFile = { readonly file_name: string; readonly mime_type: string; readonly size_bytes: number };
export const ChatPresignUploadFile = Schema.Struct({
  file_name: Schema.String.annotate({ description: "Original file name", examples: ["notes.pdf"] }),
  mime_type: Schema.String.annotate({ description: "MIME type for the attachment", examples: ["application/pdf"] }),
  size_bytes: Schema.Number.annotate({ description: "Attachment file size in bytes", examples: [204800], format: "int64" }).check(Schema.isInt()),
});
export type ChatPresignUploadResponseItem = { readonly attachment_id: string; readonly upload_url: string; readonly expires_at_ms: number; readonly file_name: string; readonly mime_type: string; readonly size_bytes: number; readonly kind: string };
export const ChatPresignUploadResponseItem = Schema.Struct({
  attachment_id: Schema.String.annotate({ description: "Pending attachment UUID", examples: ["550e8400-e29b-41d4-a716-446655440099"], format: "uuid" }),
  upload_url: Schema.String.annotate({ description: "Presigned upload URL", examples: ["https://r2.example/upload?sig=..."], format: "uri" }),
  expires_at_ms: Schema.Number.annotate({ description: "Expiration timestamp in Unix milliseconds", examples: [1766022312345], format: "int64" }).check(Schema.isInt()),
  file_name: Schema.String.annotate({ description: "Original file name", examples: ["notes.pdf"] }),
  mime_type: Schema.String.annotate({ description: "MIME type", examples: ["application/pdf"] }),
  size_bytes: Schema.Number.annotate({ description: "File size in bytes", examples: [204800], format: "int64" }).check(Schema.isInt()),
  kind: Schema.String.annotate({ description: "Attachment kind inferred by server", examples: ["document"] }),
});
export type ChatPresignDownloadRequest = { readonly attachment_id: string };
export const ChatPresignDownloadRequest = Schema.Struct({ attachment_id: Schema.String.annotate({ description: "Attachment UUID", examples: ["550e8400-e29b-41d4-a716-446655440099"], format: "uuid" }) });
export type ChatPresignDownloadResponse = { readonly download_url: string; readonly expires_at_ms: number };
export const ChatPresignDownloadResponse = Schema.Struct({
  download_url: Schema.String.annotate({ description: "Presigned download URL", examples: ["https://r2.example/download?sig=..."], format: "uri" }),
  expires_at_ms: Schema.Number.annotate({ description: "Expiration timestamp in Unix milliseconds", examples: [1766022312345], format: "int64" }).check(Schema.isInt()),
});
export type Recording = {
  readonly id: string;
  readonly room_id: string;
  readonly cloudflare_recording_id?: string | null;
  readonly storage_provider?: "r2" | "s3_glacier" | null;
  readonly storage_path?: string | null;
  readonly size_bytes?: number | null;
  readonly duration_seconds?: number | null;
  readonly status: "recording" | "processing" | "ready" | "archived" | "deleted";
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly archived_at?: string;
  readonly created_at: string;
};
export const Recording = Schema.Struct({
  id: Schema.String.annotate({ description: "Recording unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }),
  room_id: Schema.String.annotate({ description: "Room ID the recording belongs to", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  cloudflare_recording_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Cloudflare recording ID", examples: ["cf_rec_abc123"] })),
  storage_provider: Schema.optionalKey(Schema.Union([Schema.Literals(["r2", "s3_glacier"]).annotate({ description: "Storage provider", examples: ["r2"] }), Schema.Union([Schema.Null]).annotate({ description: "Storage provider", examples: ["r2"] })])),
  storage_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Path to stored recording file", examples: ["recordings/room_id/recording_id.webm"] })),
  size_bytes: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "Recording file size in bytes", examples: [104857600] })),
  duration_seconds: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "Recording duration in seconds", examples: [3600] })),
  status: Schema.Literals(["recording", "processing", "ready", "archived", "deleted"]).annotate({ description: "Recording status", examples: ["ready"] }),
  started_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording started", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  ended_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording ended", examples: ["2024-01-15T11:30:00Z"], format: "date-time" })])),
  archived_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording was archived", examples: [null], format: "date-time" })])),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
});
export type RecordingWithRoomInfo = {
  readonly id: string;
  readonly room_id: string;
  readonly cloudflare_recording_id?: string | null;
  readonly storage_provider?: "r2" | "s3_glacier" | null;
  readonly storage_path?: string | null;
  readonly size_bytes?: number | null;
  readonly duration_seconds?: number | null;
  readonly status: "recording" | "processing" | "ready" | "archived" | "deleted";
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly archived_at?: string;
  readonly created_at: string;
  readonly room_name?: string | null;
  readonly tenant_id?: string;
};
export const RecordingWithRoomInfo = Schema.Struct({
  id: Schema.String.annotate({ description: "Recording unique identifier", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }),
  room_id: Schema.String.annotate({ description: "Room ID the recording belongs to", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
  cloudflare_recording_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Cloudflare recording ID", examples: ["cf_rec_abc123"] })),
  storage_provider: Schema.optionalKey(Schema.Union([Schema.Literals(["r2", "s3_glacier"]).annotate({ description: "Storage provider", examples: ["r2"] }), Schema.Union([Schema.Null]).annotate({ description: "Storage provider", examples: ["r2"] })])),
  storage_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Path to stored recording file", examples: ["recordings/room_id/recording_id.webm"] })),
  size_bytes: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "Recording file size in bytes", examples: [104857600] })),
  duration_seconds: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "Recording duration in seconds", examples: [3600] })),
  status: Schema.Literals(["recording", "processing", "ready", "archived", "deleted"]).annotate({ description: "Recording status", examples: ["ready"] }),
  started_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording started", examples: ["2024-01-15T10:30:00Z"], format: "date-time" })])),
  ended_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording ended", examples: ["2024-01-15T11:30:00Z"], format: "date-time" })])),
  archived_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ description: "When recording was archived", examples: [null], format: "date-time" })])),
  created_at: Schema.String.annotate({ description: "Creation timestamp", examples: ["2024-01-15T10:30:00Z"], format: "date-time" }),
  room_name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Name of the room", examples: ["Math 101 - Session 3"] })),
  tenant_id: Schema.optionalKey(Schema.String.annotate({ description: "Tenant ID", examples: ["550e8400-e29b-41d4-a716-446655440000"], format: "uuid" })),
});
export type DownloadRecordingResponse = { readonly recording_id: string; readonly download_url?: string; readonly status: "ready" | "processing" | "recording"; readonly message?: string; readonly duration?: number | null; readonly file_size?: number | null; readonly provider?: string | null };
export const DownloadRecordingResponse = Schema.Struct({
  recording_id: Schema.String.annotate({ description: "Recording ID", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }),
  download_url: Schema.optionalKey(Schema.String.annotate({ description: "Presigned download URL (if ready)", examples: ["https://storage.example.com/recordings/...?sig=..."], format: "uri" })),
  status: Schema.Literals(["ready", "processing", "recording"]).annotate({ description: "Recording status", examples: ["ready"] }),
  message: Schema.optionalKey(Schema.String.annotate({ description: "Status message (if processing)", examples: ["recording is still processing"] })),
  duration: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "Recording duration in seconds", examples: [3600] })),
  file_size: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]).annotate({ description: "File size in bytes", examples: [104857600] })),
  provider: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Storage provider", examples: ["r2"] })),
});
export type ArchiveRecordingResponse = { readonly message: string; readonly id: string; readonly status: string };
export const ArchiveRecordingResponse = Schema.Struct({
  message: Schema.String.annotate({ description: "Success message", examples: ["recording archived successfully"] }),
  id: Schema.String.annotate({ description: "Recording ID", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }),
  status: Schema.String.annotate({ description: "New status", examples: ["archived"] }),
});
export type DeleteRecordingResponse = { readonly message: string; readonly id: string };
export const DeleteRecordingResponse = Schema.Struct({ message: Schema.String.annotate({ description: "Success message", examples: ["recording deleted"] }), id: Schema.String.annotate({ description: "Recording ID", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }) });
export type RecordingReadyWebhook = { readonly type: "recording.ready"; readonly recording_id: string; readonly meeting_id: string; readonly url: string; readonly duration_seconds: number; readonly size_bytes: number; readonly content_type: string };
export const RecordingReadyWebhook = Schema.Struct({
  type: Schema.Literal("recording.ready").annotate({ description: "Webhook event type", examples: ["recording.ready"] }),
  recording_id: Schema.String.annotate({ description: "Cloudflare recording ID", examples: ["cf_rec_abc123"] }),
  meeting_id: Schema.String.annotate({ description: "Cloudflare meeting ID", examples: ["cf_mtg_abc123"] }),
  url: Schema.String.annotate({ description: "URL to download the recording", examples: ["https://cloudflare.com/recordings/..."], format: "uri" }),
  duration_seconds: Schema.Number.annotate({ description: "Recording duration in seconds", examples: [3600] }).check(Schema.isInt()),
  size_bytes: Schema.Number.annotate({ description: "Recording file size in bytes", examples: [104857600], format: "int64" }).check(Schema.isInt()),
  content_type: Schema.String.annotate({ description: "Content type of the recording", examples: ["video/webm"] }),
});
export type PostMeetingWebhookPayload = { readonly event: string; readonly timestamp: string; readonly meeting: { readonly id: string; readonly name?: string } };
export const PostMeetingWebhookPayload = Schema.Struct({
  event: Schema.String.annotate({ description: "Webhook event type", examples: ["meeting.recording_ready"] }),
  timestamp: Schema.String.annotate({ description: "UTC timestamp for the event", examples: ["2026-01-31T00:00:00Z"], format: "date-time" }),
  meeting: Schema.Struct({ id: Schema.String.annotate({ description: "Room ID", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }), name: Schema.optionalKey(Schema.String.annotate({ description: "Room name", examples: ["Algebra 101"] })) }),
});
export type WebhookAckResponse = { readonly received: boolean };
export const WebhookAckResponse = Schema.Struct({ received: Schema.Boolean.annotate({ description: "Whether the webhook was accepted", examples: [true] }) });
export type WebhookRecordingResponse = { readonly message: string; readonly id: string; readonly status: string; readonly storage_key: string; readonly size_bytes: number; readonly duration: number };
export const WebhookRecordingResponse = Schema.Struct({
  message: Schema.String.annotate({ description: "Success message", examples: ["recording processed successfully"] }),
  id: Schema.String.annotate({ description: "Recording ID", examples: ["550e8400-e29b-41d4-a716-446655440003"], format: "uuid" }),
  status: Schema.String.annotate({ description: "Recording status", examples: ["ready"] }),
  storage_key: Schema.String.annotate({ description: "Storage path in R2", examples: ["recordings/room_id/recording_id.webm"] }),
  size_bytes: Schema.Number.annotate({ description: "File size in bytes", examples: [104857600], format: "int64" }).check(Schema.isInt()),
  duration: Schema.Number.annotate({ description: "Duration in seconds", examples: [3600] }).check(Schema.isInt()),
});
export type OpaqueObject = { readonly [x: string]: unknown };
export const OpaqueObject = Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "Opaque object returned directly from service/query layer." });
export type InternalAuthGoogleRequest = { readonly code: string };
export const InternalAuthGoogleRequest = Schema.Struct({ code: Schema.String });
export type InternalAuthUser = { readonly email: string };
export const InternalAuthUser = Schema.Struct({ email: Schema.String.annotate({ format: "email" }) });
export type InternalAuthLogoutResponse = { readonly ok: boolean };
export const InternalAuthLogoutResponse = Schema.Struct({ ok: Schema.Boolean });
export type InternalAuthAccessTokenResponse = { readonly access_token: string; readonly expires_in: number };
export const InternalAuthAccessTokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number.check(Schema.isInt()) });
export type OpsDeclareIncidentRequest = {
  readonly actor_id?: string;
  readonly actor_kind?: string;
  readonly incident_code?: string;
  readonly title: string;
  readonly summary?: string;
  readonly severity: string;
  readonly status?: string;
  readonly visibility?: string;
  readonly source_kind?: string;
  readonly source_key?: string;
  readonly component_ids?: ReadonlyArray<string>;
  readonly dedupe_key?: string;
  readonly idempotency_key?: string;
  readonly public_message?: string;
  readonly public_title?: string;
  readonly metadata?: { readonly [x: string]: unknown };
  readonly event_message?: string;
  readonly occurred_at?: string;
};
export const OpsDeclareIncidentRequest = Schema.Struct({
  actor_id: Schema.optionalKey(Schema.String),
  actor_kind: Schema.optionalKey(Schema.String),
  incident_code: Schema.optionalKey(Schema.String),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  severity: Schema.String,
  status: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.String),
  source_kind: Schema.optionalKey(Schema.String),
  source_key: Schema.optionalKey(Schema.String),
  component_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  dedupe_key: Schema.optionalKey(Schema.String),
  idempotency_key: Schema.optionalKey(Schema.String),
  public_message: Schema.optionalKey(Schema.String),
  public_title: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  event_message: Schema.optionalKey(Schema.String),
  occurred_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export type OpsAddIncidentEventRequest = {
  readonly actor_id?: string;
  readonly actor_kind?: string;
  readonly event_type: string;
  readonly visibility?: string;
  readonly message: string;
  readonly metadata?: { readonly [x: string]: unknown };
  readonly idempotency_key?: string;
  readonly event_at?: string;
  readonly transition_to?: string;
  readonly public_message?: string;
  readonly public_title?: string;
  readonly updated_summary?: string;
};
export const OpsAddIncidentEventRequest = Schema.Struct({
  actor_id: Schema.optionalKey(Schema.String),
  actor_kind: Schema.optionalKey(Schema.String),
  event_type: Schema.String,
  visibility: Schema.optionalKey(Schema.String),
  message: Schema.String,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  idempotency_key: Schema.optionalKey(Schema.String),
  event_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  transition_to: Schema.optionalKey(Schema.String),
  public_message: Schema.optionalKey(Schema.String),
  public_title: Schema.optionalKey(Schema.String),
  updated_summary: Schema.optionalKey(Schema.String),
});
export type OpsPublishIncidentRequest = { readonly actor_id?: string; readonly actor_kind?: string; readonly message?: string; readonly public_message?: string; readonly public_title?: string; readonly event_at?: string };
export const OpsPublishIncidentRequest = Schema.Struct({
  actor_id: Schema.optionalKey(Schema.String),
  actor_kind: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  public_message: Schema.optionalKey(Schema.String),
  public_title: Schema.optionalKey(Schema.String),
  event_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export type OpsResolveIncidentRequest = { readonly actor_id?: string; readonly actor_kind?: string; readonly message?: string; readonly summary?: string; readonly event_at?: string };
export const OpsResolveIncidentRequest = Schema.Struct({
  actor_id: Schema.optionalKey(Schema.String),
  actor_kind: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  event_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export type OpsMaintenanceRequest = { readonly actor_id?: string; readonly actor_kind?: string; readonly title: string; readonly summary?: string; readonly component_ids: ReadonlyArray<string>; readonly starts_at: string; readonly ends_at: string; readonly public_message?: string };
export const OpsMaintenanceRequest = Schema.Struct({
  actor_id: Schema.optionalKey(Schema.String),
  actor_kind: Schema.optionalKey(Schema.String),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  component_ids: Schema.Array(Schema.String),
  starts_at: Schema.String.annotate({ format: "date-time" }),
  ends_at: Schema.String.annotate({ format: "date-time" }),
  public_message: Schema.optionalKey(Schema.String),
});
export type OpsIngestMonitorResultRequest = {
  readonly monitor_key: string;
  readonly status: string;
  readonly checked_at?: string;
  readonly run_id?: string;
  readonly result_key?: string;
  readonly http_status?: number | null;
  readonly latency_ms?: number | null;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly details?: { readonly [x: string]: unknown };
  readonly reported_source?: string;
  readonly reported_emitter_id?: string;
};
export const OpsIngestMonitorResultRequest = Schema.Struct({
  monitor_key: Schema.String,
  status: Schema.String,
  checked_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  run_id: Schema.optionalKey(Schema.String),
  result_key: Schema.optionalKey(Schema.String),
  http_status: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null])),
  latency_ms: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null])),
  error_code: Schema.optionalKey(Schema.String),
  error_message: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  reported_source: Schema.optionalKey(Schema.String),
  reported_emitter_id: Schema.optionalKey(Schema.String),
});
export type OpsIngestHeartbeatRequest = {
  readonly heartbeat_key: string;
  readonly status: string;
  readonly event_at?: string;
  readonly event_key?: string;
  readonly error_message?: string;
  readonly details?: { readonly [x: string]: unknown };
  readonly reported_source?: string;
  readonly reported_emitter_id?: string;
};
export const OpsIngestHeartbeatRequest = Schema.Struct({
  heartbeat_key: Schema.String,
  status: Schema.String,
  event_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  event_key: Schema.optionalKey(Schema.String),
  error_message: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  reported_source: Schema.optionalKey(Schema.String),
  reported_emitter_id: Schema.optionalKey(Schema.String),
});
export type OpsStatusSummaryResponse = { readonly [x: string]: unknown };
export const OpsStatusSummaryResponse = Schema.Record(Schema.String, Schema.Unknown);
export type WhatsNewResponse = { readonly version: string; readonly published_at: string; readonly title: string; readonly content: string; readonly image_url?: string; readonly release_type?: string };
export const WhatsNewResponse = Schema.Struct({ version: Schema.String, published_at: Schema.String.annotate({ format: "date-time" }), title: Schema.String, content: Schema.String, image_url: Schema.optionalKey(Schema.String), release_type: Schema.optionalKey(Schema.String) });
export type QueueTranscriptionRequest = { readonly room_id: string; readonly provider?: string };
export const QueueTranscriptionRequest = Schema.Struct({ room_id: Schema.String.annotate({ format: "uuid" }), provider: Schema.optionalKey(Schema.String) });
export type QueueTranscriptionResponse = { readonly transcript_id: string; readonly status: "pending" };
export const QueueTranscriptionResponse = Schema.Struct({ transcript_id: Schema.String.annotate({ format: "uuid" }), status: Schema.Literal("pending") });
export type TranscriptionCallbackResponse = { readonly ok: boolean; readonly transcript: string; readonly status: string; readonly state_changed: boolean };
export const TranscriptionCallbackResponse = Schema.Struct({ ok: Schema.Boolean, transcript: Schema.String.annotate({ format: "uuid" }), status: Schema.String, state_changed: Schema.Boolean });
export type RecordingRecoverResponse = { readonly message: string; readonly recording_id: string; readonly cloudflare_status?: string; readonly file_size?: number; readonly duration?: number };
export const RecordingRecoverResponse = Schema.Struct({
  message: Schema.String,
  recording_id: Schema.String.annotate({ format: "uuid" }),
  cloudflare_status: Schema.optionalKey(Schema.String),
  file_size: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  duration: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
});
export type RecordingShareTokenResponse = { readonly share_token: string };
export const RecordingShareTokenResponse = Schema.Struct({ share_token: Schema.String });
export type BulkAddParticipantsRequest = { readonly participants: ReadonlyArray<{ readonly display_name: string; readonly external_user_id?: string; readonly role?: string; readonly metadata?: { readonly [x: string]: unknown } }> };
export const BulkAddParticipantsRequest = Schema.Struct({
  participants: Schema.Array(Schema.Struct({ display_name: Schema.String, external_user_id: Schema.optionalKey(Schema.String), role: Schema.optionalKey(Schema.String), metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })).check(Schema.isMinLength(1)),
});
export type BulkAddParticipantsResult = { readonly participant_id?: string; readonly external_user_id?: string; readonly display_name: string; readonly success: boolean; readonly access_token?: string; readonly auth_token?: string; readonly error?: string };
export const BulkAddParticipantsResult = Schema.Struct({
  participant_id: Schema.optionalKey(Schema.String.annotate({ format: "uuid" })),
  external_user_id: Schema.optionalKey(Schema.String),
  display_name: Schema.String,
  success: Schema.Boolean,
  access_token: Schema.optionalKey(Schema.String),
  auth_token: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type PublicShareRecording = {
  readonly id: string;
  readonly room_id: string;
  readonly room_name: string;
  readonly status: string;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly duration?: number | null;
  readonly size_bytes?: number | null;
  readonly download_url?: string | null;
  readonly metadata?: {};
};
export const PublicShareRecording = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }),
  room_id: Schema.String.annotate({ format: "uuid" }),
  room_name: Schema.String,
  status: Schema.String,
  started_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ format: "date-time" })])),
  ended_at: Schema.optionalKey(Schema.Union([Schema.String.annotate({ format: "date-time" })])),
  duration: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null])),
  size_bytes: Schema.optionalKey(Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null])),
  download_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  metadata: Schema.optionalKey(Schema.Union([Schema.Struct({})])),
});
export type DebugClientIncidentContext = { readonly url?: string; readonly userAgent?: string; readonly online?: boolean; readonly visibilityState?: string };
export const DebugClientIncidentContext = Schema.Struct({ url: Schema.optionalKey(Schema.String), userAgent: Schema.optionalKey(Schema.String), online: Schema.optionalKey(Schema.Boolean), visibilityState: Schema.optionalKey(Schema.String) });
export type DebugClientIncidentRequest = {
  readonly incident_id: string;
  readonly source: string;
  readonly stage?: string;
  readonly severity?: string;
  readonly message: string;
  readonly error_name?: string;
  readonly error_code?: string;
  readonly request_url?: string;
  readonly request_method?: string;
  readonly session_id?: string;
  readonly room_id?: string;
  readonly meeting_url?: string;
  readonly external_id?: string;
  readonly user_agent?: string;
  readonly page_url?: string;
  readonly online?: boolean;
  readonly visibility?: string;
  readonly details?: { readonly [x: string]: unknown };
};
export const DebugClientIncidentRequest = Schema.Struct({
  incident_id: Schema.String,
  source: Schema.String,
  stage: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.String),
  message: Schema.String,
  error_name: Schema.optionalKey(Schema.String),
  error_code: Schema.optionalKey(Schema.String),
  request_url: Schema.optionalKey(Schema.String),
  request_method: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  room_id: Schema.optionalKey(Schema.String),
  meeting_url: Schema.optionalKey(Schema.String),
  external_id: Schema.optionalKey(Schema.String),
  user_agent: Schema.optionalKey(Schema.String),
  page_url: Schema.optionalKey(Schema.String),
  online: Schema.optionalKey(Schema.Boolean),
  visibility: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type DebugClientIncidentAcceptedResponse = { readonly accepted: boolean; readonly incident_id: string; readonly request_id: string };
export const DebugClientIncidentAcceptedResponse = Schema.Struct({ accepted: Schema.Boolean, incident_id: Schema.String, request_id: Schema.String });
export type AdminTenantUpdateRequest = { readonly name?: string; readonly max_concurrent_rooms?: number; readonly max_participants_per_room?: number; readonly max_recording_duration_minutes?: number };
export const AdminTenantUpdateRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  max_concurrent_rooms: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_participants_per_room: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_recording_duration_minutes: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
});
export type TenantConfigUpdateRequest = {
  readonly force_recording?: boolean;
  readonly auto_start_recording?: boolean;
  readonly allow_early_join?: boolean;
  readonly empty_room_timeout_minutes?: number;
  readonly recording_retention_days?: number;
  readonly duplicate_participant_policy?: string;
  readonly transcription_enabled?: boolean;
  readonly transcription_language?: string;
  readonly transcription_profanity_filter?: boolean;
  readonly transcription_keywords?: ReadonlyArray<string>;
  readonly allowed_origins?: ReadonlyArray<string>;
  readonly post_meeting_webhook?: {
    readonly enabled?: boolean;
    readonly url?: string;
    readonly secret?: string;
    readonly include_recording?: boolean;
    readonly include_transcript?: boolean;
    readonly include_summary?: boolean;
    readonly include_action_items?: boolean;
    readonly transcription?: { readonly provider?: string; readonly api_key?: string };
    readonly ai?: { readonly provider?: string; readonly api_key?: string; readonly model?: string };
  };
};
export const TenantConfigUpdateRequest = Schema.Struct({
  force_recording: Schema.optionalKey(Schema.Boolean),
  auto_start_recording: Schema.optionalKey(Schema.Boolean),
  allow_early_join: Schema.optionalKey(Schema.Boolean),
  empty_room_timeout_minutes: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  recording_retention_days: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  duplicate_participant_policy: Schema.optionalKey(Schema.String),
  transcription_enabled: Schema.optionalKey(Schema.Boolean),
  transcription_language: Schema.optionalKey(Schema.String),
  transcription_profanity_filter: Schema.optionalKey(Schema.Boolean),
  transcription_keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  allowed_origins: Schema.optionalKey(Schema.Array(Schema.String)),
  post_meeting_webhook: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      url: Schema.optionalKey(Schema.String),
      secret: Schema.optionalKey(Schema.String),
      include_recording: Schema.optionalKey(Schema.Boolean),
      include_transcript: Schema.optionalKey(Schema.Boolean),
      include_summary: Schema.optionalKey(Schema.Boolean),
      include_action_items: Schema.optionalKey(Schema.Boolean),
      transcription: Schema.optionalKey(Schema.Struct({ provider: Schema.optionalKey(Schema.String), api_key: Schema.optionalKey(Schema.String) })),
      ai: Schema.optionalKey(Schema.Struct({ provider: Schema.optionalKey(Schema.String), api_key: Schema.optionalKey(Schema.String), model: Schema.optionalKey(Schema.String) })),
    }),
  ),
});
export type DebugAuthResponse = {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly room_id: string;
  readonly display_name: string | null;
  readonly role: string | null;
  readonly permissions: DebugPermissions;
  readonly scopes: ReadonlyArray<string>;
  readonly token_issued_at: string;
  readonly token_expires_at: string;
  readonly token_expires_in_seconds: number;
  readonly server_time: string;
  readonly api_version: string;
  readonly api_commit_sha: string;
  readonly api_build_time: string;
  readonly request_id: string;
  readonly trace_id: string;
};
export const DebugAuthResponse = Schema.Struct({
  user_id: Schema.String.annotate({ description: "Token subject (participant id or tenant id)", examples: ["user-123"] }),
  tenant_id: Schema.Union([Schema.String.annotate({ format: "uuid" })]),
  room_id: Schema.Union([Schema.String.annotate({ format: "uuid" })]),
  display_name: Schema.Union([Schema.String, Schema.Null]).annotate({ examples: ["Hasan"] }),
  role: Schema.Union([Schema.String, Schema.Null]).annotate({ examples: ["host"] }),
  permissions: DebugPermissions,
  scopes: Schema.Array(Schema.String).annotate({ examples: [["recording:control", "room:screenshare"]] }),
  token_issued_at: Schema.String.annotate({ description: "JWT issued-at time (server truth)", format: "date-time" }),
  token_expires_at: Schema.String.annotate({ description: "JWT expiry time (server truth)", format: "date-time" }),
  token_expires_in_seconds: Schema.Number.annotate({ description: "Seconds until expiry as computed by the server", examples: [3600] }).check(Schema.isInt()),
  server_time: Schema.String.annotate({ description: "Server time for clock drift detection", format: "date-time" }),
  api_version: Schema.String.annotate({ description: "API version identifier (build-stamped)" }),
  api_commit_sha: Schema.String.annotate({ description: "Git commit SHA (build-stamped)" }),
  api_build_time: Schema.String.annotate({ description: "Build time (build-stamped)" }),
  request_id: Schema.String.annotate({ description: "Request correlation id (X-Request-ID)" }),
  trace_id: Schema.String.annotate({ description: "OpenTelemetry trace id when available (may be empty)" }),
});
export type CreateTenantResponse = { readonly tenant: Tenant; readonly api_key: string };
export const CreateTenantResponse = Schema.Struct({ tenant: Tenant, api_key: Schema.String.annotate({ description: "API key for the tenant. This is only shown once!\nStore it securely.\n", examples: ["ck_live_abc123xyz"] }) });
export type ListRoomsResponse = { readonly rooms: ReadonlyArray<RoomWithParticipantCount>; readonly total: number; readonly limit: number; readonly offset: number };
export const ListRoomsResponse = Schema.Struct({
  rooms: Schema.Array(RoomWithParticipantCount),
  total: Schema.Number.annotate({ description: "Total number of rooms", examples: [42] }).check(Schema.isInt()),
  limit: Schema.Number.annotate({ description: "Requested limit", examples: [20] }).check(Schema.isInt()),
  offset: Schema.Number.annotate({ description: "Requested offset", examples: [0] }).check(Schema.isInt()),
});
export type AddParticipantResponse = {
  readonly participant: Participant;
  readonly room: { readonly id: string; readonly name: string; readonly status: string };
  readonly room_created: boolean;
  readonly tenant_config: { readonly transcription_enabled: boolean; readonly first_participant_is_host: boolean; readonly force_recording: boolean; readonly allow_early_join: boolean };
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly auth_token: string;
  readonly should_start_recording?: boolean;
};
export const AddParticipantResponse = Schema.Struct({
  participant: Participant,
  room: Schema.Struct({
    id: Schema.String.annotate({ description: "Room identifier", examples: ["550e8400-e29b-41d4-a716-446655440001"], format: "uuid" }),
    name: Schema.String.annotate({ description: "Room display name", examples: ["Math 101 - Session 3"] }),
    status: Schema.String.annotate({ description: "Current room lifecycle status", examples: ["active"] }),
  }),
  room_created: Schema.Boolean.annotate({ description: "Whether the room was auto-created during this join", examples: [false] }),
  tenant_config: Schema.Struct({
    transcription_enabled: Schema.Boolean.annotate({ examples: [false] }),
    first_participant_is_host: Schema.Boolean.annotate({ examples: [false] }),
    force_recording: Schema.Boolean.annotate({ examples: [false] }),
    allow_early_join: Schema.Boolean.annotate({ examples: [true] }),
  }),
  access_token: Schema.String.annotate({ description: "JWT access token for API calls", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  refresh_token: Schema.String.annotate({ description: "Token to obtain new access token", examples: ["eyJhbGciOiJIUzI1NiIs..."] }),
  token_type: Schema.String.annotate({ description: "Token type", examples: ["Bearer"] }),
  expires_in: Schema.Number.annotate({ description: "Token validity in seconds", examples: [3600] }).check(Schema.isInt()),
  auth_token: Schema.String.annotate({ description: "Cloudflare RealtimeKit token for SDK connection", examples: ["cf_auth_token_xyz"] }),
  should_start_recording: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether the joining participant should trigger recording start", examples: [false] })),
});
export type ListParticipantsResponse = { readonly participants: ReadonlyArray<Participant> };
export const ListParticipantsResponse = Schema.Struct({ participants: Schema.Array(Participant) });
export type ChatPresignUploadRequest = { readonly files: ReadonlyArray<ChatPresignUploadFile> };
export const ChatPresignUploadRequest = Schema.Struct({ files: Schema.Array(ChatPresignUploadFile) });
export type ChatPresignUploadResponse = { readonly files: ReadonlyArray<ChatPresignUploadResponseItem> };
export const ChatPresignUploadResponse = Schema.Struct({ files: Schema.Array(ChatPresignUploadResponseItem) });
export type ListRecordingsResponse = { readonly recordings: ReadonlyArray<Recording>; readonly limit: number; readonly offset: number };
export const ListRecordingsResponse = Schema.Struct({
  recordings: Schema.Array(Recording),
  limit: Schema.Number.annotate({ description: "Requested limit", examples: [20] }).check(Schema.isInt()),
  offset: Schema.Number.annotate({ description: "Requested offset", examples: [0] }).check(Schema.isInt()),
});
export type RecordingSyncResponse = { readonly message: string; readonly synced: number; readonly existing: number; readonly errors: ReadonlyArray<string>; readonly recordings: ReadonlyArray<Recording> };
export const RecordingSyncResponse = Schema.Struct({ message: Schema.String, synced: Schema.Number.check(Schema.isInt()), existing: Schema.Number.check(Schema.isInt()), errors: Schema.Array(Schema.String), recordings: Schema.Array(Recording) });
export type OpaqueObjectArray = ReadonlyArray<OpaqueObject>;
export const OpaqueObjectArray = Schema.Array(OpaqueObject);
export type OpsIngestMonitorResultResponse = { readonly result: OpaqueObject; readonly incident: OpaqueObject | null };
export const OpsIngestMonitorResultResponse = Schema.Struct({ result: OpaqueObject, incident: Schema.Union([OpaqueObject, Schema.Null], { mode: "oneOf" }) });
export type OpsIngestHeartbeatResponse = { readonly event: OpaqueObject; readonly incident: OpaqueObject | null };
export const OpsIngestHeartbeatResponse = Schema.Struct({ event: OpaqueObject, incident: Schema.Union([OpaqueObject, Schema.Null], { mode: "oneOf" }) });
export type TranscriptionProvidersResponse = { readonly providers: ReadonlyArray<OpaqueObject>; readonly default_provider: string };
export const TranscriptionProvidersResponse = Schema.Struct({ providers: Schema.Array(OpaqueObject), default_provider: Schema.String });
export type AdminWhisperJobStatsResponse = { readonly queued_live: number; readonly processing_live: number; readonly recorded: OpaqueObject };
export const AdminWhisperJobStatsResponse = Schema.Struct({ queued_live: Schema.Number.check(Schema.isInt()), processing_live: Schema.Number.check(Schema.isInt()), recorded: OpaqueObject });
export type InternalAuthGoogleResponse = { readonly ok: boolean; readonly tenant_id: string; readonly user: InternalAuthUser };
export const InternalAuthGoogleResponse = Schema.Struct({ ok: Schema.Boolean, tenant_id: Schema.String.annotate({ format: "uuid" }), user: InternalAuthUser });
export type InternalAuthSessionResponse = { readonly user: InternalAuthUser };
export const InternalAuthSessionResponse = Schema.Struct({ user: InternalAuthUser });
export type WhatsNewReleasesResponse = { readonly releases: ReadonlyArray<WhatsNewResponse> };
export const WhatsNewReleasesResponse = Schema.Struct({ releases: Schema.Array(WhatsNewResponse) });
export type BulkAddParticipantsResponse = { readonly results: ReadonlyArray<BulkAddParticipantsResult> };
export const BulkAddParticipantsResponse = Schema.Struct({ results: Schema.Array(BulkAddParticipantsResult) });
export type PublicShareResponse = { readonly recording: PublicShareRecording; readonly transcript: OpaqueObject | null };
export const PublicShareResponse = Schema.Struct({ recording: PublicShareRecording, transcript: Schema.Union([OpaqueObject, Schema.Null], { mode: "oneOf" }) });
export type DebugSDKIncidentPayload = {
  readonly id: string;
  readonly timestamp?: string;
  readonly severity?: string;
  readonly source: string;
  readonly message: string;
  readonly code?: string;
  readonly roomId?: string;
  readonly participantId?: string;
  readonly traceId?: string;
  readonly phase?: string;
  readonly stage?: string;
  readonly retryable?: boolean;
  readonly details?: { readonly [x: string]: unknown };
  readonly breadcrumbs?: ReadonlyArray<unknown>;
  readonly context?: DebugClientIncidentContext;
};
export const DebugSDKIncidentPayload = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.String),
  source: Schema.String,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  roomId: Schema.optionalKey(Schema.String),
  participantId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  breadcrumbs: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  context: Schema.optionalKey(DebugClientIncidentContext),
});
export type InternalMeetingsResponse = { readonly meetings: OpaqueObjectArray; readonly total: number; readonly limit: number; readonly offset: number };
export const InternalMeetingsResponse = Schema.Struct({ meetings: OpaqueObjectArray, total: Schema.Number.check(Schema.isInt()), limit: Schema.Number.check(Schema.isInt()), offset: Schema.Number.check(Schema.isInt()) });
export type OpsIncidentDetailsResponse = { readonly incident: OpaqueObject; readonly events: OpaqueObjectArray };
export const OpsIncidentDetailsResponse = Schema.Struct({ incident: OpaqueObject, events: OpaqueObjectArray });
export type RoomTranscriptsResponse = { readonly transcripts: OpaqueObjectArray; readonly total: number; readonly limit: number; readonly offset: number };
export const RoomTranscriptsResponse = Schema.Struct({ transcripts: OpaqueObjectArray, total: Schema.Number.check(Schema.isInt()), limit: Schema.Number.check(Schema.isInt()), offset: Schema.Number.check(Schema.isInt()) });
export type AdminOverviewResponse = { readonly overview: OpaqueObject; readonly webhook_stats: OpaqueObject; readonly storage_stats: OpaqueObjectArray };
export const AdminOverviewResponse = Schema.Struct({ overview: OpaqueObject, webhook_stats: OpaqueObject, storage_stats: OpaqueObjectArray });
export type AdminRoomDetailsResponse = { readonly room: OpaqueObject; readonly participants: OpaqueObjectArray };
export const AdminRoomDetailsResponse = Schema.Struct({ room: OpaqueObject, participants: OpaqueObjectArray });
export type AdminUsageResponse = { readonly meeting_durations: OpaqueObject; readonly storage_by_provider: OpaqueObjectArray };
export const AdminUsageResponse = Schema.Struct({ meeting_durations: OpaqueObject, storage_by_provider: OpaqueObjectArray });
export type DebugClientIncidentEnvelope = { readonly incident: DebugSDKIncidentPayload; readonly reportedAt?: string };
export const DebugClientIncidentEnvelope = Schema.Struct({ incident: DebugSDKIncidentPayload, reportedAt: Schema.optionalKey(Schema.String) });
// schemas
export type ApiV1AdminAuditLogsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminAuditLogsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminAuditLogs200 = OpaqueObjectArray;
export const ApiV1AdminAuditLogs200 = OpaqueObjectArray;
export type ApiV1AdminAuditLogs500 = Error;
export const ApiV1AdminAuditLogs500 = Error;
export type ApiV1AdminOpsIncidentsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminOpsIncidentsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminOpsIncidents200 = OpaqueObjectArray;
export const ApiV1AdminOpsIncidents200 = OpaqueObjectArray;
export type ApiV1AdminOpsIncidents500 = Error;
export const ApiV1AdminOpsIncidents500 = Error;
export type ApiV1AdminOpsIncidentsIncidentCode200 = OpaqueObject;
export const ApiV1AdminOpsIncidentsIncidentCode200 = OpaqueObject;
export type ApiV1AdminOpsIncidentsIncidentCode404 = Error;
export const ApiV1AdminOpsIncidentsIncidentCode404 = Error;
export type ApiV1AdminOpsIncidentsIncidentCodeAiDrafts200 = OpaqueObject;
export const ApiV1AdminOpsIncidentsIncidentCodeAiDrafts200 = OpaqueObject;
export type ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400 = Error;
export const ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400 = Error;
export type ApiV1AdminOpsIncidentsIncidentCodeEventsRequestJson = OpsAddIncidentEventRequest;
export const ApiV1AdminOpsIncidentsIncidentCodeEventsRequestJson = OpsAddIncidentEventRequest;
export type ApiV1AdminOpsIncidentsIncidentCodeEvents200 = OpaqueObject;
export const ApiV1AdminOpsIncidentsIncidentCodeEvents200 = OpaqueObject;
export type ApiV1AdminOpsIncidentsIncidentCodeEvents400 = Error;
export const ApiV1AdminOpsIncidentsIncidentCodeEvents400 = Error;
export type ApiV1AdminOpsIncidentsIncidentCodePublishRequestJson = OpsPublishIncidentRequest;
export const ApiV1AdminOpsIncidentsIncidentCodePublishRequestJson = OpsPublishIncidentRequest;
export type ApiV1AdminOpsIncidentsIncidentCodePublish200 = OpaqueObject;
export const ApiV1AdminOpsIncidentsIncidentCodePublish200 = OpaqueObject;
export type ApiV1AdminOpsIncidentsIncidentCodePublish400 = Error;
export const ApiV1AdminOpsIncidentsIncidentCodePublish400 = Error;
export type ApiV1AdminOpsIncidentsIncidentCodeResolveRequestJson = OpsResolveIncidentRequest;
export const ApiV1AdminOpsIncidentsIncidentCodeResolveRequestJson = OpsResolveIncidentRequest;
export type ApiV1AdminOpsIncidentsIncidentCodeResolve200 = OpaqueObject;
export const ApiV1AdminOpsIncidentsIncidentCodeResolve200 = OpaqueObject;
export type ApiV1AdminOpsIncidentsIncidentCodeResolve400 = Error;
export const ApiV1AdminOpsIncidentsIncidentCodeResolve400 = Error;
export type ApiV1AdminOpsIncidentsDeclareRequestJson = OpsDeclareIncidentRequest;
export const ApiV1AdminOpsIncidentsDeclareRequestJson = OpsDeclareIncidentRequest;
export type ApiV1AdminOpsIncidentsDeclare201 = OpaqueObject;
export const ApiV1AdminOpsIncidentsDeclare201 = OpaqueObject;
export type ApiV1AdminOpsIncidentsDeclare400 = Error;
export const ApiV1AdminOpsIncidentsDeclare400 = Error;
export type ApiV1AdminOpsMaintenanceRequestJson = OpsMaintenanceRequest;
export const ApiV1AdminOpsMaintenanceRequestJson = OpsMaintenanceRequest;
export type ApiV1AdminOpsMaintenance201 = OpaqueObject;
export const ApiV1AdminOpsMaintenance201 = OpaqueObject;
export type ApiV1AdminOpsMaintenance400 = Error;
export const ApiV1AdminOpsMaintenance400 = Error;
export type ApiV1AdminOpsMaintenanceIdCancel200 = OpaqueObject;
export const ApiV1AdminOpsMaintenanceIdCancel200 = OpaqueObject;
export type ApiV1AdminOpsMaintenanceIdCancel400 = Error;
export const ApiV1AdminOpsMaintenanceIdCancel400 = Error;
export type ApiV1AdminOpsMaintenanceIdCancel404 = Error;
export const ApiV1AdminOpsMaintenanceIdCancel404 = Error;
export type ApiV1AdminOpsOverview200 = OpaqueObject;
export const ApiV1AdminOpsOverview200 = OpaqueObject;
export type ApiV1AdminOpsOverview500 = Error;
export const ApiV1AdminOpsOverview500 = Error;
export type ApiV1AdminOverview200 = AdminOverviewResponse;
export const ApiV1AdminOverview200 = AdminOverviewResponse;
export type ApiV1AdminOverview500 = Error;
export const ApiV1AdminOverview500 = Error;
export type ApiV1AdminRecordingsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminRecordingsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminRecordings200 = OpaqueObjectArray;
export const ApiV1AdminRecordings200 = OpaqueObjectArray;
export type ApiV1AdminRecordings500 = Error;
export const ApiV1AdminRecordings500 = Error;
export type ApiV1AdminRoomsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminRoomsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminRooms200 = OpaqueObjectArray;
export const ApiV1AdminRooms200 = OpaqueObjectArray;
export type ApiV1AdminRooms500 = Error;
export const ApiV1AdminRooms500 = Error;
export type ApiV1AdminRoomsId200 = AdminRoomDetailsResponse;
export const ApiV1AdminRoomsId200 = AdminRoomDetailsResponse;
export type ApiV1AdminRoomsId400 = Error;
export const ApiV1AdminRoomsId400 = Error;
export type ApiV1AdminRoomsId404 = Error;
export const ApiV1AdminRoomsId404 = Error;
export type ApiV1AdminRoomsId500 = Error;
export const ApiV1AdminRoomsId500 = Error;
export type ApiV1AdminTenantsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminTenantsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminTenants200 = OpaqueObjectArray;
export const ApiV1AdminTenants200 = OpaqueObjectArray;
export type ApiV1AdminTenants500 = Error;
export const ApiV1AdminTenants500 = Error;
export type ApiV1AdminTenantsRequestJson = CreateTenantRequest;
export const ApiV1AdminTenantsRequestJson = CreateTenantRequest;
export type ApiV1AdminTenants201 = CreateTenantResponse;
export const ApiV1AdminTenants201 = CreateTenantResponse;
export type ApiV1AdminTenants400 = Error;
export const ApiV1AdminTenants400 = Error;
export type ApiV1AdminTenants5002 = Error;
export const ApiV1AdminTenants5002 = Error;
export type ApiV1AdminTenantsId200 = Tenant;
export const ApiV1AdminTenantsId200 = Tenant;
export type ApiV1AdminTenantsId400 = Error;
export const ApiV1AdminTenantsId400 = Error;
export type ApiV1AdminTenantsId404 = Error;
export const ApiV1AdminTenantsId404 = Error;
export type ApiV1AdminTenantsId4002 = Error;
export const ApiV1AdminTenantsId4002 = Error;
export type ApiV1AdminTenantsId500 = Error;
export const ApiV1AdminTenantsId500 = Error;
export type ApiV1AdminTenantsIdRequestJson = AdminTenantUpdateRequest;
export const ApiV1AdminTenantsIdRequestJson = AdminTenantUpdateRequest;
export type ApiV1AdminTenantsId2002 = Tenant;
export const ApiV1AdminTenantsId2002 = Tenant;
export type ApiV1AdminTenantsId4003 = Error;
export const ApiV1AdminTenantsId4003 = Error;
export type ApiV1AdminTenantsId5002 = Error;
export const ApiV1AdminTenantsId5002 = Error;
export type ApiV1AdminTenantsIdActivate200 = Tenant;
export const ApiV1AdminTenantsIdActivate200 = Tenant;
export type ApiV1AdminTenantsIdActivate400 = Error;
export const ApiV1AdminTenantsIdActivate400 = Error;
export type ApiV1AdminTenantsIdActivate500 = Error;
export const ApiV1AdminTenantsIdActivate500 = Error;
export type ApiV1AdminTenantsIdConfigRequestJson = { readonly [x: string]: unknown };
export const ApiV1AdminTenantsIdConfigRequestJson = Schema.Record(Schema.String, Schema.Unknown);
export type ApiV1AdminTenantsIdConfig200 = Tenant;
export const ApiV1AdminTenantsIdConfig200 = Tenant;
export type ApiV1AdminTenantsIdConfig400 = Error;
export const ApiV1AdminTenantsIdConfig400 = Error;
export type ApiV1AdminTenantsIdConfig500 = Error;
export const ApiV1AdminTenantsIdConfig500 = Error;
export type ApiV1AdminTenantsIdDeactivate200 = Tenant;
export const ApiV1AdminTenantsIdDeactivate200 = Tenant;
export type ApiV1AdminTenantsIdDeactivate400 = Error;
export const ApiV1AdminTenantsIdDeactivate400 = Error;
export type ApiV1AdminTenantsIdDeactivate500 = Error;
export const ApiV1AdminTenantsIdDeactivate500 = Error;
export type ApiV1AdminTenantsIdRotateKey200 = RotateApiKeyResponse;
export const ApiV1AdminTenantsIdRotateKey200 = RotateApiKeyResponse;
export type ApiV1AdminTenantsIdRotateKey400 = Error;
export const ApiV1AdminTenantsIdRotateKey400 = Error;
export type ApiV1AdminTenantsIdRotateKey500 = Error;
export const ApiV1AdminTenantsIdRotateKey500 = Error;
export type ApiV1AdminTenantsIdWhiteboardConfigRequestJson = { readonly [x: string]: unknown };
export const ApiV1AdminTenantsIdWhiteboardConfigRequestJson = Schema.Record(Schema.String, Schema.Unknown);
export type ApiV1AdminTenantsIdWhiteboardConfig200 = Tenant;
export const ApiV1AdminTenantsIdWhiteboardConfig200 = Tenant;
export type ApiV1AdminTenantsIdWhiteboardConfig400 = Error;
export const ApiV1AdminTenantsIdWhiteboardConfig400 = Error;
export type ApiV1AdminTenantsIdWhiteboardConfig500 = Error;
export const ApiV1AdminTenantsIdWhiteboardConfig500 = Error;
export type ApiV1AdminTranscriptsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminTranscriptsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminTranscripts200 = OpaqueObjectArray;
export const ApiV1AdminTranscripts200 = OpaqueObjectArray;
export type ApiV1AdminTranscripts500 = Error;
export const ApiV1AdminTranscripts500 = Error;
export type ApiV1AdminUsage200 = AdminUsageResponse;
export const ApiV1AdminUsage200 = AdminUsageResponse;
export type ApiV1AdminUsage500 = Error;
export const ApiV1AdminUsage500 = Error;
export type ApiV1AdminWebhooksParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminWebhooksParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminWebhooks200 = OpaqueObjectArray;
export const ApiV1AdminWebhooks200 = OpaqueObjectArray;
export type ApiV1AdminWebhooks500 = Error;
export const ApiV1AdminWebhooks500 = Error;
export type ApiV1AdminWhisperJobsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1AdminWhisperJobsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1AdminWhisperJobs200 = OpaqueObjectArray;
export const ApiV1AdminWhisperJobs200 = OpaqueObjectArray;
export type ApiV1AdminWhisperJobs500 = Error;
export const ApiV1AdminWhisperJobs500 = Error;
export type ApiV1AdminWhisperJobsProcessing200 = OpaqueObjectArray;
export const ApiV1AdminWhisperJobsProcessing200 = OpaqueObjectArray;
export type ApiV1AdminWhisperJobsProcessing500 = Error;
export const ApiV1AdminWhisperJobsProcessing500 = Error;
export type ApiV1AdminWhisperJobsStats200 = AdminWhisperJobStatsResponse;
export const ApiV1AdminWhisperJobsStats200 = AdminWhisperJobStatsResponse;
export type ApiV1AdminWhisperJobsStats500 = Error;
export const ApiV1AdminWhisperJobsStats500 = Error;
export type RefreshTokenRequestJson = RefreshRequest;
export const RefreshTokenRequestJson = RefreshRequest;
export type RefreshToken200 = TokenResponse;
export const RefreshToken200 = TokenResponse;
export type RefreshToken400 = Error;
export const RefreshToken400 = Error;
export type RefreshToken401 = Error;
export const RefreshToken401 = Error;
export type RefreshToken500 = Error;
export const RefreshToken500 = Error;
export type GetTokenRequestJson = TokenRequest;
export const GetTokenRequestJson = TokenRequest;
export type GetToken200 = TokenResponse;
export const GetToken200 = TokenResponse;
export type GetToken400 = Error;
export const GetToken400 = Error;
export type GetToken401 = Error;
export const GetToken401 = Error;
export type GetToken500 = Error;
export const GetToken500 = Error;
export type DebugAuth200 = DebugAuthResponse;
export const DebugAuth200 = DebugAuthResponse;
export type DebugAuth401 = Error;
export const DebugAuth401 = Error;
export type ApiV1DebugClientIncidentRequestJson = DebugClientIncidentRequest | DebugClientIncidentEnvelope;
export const ApiV1DebugClientIncidentRequestJson = Schema.Union([DebugClientIncidentRequest, DebugClientIncidentEnvelope], { mode: "oneOf" });
export type ApiV1DebugClientIncident202 = DebugClientIncidentAcceptedResponse;
export const ApiV1DebugClientIncident202 = DebugClientIncidentAcceptedResponse;
export type ApiV1DebugClientIncident400 = Error;
export const ApiV1DebugClientIncident400 = Error;
export type ApiV1DebugClientIncident401 = Error;
export const ApiV1DebugClientIncident401 = Error;
export type ApiV1DebugClientIncident500 = Error;
export const ApiV1DebugClientIncident500 = Error;
export type ApiV1InternalAuthAccessTokenParams = { readonly "X-Chalk-Local-Client-ID"?: string };
export const ApiV1InternalAuthAccessTokenParams = Schema.Struct({ "X-Chalk-Local-Client-ID": Schema.optionalKey(Schema.String) });
export type ApiV1InternalAuthAccessToken200 = InternalAuthAccessTokenResponse;
export const ApiV1InternalAuthAccessToken200 = InternalAuthAccessTokenResponse;
export type ApiV1InternalAuthAccessToken500 = Error;
export const ApiV1InternalAuthAccessToken500 = Error;
export type ApiV1InternalAuthGoogleRequestJson = InternalAuthGoogleRequest;
export const ApiV1InternalAuthGoogleRequestJson = InternalAuthGoogleRequest;
export type ApiV1InternalAuthGoogle200 = InternalAuthGoogleResponse;
export const ApiV1InternalAuthGoogle200 = InternalAuthGoogleResponse;
export type ApiV1InternalAuthGoogle400 = Error;
export const ApiV1InternalAuthGoogle400 = Error;
export type ApiV1InternalAuthGoogle401 = Error;
export const ApiV1InternalAuthGoogle401 = Error;
export type ApiV1InternalAuthGoogle500 = Error;
export const ApiV1InternalAuthGoogle500 = Error;
export type ApiV1InternalAuthGoogle503 = Error;
export const ApiV1InternalAuthGoogle503 = Error;
export type ApiV1InternalAuthLogout200 = InternalAuthLogoutResponse;
export const ApiV1InternalAuthLogout200 = InternalAuthLogoutResponse;
export type ApiV1InternalAuthSession200 = InternalAuthSessionResponse;
export const ApiV1InternalAuthSession200 = InternalAuthSessionResponse;
export type ApiV1InternalAuthSession401 = Error;
export const ApiV1InternalAuthSession401 = Error;
export type ApiV1InternalMeetingsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1InternalMeetingsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 50 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1InternalMeetings200 = InternalMeetingsResponse;
export const ApiV1InternalMeetings200 = InternalMeetingsResponse;
export type ApiV1InternalMeetings401 = Error;
export const ApiV1InternalMeetings401 = Error;
export type ApiV1InternalMeetings403 = Error;
export const ApiV1InternalMeetings403 = Error;
export type ApiV1InternalMeetings404 = Error;
export const ApiV1InternalMeetings404 = Error;
export type ApiV1InternalMeetings500 = Error;
export const ApiV1InternalMeetings500 = Error;
export type ApiV1OpsIngestHeartbeatsRequestJson = OpsIngestHeartbeatRequest;
export const ApiV1OpsIngestHeartbeatsRequestJson = OpsIngestHeartbeatRequest;
export type ApiV1OpsIngestHeartbeats202 = OpsIngestHeartbeatResponse;
export const ApiV1OpsIngestHeartbeats202 = OpsIngestHeartbeatResponse;
export type ApiV1OpsIngestHeartbeats400 = Error;
export const ApiV1OpsIngestHeartbeats400 = Error;
export type ApiV1OpsIngestHeartbeats401 = Error;
export const ApiV1OpsIngestHeartbeats401 = Error;
export type ApiV1OpsIngestHeartbeats500 = Error;
export const ApiV1OpsIngestHeartbeats500 = Error;
export type ApiV1OpsIngestMonitorResultsRequestJson = OpsIngestMonitorResultRequest;
export const ApiV1OpsIngestMonitorResultsRequestJson = OpsIngestMonitorResultRequest;
export type ApiV1OpsIngestMonitorResults202 = OpsIngestMonitorResultResponse;
export const ApiV1OpsIngestMonitorResults202 = OpsIngestMonitorResultResponse;
export type ApiV1OpsIngestMonitorResults400 = Error;
export const ApiV1OpsIngestMonitorResults400 = Error;
export type ApiV1OpsIngestMonitorResults401 = Error;
export const ApiV1OpsIngestMonitorResults401 = Error;
export type ApiV1OpsIngestMonitorResults500 = Error;
export const ApiV1OpsIngestMonitorResults500 = Error;
export type ExchangeJoinTokenRequestJson = ExchangeJoinTokenRequest;
export const ExchangeJoinTokenRequestJson = ExchangeJoinTokenRequest;
export type ExchangeJoinToken200 = ExchangeJoinTokenResponse;
export const ExchangeJoinToken200 = ExchangeJoinTokenResponse;
export type ExchangeJoinToken400 = Error;
export const ExchangeJoinToken400 = Error;
export type ExchangeJoinToken401 = Error;
export const ExchangeJoinToken401 = Error;
export type ExchangeJoinToken404 = Error;
export const ExchangeJoinToken404 = Error;
export type ExchangeJoinToken500 = Error;
export const ExchangeJoinToken500 = Error;
export type ApiV1PublicShareToken200 = PublicShareResponse;
export const ApiV1PublicShareToken200 = PublicShareResponse;
export type ApiV1PublicShareToken404 = Error;
export const ApiV1PublicShareToken404 = Error;
export type ListRecordingsParams = { readonly limit?: number; readonly offset?: number };
export const ListRecordingsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 20 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ListRecordings200 = ListRecordingsResponse;
export const ListRecordings200 = ListRecordingsResponse;
export type ListRecordings401 = Error;
export const ListRecordings401 = Error;
export type ListRecordings500 = Error;
export const ListRecordings500 = Error;
export type GetRecording200 = RecordingWithRoomInfo;
export const GetRecording200 = RecordingWithRoomInfo;
export type GetRecording400 = Error;
export const GetRecording400 = Error;
export type GetRecording401 = Error;
export const GetRecording401 = Error;
export type GetRecording404 = Error;
export const GetRecording404 = Error;
export type GetRecording500 = Error;
export const GetRecording500 = Error;
export type DeleteRecording200 = DeleteRecordingResponse;
export const DeleteRecording200 = DeleteRecordingResponse;
export type DeleteRecording400 = Error;
export const DeleteRecording400 = Error;
export type DeleteRecording401 = Error;
export const DeleteRecording401 = Error;
export type DeleteRecording404 = Error;
export const DeleteRecording404 = Error;
export type DeleteRecording500 = Error;
export const DeleteRecording500 = Error;
export type ArchiveRecording200 = ArchiveRecordingResponse;
export const ArchiveRecording200 = ArchiveRecordingResponse;
export type ArchiveRecording400 = Error;
export const ArchiveRecording400 = Error;
export type ArchiveRecording401 = Error;
export const ArchiveRecording401 = Error;
export type ArchiveRecording404 = Error;
export const ArchiveRecording404 = Error;
export type ArchiveRecording500 = Error;
export const ArchiveRecording500 = Error;
export type GetRecordingDownloadUrl200 = DownloadRecordingResponse;
export const GetRecordingDownloadUrl200 = DownloadRecordingResponse;
export type GetRecordingDownloadUrl400 = Error;
export const GetRecordingDownloadUrl400 = Error;
export type GetRecordingDownloadUrl401 = Error;
export const GetRecordingDownloadUrl401 = Error;
export type GetRecordingDownloadUrl404 = Error;
export const GetRecordingDownloadUrl404 = Error;
export type GetRecordingDownloadUrl500 = Error;
export const GetRecordingDownloadUrl500 = Error;
export type ApiV1RecordingsIdRecover200 = RecordingRecoverResponse;
export const ApiV1RecordingsIdRecover200 = RecordingRecoverResponse;
export type ApiV1RecordingsIdRecover400 = Error;
export const ApiV1RecordingsIdRecover400 = Error;
export type ApiV1RecordingsIdRecover401 = Error;
export const ApiV1RecordingsIdRecover401 = Error;
export type ApiV1RecordingsIdRecover404 = Error;
export const ApiV1RecordingsIdRecover404 = Error;
export type ApiV1RecordingsIdRecover500 = Error;
export const ApiV1RecordingsIdRecover500 = Error;
export type ApiV1RecordingsIdRecover502 = Error;
export const ApiV1RecordingsIdRecover502 = Error;
export type ApiV1RecordingsIdShare200 = RecordingShareTokenResponse;
export const ApiV1RecordingsIdShare200 = RecordingShareTokenResponse;
export type ApiV1RecordingsIdShare400 = Error;
export const ApiV1RecordingsIdShare400 = Error;
export type ApiV1RecordingsIdShare401 = Error;
export const ApiV1RecordingsIdShare401 = Error;
export type ApiV1RecordingsIdShare404 = Error;
export const ApiV1RecordingsIdShare404 = Error;
export type ApiV1RecordingsIdShare500 = Error;
export const ApiV1RecordingsIdShare500 = Error;
export type ApiV1RecordingsIdTranscribeRequestJson = QueueTranscriptionRequest;
export const ApiV1RecordingsIdTranscribeRequestJson = QueueTranscriptionRequest;
export type ApiV1RecordingsIdTranscribe202 = QueueTranscriptionResponse;
export const ApiV1RecordingsIdTranscribe202 = QueueTranscriptionResponse;
export type ApiV1RecordingsIdTranscribe400 = Error;
export const ApiV1RecordingsIdTranscribe400 = Error;
export type ApiV1RecordingsIdTranscribe401 = Error;
export const ApiV1RecordingsIdTranscribe401 = Error;
export type ApiV1RecordingsIdTranscribe500 = Error;
export const ApiV1RecordingsIdTranscribe500 = Error;
export type ApiV1RecordingsIdTranscript200 = OpaqueObject;
export const ApiV1RecordingsIdTranscript200 = OpaqueObject;
export type ApiV1RecordingsIdTranscript400 = Error;
export const ApiV1RecordingsIdTranscript400 = Error;
export type ApiV1RecordingsIdTranscript404 = Error;
export const ApiV1RecordingsIdTranscript404 = Error;
export type ListRoomsParams = { readonly limit?: number; readonly offset?: number };
export const ListRoomsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 20 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ListRooms200 = ListRoomsResponse;
export const ListRooms200 = ListRoomsResponse;
export type ListRooms401 = Error;
export const ListRooms401 = Error;
export type ListRooms500 = Error;
export const ListRooms500 = Error;
export type CreateRoomRequestJson = CreateRoomRequest;
export const CreateRoomRequestJson = CreateRoomRequest;
export type CreateRoom201 = Room;
export const CreateRoom201 = Room;
export type CreateRoom400 = Error;
export const CreateRoom400 = Error;
export type CreateRoom401 = Error;
export const CreateRoom401 = Error;
export type CreateRoom500 = Error;
export const CreateRoom500 = Error;
export type GetRoom200 = RoomWithParticipantCount;
export const GetRoom200 = RoomWithParticipantCount;
export type GetRoom400 = Error;
export const GetRoom400 = Error;
export type GetRoom401 = Error;
export const GetRoom401 = Error;
export type GetRoom404 = Error;
export const GetRoom404 = Error;
export type DeleteRoom400 = Error;
export const DeleteRoom400 = Error;
export type DeleteRoom401 = Error;
export const DeleteRoom401 = Error;
export type DeleteRoom500 = Error;
export const DeleteRoom500 = Error;
export type UpdateRoomRequestJson = UpdateRoomRequest;
export const UpdateRoomRequestJson = UpdateRoomRequest;
export type UpdateRoom200 = Room;
export const UpdateRoom200 = Room;
export type UpdateRoom400 = Error;
export const UpdateRoom400 = Error;
export type UpdateRoom401 = Error;
export const UpdateRoom401 = Error;
export type UpdateRoom500 = Error;
export const UpdateRoom500 = Error;
export type PresignChatAttachmentDownloadRequestJson = ChatPresignDownloadRequest;
export const PresignChatAttachmentDownloadRequestJson = ChatPresignDownloadRequest;
export type PresignChatAttachmentDownload200 = ChatPresignDownloadResponse;
export const PresignChatAttachmentDownload200 = ChatPresignDownloadResponse;
export type PresignChatAttachmentDownload400 = Error;
export const PresignChatAttachmentDownload400 = Error;
export type PresignChatAttachmentDownload401 = Error;
export const PresignChatAttachmentDownload401 = Error;
export type PresignChatAttachmentDownload403 = Error;
export const PresignChatAttachmentDownload403 = Error;
export type PresignChatAttachmentDownload503 = Error;
export const PresignChatAttachmentDownload503 = Error;
export type PresignChatAttachmentUploadRequestJson = ChatPresignUploadRequest;
export const PresignChatAttachmentUploadRequestJson = ChatPresignUploadRequest;
export type PresignChatAttachmentUpload200 = ChatPresignUploadResponse;
export const PresignChatAttachmentUpload200 = ChatPresignUploadResponse;
export type PresignChatAttachmentUpload400 = Error;
export const PresignChatAttachmentUpload400 = Error;
export type PresignChatAttachmentUpload401 = Error;
export const PresignChatAttachmentUpload401 = Error;
export type PresignChatAttachmentUpload403 = Error;
export const PresignChatAttachmentUpload403 = Error;
export type PresignChatAttachmentUpload503 = Error;
export const PresignChatAttachmentUpload503 = Error;
export type UploadChatAttachmentRequestFormData = { readonly attachment_id: string; readonly file: string };
export const UploadChatAttachmentRequestFormData = Schema.Struct({ attachment_id: Schema.String.annotate({ description: "Pending attachment identifier", format: "uuid" }), file: Schema.String.annotate({ description: "Attachment file content", format: "binary" }) });
export type UploadChatAttachment400 = Error;
export const UploadChatAttachment400 = Error;
export type UploadChatAttachment401 = Error;
export const UploadChatAttachment401 = Error;
export type UploadChatAttachment403 = Error;
export const UploadChatAttachment403 = Error;
export type UploadChatAttachment503 = Error;
export const UploadChatAttachment503 = Error;
export type EndRoom200 = Room;
export const EndRoom200 = Room;
export type EndRoom400 = Error;
export const EndRoom400 = Error;
export type EndRoom401 = Error;
export const EndRoom401 = Error;
export type EndRoom500 = Error;
export const EndRoom500 = Error;
export type CreateJoinToken200 = CreateJoinTokenResponse;
export const CreateJoinToken200 = CreateJoinTokenResponse;
export type CreateJoinToken401 = Error;
export const CreateJoinToken401 = Error;
export type CreateJoinToken404 = Error;
export const CreateJoinToken404 = Error;
export type CreateJoinToken500 = Error;
export const CreateJoinToken500 = Error;
export type ListParticipantsParams = { readonly active?: "true" | "false" };
export const ListParticipantsParams = Schema.Struct({ active: Schema.optionalKey(Schema.Literals(["true", "false"])) });
export type ListParticipants200 = ListParticipantsResponse;
export const ListParticipants200 = ListParticipantsResponse;
export type ListParticipants400 = Error;
export const ListParticipants400 = Error;
export type ListParticipants401 = Error;
export const ListParticipants401 = Error;
export type ListParticipants500 = Error;
export const ListParticipants500 = Error;
export type AddParticipantRequestJson = AddParticipantRequest;
export const AddParticipantRequestJson = AddParticipantRequest;
export type AddParticipant201 = AddParticipantResponse;
export const AddParticipant201 = AddParticipantResponse;
export type AddParticipant400 = Error;
export const AddParticipant400 = Error;
export type AddParticipant401 = Error;
export const AddParticipant401 = Error;
export type AddParticipant500 = Error;
export const AddParticipant500 = Error;
export type RemoveParticipant200 = Participant;
export const RemoveParticipant200 = Participant;
export type RemoveParticipant400 = Error;
export const RemoveParticipant400 = Error;
export type RemoveParticipant401 = Error;
export const RemoveParticipant401 = Error;
export type RemoveParticipant404 = Error;
export const RemoveParticipant404 = Error;
export type RemoveParticipant500 = Error;
export const RemoveParticipant500 = Error;
export type UpdateParticipantRequestJson = UpdateParticipantRequest;
export const UpdateParticipantRequestJson = UpdateParticipantRequest;
export type UpdateParticipant200 = Participant;
export const UpdateParticipant200 = Participant;
export type UpdateParticipant400 = Error;
export const UpdateParticipant400 = Error;
export type UpdateParticipant401 = Error;
export const UpdateParticipant401 = Error;
export type UpdateParticipant403 = Error;
export const UpdateParticipant403 = Error;
export type UpdateParticipant404 = Error;
export const UpdateParticipant404 = Error;
export type UpdateParticipant500 = Error;
export const UpdateParticipant500 = Error;
export type RefreshParticipantToken200 = RefreshParticipantTokenResponse;
export const RefreshParticipantToken200 = RefreshParticipantTokenResponse;
export type RefreshParticipantToken400 = Error;
export const RefreshParticipantToken400 = Error;
export type RefreshParticipantToken401 = Error;
export const RefreshParticipantToken401 = Error;
export type RefreshParticipantToken404 = Error;
export const RefreshParticipantToken404 = Error;
export type RefreshParticipantToken500 = Error;
export const RefreshParticipantToken500 = Error;
export type ApiV1RoomsIdParticipantsBulkRequestJson = BulkAddParticipantsRequest;
export const ApiV1RoomsIdParticipantsBulkRequestJson = BulkAddParticipantsRequest;
export type ApiV1RoomsIdParticipantsBulk200 = BulkAddParticipantsResponse;
export const ApiV1RoomsIdParticipantsBulk200 = BulkAddParticipantsResponse;
export type ApiV1RoomsIdParticipantsBulk400 = Error;
export const ApiV1RoomsIdParticipantsBulk400 = Error;
export type ApiV1RoomsIdParticipantsBulk401 = Error;
export const ApiV1RoomsIdParticipantsBulk401 = Error;
export type ApiV1RoomsIdParticipantsBulk404 = Error;
export const ApiV1RoomsIdParticipantsBulk404 = Error;
export type ArchiveRoomRecording200 = ArchiveRecordingResponse;
export const ArchiveRoomRecording200 = ArchiveRecordingResponse;
export type ArchiveRoomRecording400 = Error;
export const ArchiveRoomRecording400 = Error;
export type ArchiveRoomRecording401 = Error;
export const ArchiveRoomRecording401 = Error;
export type ArchiveRoomRecording404 = Error;
export const ArchiveRoomRecording404 = Error;
export type ArchiveRoomRecording500 = Error;
export const ArchiveRoomRecording500 = Error;
export type StartRecording201 = Recording;
export const StartRecording201 = Recording;
export type StartRecording400 = Error;
export const StartRecording400 = Error;
export type StartRecording401 = Error;
export const StartRecording401 = Error;
export type StartRecording404 = Error;
export const StartRecording404 = Error;
export type StartRecording409 = Error;
export const StartRecording409 = Error;
export type StartRecording500 = Error;
export const StartRecording500 = Error;
export type StopRecording200 = Recording;
export const StopRecording200 = Recording;
export type StopRecording400 = Error;
export const StopRecording400 = Error;
export type StopRecording401 = Error;
export const StopRecording401 = Error;
export type StopRecording404 = Error;
export const StopRecording404 = Error;
export type StopRecording500 = Error;
export const StopRecording500 = Error;
export type ApiV1RoomsIdRecordingsSync200 = RecordingSyncResponse;
export const ApiV1RoomsIdRecordingsSync200 = RecordingSyncResponse;
export type ApiV1RoomsIdRecordingsSync400 = Error;
export const ApiV1RoomsIdRecordingsSync400 = Error;
export type ApiV1RoomsIdRecordingsSync401 = Error;
export const ApiV1RoomsIdRecordingsSync401 = Error;
export type ApiV1RoomsIdRecordingsSync404 = Error;
export const ApiV1RoomsIdRecordingsSync404 = Error;
export type ApiV1RoomsIdRecordingsSync500 = Error;
export const ApiV1RoomsIdRecordingsSync500 = Error;
export type ApiV1RoomsIdTranscriptsParams = { readonly limit?: number; readonly offset?: number };
export const ApiV1RoomsIdTranscriptsParams = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number.annotate({ default: 100 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1000))),
  offset: Schema.optionalKey(Schema.Number.annotate({ default: 0 }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ApiV1RoomsIdTranscripts200 = RoomTranscriptsResponse;
export const ApiV1RoomsIdTranscripts200 = RoomTranscriptsResponse;
export type ApiV1RoomsIdTranscripts400 = Error;
export const ApiV1RoomsIdTranscripts400 = Error;
export type ApiV1RoomsIdTranscripts401 = Error;
export const ApiV1RoomsIdTranscripts401 = Error;
export type ApiV1RoomsIdTranscripts404 = Error;
export const ApiV1RoomsIdTranscripts404 = Error;
export type ApiV1RoomsIdTranscripts500 = Error;
export const ApiV1RoomsIdTranscripts500 = Error;
export type PresignWhiteboardDownloadRequestJson = WhiteboardPresignDownloadRequest;
export const PresignWhiteboardDownloadRequestJson = WhiteboardPresignDownloadRequest;
export type PresignWhiteboardDownload200 = WhiteboardPresignDownloadResponse;
export const PresignWhiteboardDownload200 = WhiteboardPresignDownloadResponse;
export type PresignWhiteboardDownload400 = Error;
export const PresignWhiteboardDownload400 = Error;
export type PresignWhiteboardDownload401 = Error;
export const PresignWhiteboardDownload401 = Error;
export type PresignWhiteboardDownload403 = Error;
export const PresignWhiteboardDownload403 = Error;
export type PresignWhiteboardDownload500 = Error;
export const PresignWhiteboardDownload500 = Error;
export type PresignWhiteboardUploadRequestJson = WhiteboardPresignUploadRequest;
export const PresignWhiteboardUploadRequestJson = WhiteboardPresignUploadRequest;
export type PresignWhiteboardUpload200 = WhiteboardPresignUploadResponse;
export const PresignWhiteboardUpload200 = WhiteboardPresignUploadResponse;
export type PresignWhiteboardUpload400 = Error;
export const PresignWhiteboardUpload400 = Error;
export type PresignWhiteboardUpload401 = Error;
export const PresignWhiteboardUpload401 = Error;
export type PresignWhiteboardUpload403 = Error;
export const PresignWhiteboardUpload403 = Error;
export type PresignWhiteboardUpload500 = Error;
export const PresignWhiteboardUpload500 = Error;
export type ScheduleRoomRequestJson = ScheduleRoomRequest;
export const ScheduleRoomRequestJson = ScheduleRoomRequest;
export type ScheduleRoom201 = Room;
export const ScheduleRoom201 = Room;
export type ScheduleRoom400 = Error;
export const ScheduleRoom400 = Error;
export type ScheduleRoom401 = Error;
export const ScheduleRoom401 = Error;
export type ScheduleRoom500 = Error;
export const ScheduleRoom500 = Error;
export type ApiV1Status200 = OpsStatusSummaryResponse;
export const ApiV1Status200 = OpsStatusSummaryResponse;
export type ApiV1Status500 = Error;
export const ApiV1Status500 = Error;
export type ApiV1StatusIncidentsIncidentCode200 = OpsIncidentDetailsResponse;
export const ApiV1StatusIncidentsIncidentCode200 = OpsIncidentDetailsResponse;
export type ApiV1StatusIncidentsIncidentCode404 = Error;
export const ApiV1StatusIncidentsIncidentCode404 = Error;
export type CreateTenantRequestJson = CreateTenantRequest;
export const CreateTenantRequestJson = CreateTenantRequest;
export type CreateTenant201 = CreateTenantResponse;
export const CreateTenant201 = CreateTenantResponse;
export type CreateTenant400 = Error;
export const CreateTenant400 = Error;
export type CreateTenant500 = Error;
export const CreateTenant500 = Error;
export type GetTenant200 = Tenant;
export const GetTenant200 = Tenant;
export type GetTenant400 = Error;
export const GetTenant400 = Error;
export type GetTenant401 = Error;
export const GetTenant401 = Error;
export type GetTenant404 = Error;
export const GetTenant404 = Error;
export type DeleteTenant400 = Error;
export const DeleteTenant400 = Error;
export type DeleteTenant401 = Error;
export const DeleteTenant401 = Error;
export type DeleteTenant500 = Error;
export const DeleteTenant500 = Error;
export type UpdateTenantRequestJson = UpdateTenantRequest;
export const UpdateTenantRequestJson = UpdateTenantRequest;
export type UpdateTenant200 = Tenant;
export const UpdateTenant200 = Tenant;
export type UpdateTenant400 = Error;
export const UpdateTenant400 = Error;
export type UpdateTenant401 = Error;
export const UpdateTenant401 = Error;
export type UpdateTenant500 = Error;
export const UpdateTenant500 = Error;
export type ApiV1TenantsIdConfigRequestJson = TenantConfigUpdateRequest;
export const ApiV1TenantsIdConfigRequestJson = TenantConfigUpdateRequest;
export type ApiV1TenantsIdConfig200 = Tenant;
export const ApiV1TenantsIdConfig200 = Tenant;
export type ApiV1TenantsIdConfig400 = Error;
export const ApiV1TenantsIdConfig400 = Error;
export type ApiV1TenantsIdConfig403 = Error;
export const ApiV1TenantsIdConfig403 = Error;
export type ApiV1TenantsIdConfig404 = Error;
export const ApiV1TenantsIdConfig404 = Error;
export type ApiV1TenantsIdConfig500 = Error;
export const ApiV1TenantsIdConfig500 = Error;
export type RotateTenantApiKey200 = RotateApiKeyResponse;
export const RotateTenantApiKey200 = RotateApiKeyResponse;
export type RotateTenantApiKey400 = Error;
export const RotateTenantApiKey400 = Error;
export type RotateTenantApiKey401 = Error;
export const RotateTenantApiKey401 = Error;
export type RotateTenantApiKey500 = Error;
export const RotateTenantApiKey500 = Error;
export type ApiV1TranscriptionId200 = OpaqueObject;
export const ApiV1TranscriptionId200 = OpaqueObject;
export type ApiV1TranscriptionId400 = Error;
export const ApiV1TranscriptionId400 = Error;
export type ApiV1TranscriptionId401 = Error;
export const ApiV1TranscriptionId401 = Error;
export type ApiV1TranscriptionId404 = Error;
export const ApiV1TranscriptionId404 = Error;
export type ApiV1TranscriptionProviders200 = TranscriptionProvidersResponse;
export const ApiV1TranscriptionProviders200 = TranscriptionProvidersResponse;
export type ApiV1TranscriptionProvidersCloudflareCallbackRequestJson = OpaqueObject;
export const ApiV1TranscriptionProvidersCloudflareCallbackRequestJson = OpaqueObject;
export type ApiV1TranscriptionProvidersCloudflareCallback200 = TranscriptionCallbackResponse;
export const ApiV1TranscriptionProvidersCloudflareCallback200 = TranscriptionCallbackResponse;
export type ApiV1TranscriptionProvidersCloudflareCallback400 = Error;
export const ApiV1TranscriptionProvidersCloudflareCallback400 = Error;
export type ApiV1TranscriptionProvidersCloudflareCallback401 = Error;
export const ApiV1TranscriptionProvidersCloudflareCallback401 = Error;
export type ApiV1TranscriptionProvidersCloudflareCallback503 = Error;
export const ApiV1TranscriptionProvidersCloudflareCallback503 = Error;
export type HandleRecordingReadyWebhookRequestJson = RecordingReadyWebhook;
export const HandleRecordingReadyWebhookRequestJson = RecordingReadyWebhook;
export type HandleRecordingReadyWebhook200 = WebhookRecordingResponse;
export const HandleRecordingReadyWebhook200 = WebhookRecordingResponse;
export type HandleRecordingReadyWebhook400 = Error;
export const HandleRecordingReadyWebhook400 = Error;
export type HandleRecordingReadyWebhook404 = Error;
export const HandleRecordingReadyWebhook404 = Error;
export type HandleRecordingReadyWebhook500 = Error;
export const HandleRecordingReadyWebhook500 = Error;
export type HandleLocalPostMeetingWebhookRequestJson = PostMeetingWebhookPayload;
export const HandleLocalPostMeetingWebhookRequestJson = PostMeetingWebhookPayload;
export type HandleLocalPostMeetingWebhook200 = WebhookAckResponse;
export const HandleLocalPostMeetingWebhook200 = WebhookAckResponse;
export type HandleLocalPostMeetingWebhook400 = Error;
export const HandleLocalPostMeetingWebhook400 = Error;
export type HandleLocalPostMeetingWebhook401 = Error;
export const HandleLocalPostMeetingWebhook401 = Error;
export type HandleLocalPostMeetingWebhook404 = Error;
export const HandleLocalPostMeetingWebhook404 = Error;
export type HandleLocalPostMeetingWebhook500 = Error;
export const HandleLocalPostMeetingWebhook500 = Error;
export type ApiV1WhatsNew200 = WhatsNewResponse;
export const ApiV1WhatsNew200 = WhatsNewResponse;
export type ApiV1WhatsNew404 = Error;
export const ApiV1WhatsNew404 = Error;
export type ApiV1WhatsNew502 = Error;
export const ApiV1WhatsNew502 = Error;
export type ApiV1WhatsNewReleases200 = WhatsNewReleasesResponse;
export const ApiV1WhatsNewReleases200 = WhatsNewReleasesResponse;
export type ApiV1WhatsNewReleases404 = Error;
export const ApiV1WhatsNewReleases404 = Error;
export type ApiV1WhatsNewReleases502 = Error;
export const ApiV1WhatsNewReleases502 = Error;
export type HealthCheck200 = { readonly status?: string; readonly database?: string; readonly uptime?: number };
export const HealthCheck200 = Schema.Struct({
  status: Schema.optionalKey(Schema.String.annotate({ examples: ["healthy"] })),
  database: Schema.optionalKey(Schema.String.annotate({ examples: ["connected"] })),
  uptime: Schema.optionalKey(Schema.Number.annotate({ description: "Server uptime in seconds", examples: [3600.5], format: "double" }).check(Schema.isFinite())),
});
export type WsParams = { readonly token?: string; readonly room?: string };
export const WsParams = Schema.Struct({ token: Schema.optionalKey(Schema.String), room: Schema.optionalKey(Schema.String) });
export type Ws400 = Error;
export const Ws400 = Error;
export type Ws401 = Error;
export const Ws401 = Error;
export type Ws403 = Error;
export const Ws403 = Error;

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined;
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true;
}
  ? [A, HttpClientResponse.HttpClientResponse]
  : A;

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined;
  } = {},
): ChalkApi => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    );
  const withResponse =
    <Config extends OperationConfig>(config: Config | undefined) =>
    (f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>): ((request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any>) => {
      const withOptionalResponse = (config?.includeResponse ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response]) : (response: HttpClientResponse.HttpClientResponse) => f(response)) as any;
      return options?.transformClient
        ? (request) =>
            Effect.flatMap(
              Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
              withOptionalResponse,
            )
        : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse);
    };
  const decodeSuccess =
    <Schema extends Schema.Top>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response);
  const decodeError =
    <const Tag extends string, Schema extends Schema.Top>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)(response), (cause) => Effect.fail(ChalkApiError(tag, cause, response)));
  return {
    httpClient,
    "GET/api/v1/admin/audit-logs": (options) =>
      HttpClientRequest.get(`/api/v1/admin/audit-logs`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminAuditLogs200),
            "500": decodeError("ApiV1AdminAuditLogs500", ApiV1AdminAuditLogs500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/ops/incidents": (options) =>
      HttpClientRequest.get(`/api/v1/admin/ops/incidents`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidents200),
            "500": decodeError("ApiV1AdminOpsIncidents500", ApiV1AdminOpsIncidents500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/ops/incidents/{incidentCode}": (incidentCode, options) =>
      HttpClientRequest.get(`/api/v1/admin/ops/incidents/${incidentCode}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsIncidentCode200),
            "404": decodeError("ApiV1AdminOpsIncidentsIncidentCode404", ApiV1AdminOpsIncidentsIncidentCode404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/incidents/{incidentCode}/ai-drafts": (incidentCode, options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/incidents/${incidentCode}/ai-drafts`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsIncidentCodeAiDrafts200),
            "400": decodeError("ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400", ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/incidents/{incidentCode}/events": (incidentCode, options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/incidents/${incidentCode}/events`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsIncidentCodeEvents200),
            "400": decodeError("ApiV1AdminOpsIncidentsIncidentCodeEvents400", ApiV1AdminOpsIncidentsIncidentCodeEvents400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/incidents/{incidentCode}/publish": (incidentCode, options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/incidents/${incidentCode}/publish`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsIncidentCodePublish200),
            "400": decodeError("ApiV1AdminOpsIncidentsIncidentCodePublish400", ApiV1AdminOpsIncidentsIncidentCodePublish400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/incidents/{incidentCode}/resolve": (incidentCode, options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/incidents/${incidentCode}/resolve`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsIncidentCodeResolve200),
            "400": decodeError("ApiV1AdminOpsIncidentsIncidentCodeResolve400", ApiV1AdminOpsIncidentsIncidentCodeResolve400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/incidents/declare": (options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/incidents/declare`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsIncidentsDeclare201),
            "400": decodeError("ApiV1AdminOpsIncidentsDeclare400", ApiV1AdminOpsIncidentsDeclare400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/maintenance": (options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/maintenance`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsMaintenance201),
            "400": decodeError("ApiV1AdminOpsMaintenance400", ApiV1AdminOpsMaintenance400),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/ops/maintenance/{id}/cancel": (id, options) =>
      HttpClientRequest.post(`/api/v1/admin/ops/maintenance/${id}/cancel`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsMaintenanceIdCancel200),
            "400": decodeError("ApiV1AdminOpsMaintenanceIdCancel400", ApiV1AdminOpsMaintenanceIdCancel400),
            "404": decodeError("ApiV1AdminOpsMaintenanceIdCancel404", ApiV1AdminOpsMaintenanceIdCancel404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/ops/overview": (options) =>
      HttpClientRequest.get(`/api/v1/admin/ops/overview`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOpsOverview200),
            "500": decodeError("ApiV1AdminOpsOverview500", ApiV1AdminOpsOverview500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/overview": (options) =>
      HttpClientRequest.get(`/api/v1/admin/overview`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminOverview200),
            "500": decodeError("ApiV1AdminOverview500", ApiV1AdminOverview500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/recordings": (options) =>
      HttpClientRequest.get(`/api/v1/admin/recordings`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminRecordings200),
            "500": decodeError("ApiV1AdminRecordings500", ApiV1AdminRecordings500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/rooms": (options) =>
      HttpClientRequest.get(`/api/v1/admin/rooms`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminRooms200),
            "500": decodeError("ApiV1AdminRooms500", ApiV1AdminRooms500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/rooms/{id}": (id, options) =>
      HttpClientRequest.get(`/api/v1/admin/rooms/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminRoomsId200),
            "400": decodeError("ApiV1AdminRoomsId400", ApiV1AdminRoomsId400),
            "404": decodeError("ApiV1AdminRoomsId404", ApiV1AdminRoomsId404),
            "500": decodeError("ApiV1AdminRoomsId500", ApiV1AdminRoomsId500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/tenants": (options) =>
      HttpClientRequest.get(`/api/v1/admin/tenants`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenants200),
            "500": decodeError("ApiV1AdminTenants500", ApiV1AdminTenants500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/tenants": (options) =>
      HttpClientRequest.post(`/api/v1/admin/tenants`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenants201),
            "400": decodeError("ApiV1AdminTenants400", ApiV1AdminTenants400),
            "500": decodeError("ApiV1AdminTenants5002", ApiV1AdminTenants5002),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/tenants/{id}": (id, options) =>
      HttpClientRequest.get(`/api/v1/admin/tenants/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsId200),
            "400": decodeError("ApiV1AdminTenantsId400", ApiV1AdminTenantsId400),
            "404": decodeError("ApiV1AdminTenantsId404", ApiV1AdminTenantsId404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "DELETE/api/v1/admin/tenants/{id}": (id, options) =>
      HttpClientRequest.delete(`/api/v1/admin/tenants/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "400": decodeError("ApiV1AdminTenantsId4002", ApiV1AdminTenantsId4002),
            "500": decodeError("ApiV1AdminTenantsId500", ApiV1AdminTenantsId500),
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/admin/tenants/{id}": (id, options) =>
      HttpClientRequest.patch(`/api/v1/admin/tenants/${id}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsId2002),
            "400": decodeError("ApiV1AdminTenantsId4003", ApiV1AdminTenantsId4003),
            "500": decodeError("ApiV1AdminTenantsId5002", ApiV1AdminTenantsId5002),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/admin/tenants/{id}/activate": (id, options) =>
      HttpClientRequest.patch(`/api/v1/admin/tenants/${id}/activate`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsIdActivate200),
            "400": decodeError("ApiV1AdminTenantsIdActivate400", ApiV1AdminTenantsIdActivate400),
            "500": decodeError("ApiV1AdminTenantsIdActivate500", ApiV1AdminTenantsIdActivate500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/admin/tenants/{id}/config": (id, options) =>
      HttpClientRequest.patch(`/api/v1/admin/tenants/${id}/config`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsIdConfig200),
            "400": decodeError("ApiV1AdminTenantsIdConfig400", ApiV1AdminTenantsIdConfig400),
            "500": decodeError("ApiV1AdminTenantsIdConfig500", ApiV1AdminTenantsIdConfig500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/admin/tenants/{id}/deactivate": (id, options) =>
      HttpClientRequest.patch(`/api/v1/admin/tenants/${id}/deactivate`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsIdDeactivate200),
            "400": decodeError("ApiV1AdminTenantsIdDeactivate400", ApiV1AdminTenantsIdDeactivate400),
            "500": decodeError("ApiV1AdminTenantsIdDeactivate500", ApiV1AdminTenantsIdDeactivate500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/admin/tenants/{id}/rotate-key": (id, options) =>
      HttpClientRequest.post(`/api/v1/admin/tenants/${id}/rotate-key`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsIdRotateKey200),
            "400": decodeError("ApiV1AdminTenantsIdRotateKey400", ApiV1AdminTenantsIdRotateKey400),
            "500": decodeError("ApiV1AdminTenantsIdRotateKey500", ApiV1AdminTenantsIdRotateKey500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/admin/tenants/{id}/whiteboard-config": (id, options) =>
      HttpClientRequest.patch(`/api/v1/admin/tenants/${id}/whiteboard-config`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTenantsIdWhiteboardConfig200),
            "400": decodeError("ApiV1AdminTenantsIdWhiteboardConfig400", ApiV1AdminTenantsIdWhiteboardConfig400),
            "500": decodeError("ApiV1AdminTenantsIdWhiteboardConfig500", ApiV1AdminTenantsIdWhiteboardConfig500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/transcripts": (options) =>
      HttpClientRequest.get(`/api/v1/admin/transcripts`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminTranscripts200),
            "500": decodeError("ApiV1AdminTranscripts500", ApiV1AdminTranscripts500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/usage": (options) =>
      HttpClientRequest.get(`/api/v1/admin/usage`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminUsage200),
            "500": decodeError("ApiV1AdminUsage500", ApiV1AdminUsage500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/webhooks": (options) =>
      HttpClientRequest.get(`/api/v1/admin/webhooks`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminWebhooks200),
            "500": decodeError("ApiV1AdminWebhooks500", ApiV1AdminWebhooks500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/whisper-jobs": (options) =>
      HttpClientRequest.get(`/api/v1/admin/whisper-jobs`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminWhisperJobs200),
            "500": decodeError("ApiV1AdminWhisperJobs500", ApiV1AdminWhisperJobs500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/whisper-jobs/processing": (options) =>
      HttpClientRequest.get(`/api/v1/admin/whisper-jobs/processing`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminWhisperJobsProcessing200),
            "500": decodeError("ApiV1AdminWhisperJobsProcessing500", ApiV1AdminWhisperJobsProcessing500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/admin/whisper-jobs/stats": (options) =>
      HttpClientRequest.get(`/api/v1/admin/whisper-jobs/stats`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1AdminWhisperJobsStats200),
            "500": decodeError("ApiV1AdminWhisperJobsStats500", ApiV1AdminWhisperJobsStats500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    refreshToken: (options) =>
      HttpClientRequest.post(`/api/v1/auth/refresh`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(RefreshToken200),
            "400": decodeError("RefreshToken400", RefreshToken400),
            "401": decodeError("RefreshToken401", RefreshToken401),
            "500": decodeError("RefreshToken500", RefreshToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getToken: (options) =>
      HttpClientRequest.post(`/api/v1/auth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(GetToken200),
            "400": decodeError("GetToken400", GetToken400),
            "401": decodeError("GetToken401", GetToken401),
            "500": decodeError("GetToken500", GetToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    debugAuth: (options) =>
      HttpClientRequest.get(`/api/v1/debug/auth`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(DebugAuth200),
            "401": decodeError("DebugAuth401", DebugAuth401),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/debug/client-incident": (options) =>
      HttpClientRequest.post(`/api/v1/debug/client-incident`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1DebugClientIncident202),
            "400": decodeError("ApiV1DebugClientIncident400", ApiV1DebugClientIncident400),
            "401": decodeError("ApiV1DebugClientIncident401", ApiV1DebugClientIncident401),
            "500": decodeError("ApiV1DebugClientIncident500", ApiV1DebugClientIncident500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    debugPing: (options) =>
      HttpClientRequest.head(`/api/v1/debug/ping`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/internal/auth/access-token": (options) =>
      HttpClientRequest.get(`/api/v1/internal/auth/access-token`).pipe(
        HttpClientRequest.setHeaders({ "X-Chalk-Local-Client-ID": options?.params?.["X-Chalk-Local-Client-ID"] ?? undefined }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1InternalAuthAccessToken200),
            "500": decodeError("ApiV1InternalAuthAccessToken500", ApiV1InternalAuthAccessToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/internal/auth/google": (options) =>
      HttpClientRequest.post(`/api/v1/internal/auth/google`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1InternalAuthGoogle200),
            "400": decodeError("ApiV1InternalAuthGoogle400", ApiV1InternalAuthGoogle400),
            "401": decodeError("ApiV1InternalAuthGoogle401", ApiV1InternalAuthGoogle401),
            "500": decodeError("ApiV1InternalAuthGoogle500", ApiV1InternalAuthGoogle500),
            "503": decodeError("ApiV1InternalAuthGoogle503", ApiV1InternalAuthGoogle503),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/internal/auth/logout": (options) =>
      HttpClientRequest.post(`/api/v1/internal/auth/logout`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1InternalAuthLogout200),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/internal/auth/session": (options) =>
      HttpClientRequest.get(`/api/v1/internal/auth/session`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1InternalAuthSession200),
            "401": decodeError("ApiV1InternalAuthSession401", ApiV1InternalAuthSession401),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/internal/meetings": (options) =>
      HttpClientRequest.get(`/api/v1/internal/meetings`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1InternalMeetings200),
            "401": decodeError("ApiV1InternalMeetings401", ApiV1InternalMeetings401),
            "403": decodeError("ApiV1InternalMeetings403", ApiV1InternalMeetings403),
            "404": decodeError("ApiV1InternalMeetings404", ApiV1InternalMeetings404),
            "500": decodeError("ApiV1InternalMeetings500", ApiV1InternalMeetings500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/ops/ingest/heartbeats": (options) =>
      HttpClientRequest.post(`/api/v1/ops/ingest/heartbeats`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1OpsIngestHeartbeats202),
            "400": decodeError("ApiV1OpsIngestHeartbeats400", ApiV1OpsIngestHeartbeats400),
            "401": decodeError("ApiV1OpsIngestHeartbeats401", ApiV1OpsIngestHeartbeats401),
            "500": decodeError("ApiV1OpsIngestHeartbeats500", ApiV1OpsIngestHeartbeats500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/ops/ingest/monitor-results": (options) =>
      HttpClientRequest.post(`/api/v1/ops/ingest/monitor-results`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1OpsIngestMonitorResults202),
            "400": decodeError("ApiV1OpsIngestMonitorResults400", ApiV1OpsIngestMonitorResults400),
            "401": decodeError("ApiV1OpsIngestMonitorResults401", ApiV1OpsIngestMonitorResults401),
            "500": decodeError("ApiV1OpsIngestMonitorResults500", ApiV1OpsIngestMonitorResults500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    exchangeJoinToken: (options) =>
      HttpClientRequest.post(`/api/v1/public/join-token/exchange`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ExchangeJoinToken200),
            "400": decodeError("ExchangeJoinToken400", ExchangeJoinToken400),
            "401": decodeError("ExchangeJoinToken401", ExchangeJoinToken401),
            "404": decodeError("ExchangeJoinToken404", ExchangeJoinToken404),
            "500": decodeError("ExchangeJoinToken500", ExchangeJoinToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/public/share/{token}": (token, options) =>
      HttpClientRequest.get(`/api/v1/public/share/${token}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1PublicShareToken200),
            "404": decodeError("ApiV1PublicShareToken404", ApiV1PublicShareToken404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    listRecordings: (options) =>
      HttpClientRequest.get(`/api/v1/recordings`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ListRecordings200),
            "401": decodeError("ListRecordings401", ListRecordings401),
            "500": decodeError("ListRecordings500", ListRecordings500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getRecording: (id, options) =>
      HttpClientRequest.get(`/api/v1/recordings/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(GetRecording200),
            "400": decodeError("GetRecording400", GetRecording400),
            "401": decodeError("GetRecording401", GetRecording401),
            "404": decodeError("GetRecording404", GetRecording404),
            "500": decodeError("GetRecording500", GetRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    deleteRecording: (id, options) =>
      HttpClientRequest.delete(`/api/v1/recordings/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(DeleteRecording200),
            "400": decodeError("DeleteRecording400", DeleteRecording400),
            "401": decodeError("DeleteRecording401", DeleteRecording401),
            "404": decodeError("DeleteRecording404", DeleteRecording404),
            "500": decodeError("DeleteRecording500", DeleteRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    archiveRecording: (id, options) =>
      HttpClientRequest.post(`/api/v1/recordings/${id}/archive`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ArchiveRecording200),
            "400": decodeError("ArchiveRecording400", ArchiveRecording400),
            "401": decodeError("ArchiveRecording401", ArchiveRecording401),
            "404": decodeError("ArchiveRecording404", ArchiveRecording404),
            "500": decodeError("ArchiveRecording500", ArchiveRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getRecordingDownloadUrl: (id, options) =>
      HttpClientRequest.get(`/api/v1/recordings/${id}/download`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(GetRecordingDownloadUrl200),
            "400": decodeError("GetRecordingDownloadUrl400", GetRecordingDownloadUrl400),
            "401": decodeError("GetRecordingDownloadUrl401", GetRecordingDownloadUrl401),
            "404": decodeError("GetRecordingDownloadUrl404", GetRecordingDownloadUrl404),
            "500": decodeError("GetRecordingDownloadUrl500", GetRecordingDownloadUrl500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/recordings/{id}/recover": (id, options) =>
      HttpClientRequest.post(`/api/v1/recordings/${id}/recover`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RecordingsIdRecover200),
            "400": decodeError("ApiV1RecordingsIdRecover400", ApiV1RecordingsIdRecover400),
            "401": decodeError("ApiV1RecordingsIdRecover401", ApiV1RecordingsIdRecover401),
            "404": decodeError("ApiV1RecordingsIdRecover404", ApiV1RecordingsIdRecover404),
            "500": decodeError("ApiV1RecordingsIdRecover500", ApiV1RecordingsIdRecover500),
            "502": decodeError("ApiV1RecordingsIdRecover502", ApiV1RecordingsIdRecover502),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/recordings/{id}/share": (id, options) =>
      HttpClientRequest.post(`/api/v1/recordings/${id}/share`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RecordingsIdShare200),
            "400": decodeError("ApiV1RecordingsIdShare400", ApiV1RecordingsIdShare400),
            "401": decodeError("ApiV1RecordingsIdShare401", ApiV1RecordingsIdShare401),
            "404": decodeError("ApiV1RecordingsIdShare404", ApiV1RecordingsIdShare404),
            "500": decodeError("ApiV1RecordingsIdShare500", ApiV1RecordingsIdShare500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/recordings/{id}/transcribe": (id, options) =>
      HttpClientRequest.post(`/api/v1/recordings/${id}/transcribe`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RecordingsIdTranscribe202),
            "400": decodeError("ApiV1RecordingsIdTranscribe400", ApiV1RecordingsIdTranscribe400),
            "401": decodeError("ApiV1RecordingsIdTranscribe401", ApiV1RecordingsIdTranscribe401),
            "500": decodeError("ApiV1RecordingsIdTranscribe500", ApiV1RecordingsIdTranscribe500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/recordings/{id}/transcript": (id, options) =>
      HttpClientRequest.get(`/api/v1/recordings/${id}/transcript`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RecordingsIdTranscript200),
            "400": decodeError("ApiV1RecordingsIdTranscript400", ApiV1RecordingsIdTranscript400),
            "404": decodeError("ApiV1RecordingsIdTranscript404", ApiV1RecordingsIdTranscript404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    listRooms: (options) =>
      HttpClientRequest.get(`/api/v1/rooms`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ListRooms200),
            "401": decodeError("ListRooms401", ListRooms401),
            "500": decodeError("ListRooms500", ListRooms500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createRoom: (options) =>
      HttpClientRequest.post(`/api/v1/rooms`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(CreateRoom201),
            "400": decodeError("CreateRoom400", CreateRoom400),
            "401": decodeError("CreateRoom401", CreateRoom401),
            "500": decodeError("CreateRoom500", CreateRoom500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getRoom: (id, options) =>
      HttpClientRequest.get(`/api/v1/rooms/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(GetRoom200),
            "400": decodeError("GetRoom400", GetRoom400),
            "401": decodeError("GetRoom401", GetRoom401),
            "404": decodeError("GetRoom404", GetRoom404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    deleteRoom: (id, options) =>
      HttpClientRequest.delete(`/api/v1/rooms/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "400": decodeError("DeleteRoom400", DeleteRoom400),
            "401": decodeError("DeleteRoom401", DeleteRoom401),
            "500": decodeError("DeleteRoom500", DeleteRoom500),
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    updateRoom: (id, options) =>
      HttpClientRequest.patch(`/api/v1/rooms/${id}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(UpdateRoom200),
            "400": decodeError("UpdateRoom400", UpdateRoom400),
            "401": decodeError("UpdateRoom401", UpdateRoom401),
            "500": decodeError("UpdateRoom500", UpdateRoom500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    presignChatAttachmentDownload: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/chat/attachments/presign-download`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(PresignChatAttachmentDownload200),
            "400": decodeError("PresignChatAttachmentDownload400", PresignChatAttachmentDownload400),
            "401": decodeError("PresignChatAttachmentDownload401", PresignChatAttachmentDownload401),
            "403": decodeError("PresignChatAttachmentDownload403", PresignChatAttachmentDownload403),
            "503": decodeError("PresignChatAttachmentDownload503", PresignChatAttachmentDownload503),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    presignChatAttachmentUpload: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/chat/attachments/presign-upload`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(PresignChatAttachmentUpload200),
            "400": decodeError("PresignChatAttachmentUpload400", PresignChatAttachmentUpload400),
            "401": decodeError("PresignChatAttachmentUpload401", PresignChatAttachmentUpload401),
            "403": decodeError("PresignChatAttachmentUpload403", PresignChatAttachmentUpload403),
            "503": decodeError("PresignChatAttachmentUpload503", PresignChatAttachmentUpload503),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    uploadChatAttachment: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/chat/attachments/upload`).pipe(
        HttpClientRequest.bodyFormData(options.payload as any),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "400": decodeError("UploadChatAttachment400", UploadChatAttachment400),
            "401": decodeError("UploadChatAttachment401", UploadChatAttachment401),
            "403": decodeError("UploadChatAttachment403", UploadChatAttachment403),
            "503": decodeError("UploadChatAttachment503", UploadChatAttachment503),
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    endRoom: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/end`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(EndRoom200),
            "400": decodeError("EndRoom400", EndRoom400),
            "401": decodeError("EndRoom401", EndRoom401),
            "500": decodeError("EndRoom500", EndRoom500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createJoinToken: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/join-token`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(CreateJoinToken200),
            "401": decodeError("CreateJoinToken401", CreateJoinToken401),
            "404": decodeError("CreateJoinToken404", CreateJoinToken404),
            "500": decodeError("CreateJoinToken500", CreateJoinToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    listParticipants: (id, options) =>
      HttpClientRequest.get(`/api/v1/rooms/${id}/participants`).pipe(
        HttpClientRequest.setUrlParams({ active: options?.params?.["active"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ListParticipants200),
            "400": decodeError("ListParticipants400", ListParticipants400),
            "401": decodeError("ListParticipants401", ListParticipants401),
            "500": decodeError("ListParticipants500", ListParticipants500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    addParticipant: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/participants`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(AddParticipant201),
            "400": decodeError("AddParticipant400", AddParticipant400),
            "401": decodeError("AddParticipant401", AddParticipant401),
            "500": decodeError("AddParticipant500", AddParticipant500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    removeParticipant: (id, pid, options) =>
      HttpClientRequest.delete(`/api/v1/rooms/${id}/participants/${pid}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(RemoveParticipant200),
            "400": decodeError("RemoveParticipant400", RemoveParticipant400),
            "401": decodeError("RemoveParticipant401", RemoveParticipant401),
            "404": decodeError("RemoveParticipant404", RemoveParticipant404),
            "500": decodeError("RemoveParticipant500", RemoveParticipant500),
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    updateParticipant: (id, pid, options) =>
      HttpClientRequest.patch(`/api/v1/rooms/${id}/participants/${pid}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(UpdateParticipant200),
            "400": decodeError("UpdateParticipant400", UpdateParticipant400),
            "401": decodeError("UpdateParticipant401", UpdateParticipant401),
            "403": decodeError("UpdateParticipant403", UpdateParticipant403),
            "404": decodeError("UpdateParticipant404", UpdateParticipant404),
            "500": decodeError("UpdateParticipant500", UpdateParticipant500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    refreshParticipantToken: (id, pid, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/participants/${pid}/token`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(RefreshParticipantToken200),
            "400": decodeError("RefreshParticipantToken400", RefreshParticipantToken400),
            "401": decodeError("RefreshParticipantToken401", RefreshParticipantToken401),
            "404": decodeError("RefreshParticipantToken404", RefreshParticipantToken404),
            "500": decodeError("RefreshParticipantToken500", RefreshParticipantToken500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/rooms/{id}/participants/bulk": (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/participants/bulk`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RoomsIdParticipantsBulk200),
            "400": decodeError("ApiV1RoomsIdParticipantsBulk400", ApiV1RoomsIdParticipantsBulk400),
            "401": decodeError("ApiV1RoomsIdParticipantsBulk401", ApiV1RoomsIdParticipantsBulk401),
            "404": decodeError("ApiV1RoomsIdParticipantsBulk404", ApiV1RoomsIdParticipantsBulk404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    archiveRoomRecording: (id, rid, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/recordings/${rid}/archive`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ArchiveRoomRecording200),
            "400": decodeError("ArchiveRoomRecording400", ArchiveRoomRecording400),
            "401": decodeError("ArchiveRoomRecording401", ArchiveRoomRecording401),
            "404": decodeError("ArchiveRoomRecording404", ArchiveRoomRecording404),
            "500": decodeError("ArchiveRoomRecording500", ArchiveRoomRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    startRecording: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/recordings/start`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(StartRecording201),
            "400": decodeError("StartRecording400", StartRecording400),
            "401": decodeError("StartRecording401", StartRecording401),
            "404": decodeError("StartRecording404", StartRecording404),
            "409": decodeError("StartRecording409", StartRecording409),
            "500": decodeError("StartRecording500", StartRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    stopRecording: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/recordings/stop`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(StopRecording200),
            "400": decodeError("StopRecording400", StopRecording400),
            "401": decodeError("StopRecording401", StopRecording401),
            "404": decodeError("StopRecording404", StopRecording404),
            "500": decodeError("StopRecording500", StopRecording500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/rooms/{id}/recordings/sync": (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/recordings/sync`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RoomsIdRecordingsSync200),
            "400": decodeError("ApiV1RoomsIdRecordingsSync400", ApiV1RoomsIdRecordingsSync400),
            "401": decodeError("ApiV1RoomsIdRecordingsSync401", ApiV1RoomsIdRecordingsSync401),
            "404": decodeError("ApiV1RoomsIdRecordingsSync404", ApiV1RoomsIdRecordingsSync404),
            "500": decodeError("ApiV1RoomsIdRecordingsSync500", ApiV1RoomsIdRecordingsSync500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/rooms/{id}/transcripts": (id, options) =>
      HttpClientRequest.get(`/api/v1/rooms/${id}/transcripts`).pipe(
        HttpClientRequest.setUrlParams({ limit: options?.params?.["limit"] as any, offset: options?.params?.["offset"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1RoomsIdTranscripts200),
            "400": decodeError("ApiV1RoomsIdTranscripts400", ApiV1RoomsIdTranscripts400),
            "401": decodeError("ApiV1RoomsIdTranscripts401", ApiV1RoomsIdTranscripts401),
            "404": decodeError("ApiV1RoomsIdTranscripts404", ApiV1RoomsIdTranscripts404),
            "500": decodeError("ApiV1RoomsIdTranscripts500", ApiV1RoomsIdTranscripts500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    presignWhiteboardDownload: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/whiteboard/files/presign-download`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(PresignWhiteboardDownload200),
            "400": decodeError("PresignWhiteboardDownload400", PresignWhiteboardDownload400),
            "401": decodeError("PresignWhiteboardDownload401", PresignWhiteboardDownload401),
            "403": decodeError("PresignWhiteboardDownload403", PresignWhiteboardDownload403),
            "500": decodeError("PresignWhiteboardDownload500", PresignWhiteboardDownload500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    presignWhiteboardUpload: (id, options) =>
      HttpClientRequest.post(`/api/v1/rooms/${id}/whiteboard/files/presign-upload`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(PresignWhiteboardUpload200),
            "400": decodeError("PresignWhiteboardUpload400", PresignWhiteboardUpload400),
            "401": decodeError("PresignWhiteboardUpload401", PresignWhiteboardUpload401),
            "403": decodeError("PresignWhiteboardUpload403", PresignWhiteboardUpload403),
            "500": decodeError("PresignWhiteboardUpload500", PresignWhiteboardUpload500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    scheduleRoom: (options) =>
      HttpClientRequest.post(`/api/v1/rooms/schedule`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ScheduleRoom201),
            "400": decodeError("ScheduleRoom400", ScheduleRoom400),
            "401": decodeError("ScheduleRoom401", ScheduleRoom401),
            "500": decodeError("ScheduleRoom500", ScheduleRoom500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/status": (options) =>
      HttpClientRequest.get(`/api/v1/status`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1Status200),
            "500": decodeError("ApiV1Status500", ApiV1Status500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/status/incidents/{incidentCode}": (incidentCode, options) =>
      HttpClientRequest.get(`/api/v1/status/incidents/${incidentCode}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1StatusIncidentsIncidentCode200),
            "404": decodeError("ApiV1StatusIncidentsIncidentCode404", ApiV1StatusIncidentsIncidentCode404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    createTenant: (options) =>
      HttpClientRequest.post(`/api/v1/tenants`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(CreateTenant201),
            "400": decodeError("CreateTenant400", CreateTenant400),
            "500": decodeError("CreateTenant500", CreateTenant500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    getTenant: (id, options) =>
      HttpClientRequest.get(`/api/v1/tenants/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(GetTenant200),
            "400": decodeError("GetTenant400", GetTenant400),
            "401": decodeError("GetTenant401", GetTenant401),
            "404": decodeError("GetTenant404", GetTenant404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    deleteTenant: (id, options) =>
      HttpClientRequest.delete(`/api/v1/tenants/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "400": decodeError("DeleteTenant400", DeleteTenant400),
            "401": decodeError("DeleteTenant401", DeleteTenant401),
            "500": decodeError("DeleteTenant500", DeleteTenant500),
            "204": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
    updateTenant: (id, options) =>
      HttpClientRequest.patch(`/api/v1/tenants/${id}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(UpdateTenant200),
            "400": decodeError("UpdateTenant400", UpdateTenant400),
            "401": decodeError("UpdateTenant401", UpdateTenant401),
            "500": decodeError("UpdateTenant500", UpdateTenant500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "PATCH/api/v1/tenants/{id}/config": (id, options) =>
      HttpClientRequest.patch(`/api/v1/tenants/${id}/config`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1TenantsIdConfig200),
            "400": decodeError("ApiV1TenantsIdConfig400", ApiV1TenantsIdConfig400),
            "403": decodeError("ApiV1TenantsIdConfig403", ApiV1TenantsIdConfig403),
            "404": decodeError("ApiV1TenantsIdConfig404", ApiV1TenantsIdConfig404),
            "500": decodeError("ApiV1TenantsIdConfig500", ApiV1TenantsIdConfig500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    rotateTenantApiKey: (id, options) =>
      HttpClientRequest.post(`/api/v1/tenants/${id}/rotate-key`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(RotateTenantApiKey200),
            "400": decodeError("RotateTenantApiKey400", RotateTenantApiKey400),
            "401": decodeError("RotateTenantApiKey401", RotateTenantApiKey401),
            "500": decodeError("RotateTenantApiKey500", RotateTenantApiKey500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/transcription/{id}": (id, options) =>
      HttpClientRequest.get(`/api/v1/transcription/${id}`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1TranscriptionId200),
            "400": decodeError("ApiV1TranscriptionId400", ApiV1TranscriptionId400),
            "401": decodeError("ApiV1TranscriptionId401", ApiV1TranscriptionId401),
            "404": decodeError("ApiV1TranscriptionId404", ApiV1TranscriptionId404),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/transcription/providers": (options) =>
      HttpClientRequest.get(`/api/v1/transcription/providers`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1TranscriptionProviders200),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "POST/api/v1/transcription/providers/cloudflare/callback": (options) =>
      HttpClientRequest.post(`/api/v1/transcription/providers/cloudflare/callback`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1TranscriptionProvidersCloudflareCallback200),
            "400": decodeError("ApiV1TranscriptionProvidersCloudflareCallback400", ApiV1TranscriptionProvidersCloudflareCallback400),
            "401": decodeError("ApiV1TranscriptionProvidersCloudflareCallback401", ApiV1TranscriptionProvidersCloudflareCallback401),
            "503": decodeError("ApiV1TranscriptionProvidersCloudflareCallback503", ApiV1TranscriptionProvidersCloudflareCallback503),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    handleRecordingReadyWebhook: (options) =>
      HttpClientRequest.post(`/api/v1/webhooks/cloudflare/recording`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(HandleRecordingReadyWebhook200),
            "400": decodeError("HandleRecordingReadyWebhook400", HandleRecordingReadyWebhook400),
            "404": decodeError("HandleRecordingReadyWebhook404", HandleRecordingReadyWebhook404),
            "500": decodeError("HandleRecordingReadyWebhook500", HandleRecordingReadyWebhook500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    handleLocalPostMeetingWebhook: (options) =>
      HttpClientRequest.post(`/api/v1/webhooks/local/post-meeting`).pipe(
        HttpClientRequest.bodyJsonUnsafe(options.payload),
        withResponse(options.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(HandleLocalPostMeetingWebhook200),
            "400": decodeError("HandleLocalPostMeetingWebhook400", HandleLocalPostMeetingWebhook400),
            "401": decodeError("HandleLocalPostMeetingWebhook401", HandleLocalPostMeetingWebhook401),
            "404": decodeError("HandleLocalPostMeetingWebhook404", HandleLocalPostMeetingWebhook404),
            "500": decodeError("HandleLocalPostMeetingWebhook500", HandleLocalPostMeetingWebhook500),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/whats-new": (options) =>
      HttpClientRequest.get(`/api/v1/whats-new`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1WhatsNew200),
            "404": decodeError("ApiV1WhatsNew404", ApiV1WhatsNew404),
            "502": decodeError("ApiV1WhatsNew502", ApiV1WhatsNew502),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/api/v1/whats-new/releases": (options) =>
      HttpClientRequest.get(`/api/v1/whats-new/releases`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(ApiV1WhatsNewReleases200),
            "404": decodeError("ApiV1WhatsNewReleases404", ApiV1WhatsNewReleases404),
            "502": decodeError("ApiV1WhatsNewReleases502", ApiV1WhatsNewReleases502),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    healthCheck: (options) =>
      HttpClientRequest.get(`/health`).pipe(
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "2xx": decodeSuccess(HealthCheck200),
            orElse: unexpectedStatus,
          }),
        ),
      ),
    "GET/ws": (options) =>
      HttpClientRequest.get(`/ws`).pipe(
        HttpClientRequest.setUrlParams({ token: options?.params?.["token"] as any, room: options?.params?.["room"] as any }),
        withResponse(options?.config)(
          HttpClientResponse.matchStatus({
            "400": decodeError("Ws400", Ws400),
            "401": decodeError("Ws401", Ws401),
            "403": decodeError("Ws403", Ws403),
            "101": () => Effect.void,
            orElse: unexpectedStatus,
          }),
        ),
      ),
  };
};

export interface ChalkApi {
  readonly httpClient: HttpClient.HttpClient;
  /**
   * List Audit Logs
   */
  readonly "GET/api/v1/admin/audit-logs": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminAuditLogsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminAuditLogs200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminAuditLogs500", typeof ApiV1AdminAuditLogs500.Type>>;
  /**
   * List Ops Incidents
   */
  readonly "GET/api/v1/admin/ops/incidents": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminOpsIncidentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidents200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidents500", typeof ApiV1AdminOpsIncidents500.Type>>;
  /**
   * Get Ops Incident
   */
  readonly "GET/api/v1/admin/ops/incidents/{incidentCode}": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsIncidentCode200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsIncidentCode404", typeof ApiV1AdminOpsIncidentsIncidentCode404.Type>>;
  /**
   * Generate Ops Incident AI Drafts
   */
  readonly "POST/api/v1/admin/ops/incidents/{incidentCode}/ai-drafts": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsIncidentCodeAiDrafts200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400", typeof ApiV1AdminOpsIncidentsIncidentCodeAiDrafts400.Type>>;
  /**
   * Add Ops Incident Event
   */
  readonly "POST/api/v1/admin/ops/incidents/{incidentCode}/events": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly payload: typeof ApiV1AdminOpsIncidentsIncidentCodeEventsRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsIncidentCodeEvents200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsIncidentCodeEvents400", typeof ApiV1AdminOpsIncidentsIncidentCodeEvents400.Type>>;
  /**
   * Publish Ops Incident
   */
  readonly "POST/api/v1/admin/ops/incidents/{incidentCode}/publish": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly payload: typeof ApiV1AdminOpsIncidentsIncidentCodePublishRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsIncidentCodePublish200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsIncidentCodePublish400", typeof ApiV1AdminOpsIncidentsIncidentCodePublish400.Type>>;
  /**
   * Resolve Ops Incident
   */
  readonly "POST/api/v1/admin/ops/incidents/{incidentCode}/resolve": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly payload: typeof ApiV1AdminOpsIncidentsIncidentCodeResolveRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsIncidentCodeResolve200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsIncidentCodeResolve400", typeof ApiV1AdminOpsIncidentsIncidentCodeResolve400.Type>>;
  /**
   * Declare Ops Incident
   */
  readonly "POST/api/v1/admin/ops/incidents/declare": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1AdminOpsIncidentsDeclareRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsIncidentsDeclare201.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsIncidentsDeclare400", typeof ApiV1AdminOpsIncidentsDeclare400.Type>>;
  /**
   * Create Maintenance Window
   */
  readonly "POST/api/v1/admin/ops/maintenance": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1AdminOpsMaintenanceRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsMaintenance201.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsMaintenance400", typeof ApiV1AdminOpsMaintenance400.Type>>;
  /**
   * Cancel Maintenance Window
   */
  readonly "POST/api/v1/admin/ops/maintenance/{id}/cancel": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminOpsMaintenanceIdCancel200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsMaintenanceIdCancel400", typeof ApiV1AdminOpsMaintenanceIdCancel400.Type> | ChalkApiError<"ApiV1AdminOpsMaintenanceIdCancel404", typeof ApiV1AdminOpsMaintenanceIdCancel404.Type>
  >;
  /**
   * Get Ops Overview
   */
  readonly "GET/api/v1/admin/ops/overview": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOpsOverview200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOpsOverview500", typeof ApiV1AdminOpsOverview500.Type>>;
  /**
   * Get Admin Overview
   */
  readonly "GET/api/v1/admin/overview": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminOverview200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminOverview500", typeof ApiV1AdminOverview500.Type>>;
  /**
   * List Recordings
   */
  readonly "GET/api/v1/admin/recordings": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminRecordingsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminRecordings200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminRecordings500", typeof ApiV1AdminRecordings500.Type>>;
  /**
   * List Rooms
   */
  readonly "GET/api/v1/admin/rooms": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminRoomsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminRooms200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminRooms500", typeof ApiV1AdminRooms500.Type>>;
  /**
   * Get Room Details
   */
  readonly "GET/api/v1/admin/rooms/{id}": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminRoomsId200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminRoomsId400", typeof ApiV1AdminRoomsId400.Type> | ChalkApiError<"ApiV1AdminRoomsId404", typeof ApiV1AdminRoomsId404.Type> | ChalkApiError<"ApiV1AdminRoomsId500", typeof ApiV1AdminRoomsId500.Type>
  >;
  /**
   * List Tenants
   */
  readonly "GET/api/v1/admin/tenants": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminTenantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminTenants200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenants500", typeof ApiV1AdminTenants500.Type>>;
  /**
   * Create Tenant
   */
  readonly "POST/api/v1/admin/tenants": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1AdminTenantsRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminTenants201.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenants400", typeof ApiV1AdminTenants400.Type> | ChalkApiError<"ApiV1AdminTenants5002", typeof ApiV1AdminTenants5002.Type>>;
  /**
   * Get Tenant
   */
  readonly "GET/api/v1/admin/tenants/{id}": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminTenantsId200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsId400", typeof ApiV1AdminTenantsId400.Type> | ChalkApiError<"ApiV1AdminTenantsId404", typeof ApiV1AdminTenantsId404.Type>>;
  /**
   * Delete Tenant
   */
  readonly "DELETE/api/v1/admin/tenants/{id}": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsId4002", typeof ApiV1AdminTenantsId4002.Type> | ChalkApiError<"ApiV1AdminTenantsId500", typeof ApiV1AdminTenantsId500.Type>>;
  /**
   * Update Tenant
   */
  readonly "PATCH/api/v1/admin/tenants/{id}": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1AdminTenantsIdRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminTenantsId2002.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsId4003", typeof ApiV1AdminTenantsId4003.Type> | ChalkApiError<"ApiV1AdminTenantsId5002", typeof ApiV1AdminTenantsId5002.Type>>;
  /**
   * Activate Tenant
   */
  readonly "PATCH/api/v1/admin/tenants/{id}/activate": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminTenantsIdActivate200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsIdActivate400", typeof ApiV1AdminTenantsIdActivate400.Type> | ChalkApiError<"ApiV1AdminTenantsIdActivate500", typeof ApiV1AdminTenantsIdActivate500.Type>
  >;
  /**
   * Update Tenant Config
   */
  readonly "PATCH/api/v1/admin/tenants/{id}/config": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1AdminTenantsIdConfigRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminTenantsIdConfig200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsIdConfig400", typeof ApiV1AdminTenantsIdConfig400.Type> | ChalkApiError<"ApiV1AdminTenantsIdConfig500", typeof ApiV1AdminTenantsIdConfig500.Type>
  >;
  /**
   * Deactivate Tenant
   */
  readonly "PATCH/api/v1/admin/tenants/{id}/deactivate": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminTenantsIdDeactivate200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsIdDeactivate400", typeof ApiV1AdminTenantsIdDeactivate400.Type> | ChalkApiError<"ApiV1AdminTenantsIdDeactivate500", typeof ApiV1AdminTenantsIdDeactivate500.Type>
  >;
  /**
   * Rotate Tenant API Key
   */
  readonly "POST/api/v1/admin/tenants/{id}/rotate-key": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminTenantsIdRotateKey200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsIdRotateKey400", typeof ApiV1AdminTenantsIdRotateKey400.Type> | ChalkApiError<"ApiV1AdminTenantsIdRotateKey500", typeof ApiV1AdminTenantsIdRotateKey500.Type>
  >;
  /**
   * Update Tenant Whiteboard Config
   */
  readonly "PATCH/api/v1/admin/tenants/{id}/whiteboard-config": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1AdminTenantsIdWhiteboardConfigRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1AdminTenantsIdWhiteboardConfig200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTenantsIdWhiteboardConfig400", typeof ApiV1AdminTenantsIdWhiteboardConfig400.Type> | ChalkApiError<"ApiV1AdminTenantsIdWhiteboardConfig500", typeof ApiV1AdminTenantsIdWhiteboardConfig500.Type>
  >;
  /**
   * List Transcripts
   */
  readonly "GET/api/v1/admin/transcripts": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminTranscriptsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminTranscripts200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminTranscripts500", typeof ApiV1AdminTranscripts500.Type>>;
  /**
   * Get Usage Summary
   */
  readonly "GET/api/v1/admin/usage": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminUsage200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminUsage500", typeof ApiV1AdminUsage500.Type>>;
  /**
   * List Webhook Deliveries
   */
  readonly "GET/api/v1/admin/webhooks": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminWebhooksParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminWebhooks200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminWebhooks500", typeof ApiV1AdminWebhooks500.Type>>;
  /**
   * List Whisper Jobs
   */
  readonly "GET/api/v1/admin/whisper-jobs": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1AdminWhisperJobsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminWhisperJobs200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminWhisperJobs500", typeof ApiV1AdminWhisperJobs500.Type>>;
  /**
   * List Processing Whisper Jobs
   */
  readonly "GET/api/v1/admin/whisper-jobs/processing": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminWhisperJobsProcessing200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminWhisperJobsProcessing500", typeof ApiV1AdminWhisperJobsProcessing500.Type>>;
  /**
   * Get Whisper Job Stats
   */
  readonly "GET/api/v1/admin/whisper-jobs/stats": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1AdminWhisperJobsStats200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1AdminWhisperJobsStats500", typeof ApiV1AdminWhisperJobsStats500.Type>>;
  /**
   * Exchange a refresh token for a new token pair
   */
  readonly refreshToken: <Config extends OperationConfig>(options: {
    readonly payload: typeof RefreshTokenRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof RefreshToken200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"RefreshToken400", typeof RefreshToken400.Type> | ChalkApiError<"RefreshToken401", typeof RefreshToken401.Type> | ChalkApiError<"RefreshToken500", typeof RefreshToken500.Type>
  >;
  /**
   * Exchange a tenant API key for a JWT token pair (access + refresh).
   * The access token is used for subsequent API calls.
   */
  readonly getToken: <Config extends OperationConfig>(options: {
    readonly payload: typeof GetTokenRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<WithOptionalResponse<typeof GetToken200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"GetToken400", typeof GetToken400.Type> | ChalkApiError<"GetToken401", typeof GetToken401.Type> | ChalkApiError<"GetToken500", typeof GetToken500.Type>>;
  /**
   * Returns server-side interpretation of the presented JWT (claims, expiry),
   * plus server clock and build metadata for support diagnostics.
   */
  readonly debugAuth: <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DebugAuth200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"DebugAuth401", typeof DebugAuth401.Type>>;
  /**
   * Report Client Incident
   */
  readonly "POST/api/v1/debug/client-incident": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1DebugClientIncidentRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1DebugClientIncident202.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1DebugClientIncident400", typeof ApiV1DebugClientIncident400.Type>
    | ChalkApiError<"ApiV1DebugClientIncident401", typeof ApiV1DebugClientIncident401.Type>
    | ChalkApiError<"ApiV1DebugClientIncident500", typeof ApiV1DebugClientIncident500.Type>
  >;
  /**
   * Lightweight endpoint for reachability and latency checks.
   */
  readonly debugPing: <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>;
  /**
   * Get Internal Access Token
   */
  readonly "GET/api/v1/internal/auth/access-token": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1InternalAuthAccessTokenParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1InternalAuthAccessToken200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1InternalAuthAccessToken500", typeof ApiV1InternalAuthAccessToken500.Type>>;
  /**
   * Exchange Google OAuth Code
   */
  readonly "POST/api/v1/internal/auth/google": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1InternalAuthGoogleRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1InternalAuthGoogle200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1InternalAuthGoogle400", typeof ApiV1InternalAuthGoogle400.Type>
    | ChalkApiError<"ApiV1InternalAuthGoogle401", typeof ApiV1InternalAuthGoogle401.Type>
    | ChalkApiError<"ApiV1InternalAuthGoogle500", typeof ApiV1InternalAuthGoogle500.Type>
    | ChalkApiError<"ApiV1InternalAuthGoogle503", typeof ApiV1InternalAuthGoogle503.Type>
  >;
  /**
   * Logout Internal Session
   */
  readonly "POST/api/v1/internal/auth/logout": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof ApiV1InternalAuthLogout200.Type, Config>, HttpClientError.HttpClientError | SchemaError>;
  /**
   * Get Internal Session
   */
  readonly "GET/api/v1/internal/auth/session": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1InternalAuthSession200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1InternalAuthSession401", typeof ApiV1InternalAuthSession401.Type>>;
  /**
   * List Internal Meetings
   */
  readonly "GET/api/v1/internal/meetings": <Config extends OperationConfig>(
    options: { readonly params?: typeof ApiV1InternalMeetingsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1InternalMeetings200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1InternalMeetings401", typeof ApiV1InternalMeetings401.Type>
    | ChalkApiError<"ApiV1InternalMeetings403", typeof ApiV1InternalMeetings403.Type>
    | ChalkApiError<"ApiV1InternalMeetings404", typeof ApiV1InternalMeetings404.Type>
    | ChalkApiError<"ApiV1InternalMeetings500", typeof ApiV1InternalMeetings500.Type>
  >;
  /**
   * Ingest Heartbeat Event
   */
  readonly "POST/api/v1/ops/ingest/heartbeats": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1OpsIngestHeartbeatsRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1OpsIngestHeartbeats202.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1OpsIngestHeartbeats400", typeof ApiV1OpsIngestHeartbeats400.Type>
    | ChalkApiError<"ApiV1OpsIngestHeartbeats401", typeof ApiV1OpsIngestHeartbeats401.Type>
    | ChalkApiError<"ApiV1OpsIngestHeartbeats500", typeof ApiV1OpsIngestHeartbeats500.Type>
  >;
  /**
   * Ingest Monitor Result
   */
  readonly "POST/api/v1/ops/ingest/monitor-results": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1OpsIngestMonitorResultsRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1OpsIngestMonitorResults202.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1OpsIngestMonitorResults400", typeof ApiV1OpsIngestMonitorResults400.Type>
    | ChalkApiError<"ApiV1OpsIngestMonitorResults401", typeof ApiV1OpsIngestMonitorResults401.Type>
    | ChalkApiError<"ApiV1OpsIngestMonitorResults500", typeof ApiV1OpsIngestMonitorResults500.Type>
  >;
  /**
   * Exchange a previously issued join token for short-lived room access
   * credentials used to continue session initialization.
   */
  readonly exchangeJoinToken: <Config extends OperationConfig>(options: {
    readonly payload: typeof ExchangeJoinTokenRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ExchangeJoinToken200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ExchangeJoinToken400", typeof ExchangeJoinToken400.Type>
    | ChalkApiError<"ExchangeJoinToken401", typeof ExchangeJoinToken401.Type>
    | ChalkApiError<"ExchangeJoinToken404", typeof ExchangeJoinToken404.Type>
    | ChalkApiError<"ExchangeJoinToken500", typeof ExchangeJoinToken500.Type>
  >;
  /**
   * Get Public Recording Share
   */
  readonly "GET/api/v1/public/share/{token}": <Config extends OperationConfig>(
    token: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1PublicShareToken200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1PublicShareToken404", typeof ApiV1PublicShareToken404.Type>>;
  /**
   * List all recordings for the authenticated tenant
   */
  readonly listRecordings: <Config extends OperationConfig>(
    options: { readonly params?: typeof ListRecordingsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ListRecordings200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ListRecordings401", typeof ListRecordings401.Type> | ChalkApiError<"ListRecordings500", typeof ListRecordings500.Type>>;
  /**
   * Retrieve recording information including room details
   */
  readonly getRecording: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetRecording200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"GetRecording400", typeof GetRecording400.Type>
    | ChalkApiError<"GetRecording401", typeof GetRecording401.Type>
    | ChalkApiError<"GetRecording404", typeof GetRecording404.Type>
    | ChalkApiError<"GetRecording500", typeof GetRecording500.Type>
  >;
  /**
   * Delete a recording and its stored file
   */
  readonly deleteRecording: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof DeleteRecording200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"DeleteRecording400", typeof DeleteRecording400.Type>
    | ChalkApiError<"DeleteRecording401", typeof DeleteRecording401.Type>
    | ChalkApiError<"DeleteRecording404", typeof DeleteRecording404.Type>
    | ChalkApiError<"DeleteRecording500", typeof DeleteRecording500.Type>
  >;
  /**
   * Move a recording from R2 to S3 Glacier for long-term storage
   */
  readonly archiveRecording: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ArchiveRecording200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ArchiveRecording400", typeof ArchiveRecording400.Type>
    | ChalkApiError<"ArchiveRecording401", typeof ArchiveRecording401.Type>
    | ChalkApiError<"ArchiveRecording404", typeof ArchiveRecording404.Type>
    | ChalkApiError<"ArchiveRecording500", typeof ArchiveRecording500.Type>
  >;
  /**
   * Get a presigned download URL for a recording. The URL is valid for 1 hour.
   * If the recording is still processing, returns the current status.
   */
  readonly getRecordingDownloadUrl: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof GetRecordingDownloadUrl200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"GetRecordingDownloadUrl400", typeof GetRecordingDownloadUrl400.Type>
    | ChalkApiError<"GetRecordingDownloadUrl401", typeof GetRecordingDownloadUrl401.Type>
    | ChalkApiError<"GetRecordingDownloadUrl404", typeof GetRecordingDownloadUrl404.Type>
    | ChalkApiError<"GetRecordingDownloadUrl500", typeof GetRecordingDownloadUrl500.Type>
  >;
  /**
   * Recover Recording from Cloudflare
   */
  readonly "POST/api/v1/recordings/{id}/recover": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RecordingsIdRecover200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RecordingsIdRecover400", typeof ApiV1RecordingsIdRecover400.Type>
    | ChalkApiError<"ApiV1RecordingsIdRecover401", typeof ApiV1RecordingsIdRecover401.Type>
    | ChalkApiError<"ApiV1RecordingsIdRecover404", typeof ApiV1RecordingsIdRecover404.Type>
    | ChalkApiError<"ApiV1RecordingsIdRecover500", typeof ApiV1RecordingsIdRecover500.Type>
    | ChalkApiError<"ApiV1RecordingsIdRecover502", typeof ApiV1RecordingsIdRecover502.Type>
  >;
  /**
   * Requires host role in addition to recording permissions.
   */
  readonly "POST/api/v1/recordings/{id}/share": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RecordingsIdShare200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RecordingsIdShare400", typeof ApiV1RecordingsIdShare400.Type>
    | ChalkApiError<"ApiV1RecordingsIdShare401", typeof ApiV1RecordingsIdShare401.Type>
    | ChalkApiError<"ApiV1RecordingsIdShare404", typeof ApiV1RecordingsIdShare404.Type>
    | ChalkApiError<"ApiV1RecordingsIdShare500", typeof ApiV1RecordingsIdShare500.Type>
  >;
  /**
   * Queue Post-Meeting Transcription
   */
  readonly "POST/api/v1/recordings/{id}/transcribe": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1RecordingsIdTranscribeRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RecordingsIdTranscribe202.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RecordingsIdTranscribe400", typeof ApiV1RecordingsIdTranscribe400.Type>
    | ChalkApiError<"ApiV1RecordingsIdTranscribe401", typeof ApiV1RecordingsIdTranscribe401.Type>
    | ChalkApiError<"ApiV1RecordingsIdTranscribe500", typeof ApiV1RecordingsIdTranscribe500.Type>
  >;
  /**
   * Get Post-Meeting Transcript by Recording
   */
  readonly "GET/api/v1/recordings/{id}/transcript": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RecordingsIdTranscript200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1RecordingsIdTranscript400", typeof ApiV1RecordingsIdTranscript400.Type> | ChalkApiError<"ApiV1RecordingsIdTranscript404", typeof ApiV1RecordingsIdTranscript404.Type>
  >;
  /**
   * List all active rooms for the authenticated tenant
   */
  readonly listRooms: <Config extends OperationConfig>(
    options: { readonly params?: typeof ListRoomsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ListRooms200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ListRooms401", typeof ListRooms401.Type> | ChalkApiError<"ListRooms500", typeof ListRooms500.Type>>;
  /**
   * Create a new video conferencing room. A Cloudflare RealtimeKit meeting
   * is automatically provisioned.
   */
  readonly createRoom: <Config extends OperationConfig>(options: {
    readonly payload: typeof CreateRoomRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof CreateRoom201.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"CreateRoom400", typeof CreateRoom400.Type> | ChalkApiError<"CreateRoom401", typeof CreateRoom401.Type> | ChalkApiError<"CreateRoom500", typeof CreateRoom500.Type>
  >;
  /**
   * Retrieve room information including participant count
   */
  readonly getRoom: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof GetRoom200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"GetRoom400", typeof GetRoom400.Type> | ChalkApiError<"GetRoom401", typeof GetRoom401.Type> | ChalkApiError<"GetRoom404", typeof GetRoom404.Type>>;
  /**
   * End and delete a room (also removes from Cloudflare)
   */
  readonly deleteRoom: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"DeleteRoom400", typeof DeleteRoom400.Type> | ChalkApiError<"DeleteRoom401", typeof DeleteRoom401.Type> | ChalkApiError<"DeleteRoom500", typeof DeleteRoom500.Type>>;
  /**
   * Update room name or configuration
   */
  readonly updateRoom: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof UpdateRoomRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof UpdateRoom200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"UpdateRoom400", typeof UpdateRoom400.Type> | ChalkApiError<"UpdateRoom401", typeof UpdateRoom401.Type> | ChalkApiError<"UpdateRoom500", typeof UpdateRoom500.Type>
  >;
  /**
   * Create a download URL for a chat attachment.
   */
  readonly presignChatAttachmentDownload: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof PresignChatAttachmentDownloadRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof PresignChatAttachmentDownload200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"PresignChatAttachmentDownload400", typeof PresignChatAttachmentDownload400.Type>
    | ChalkApiError<"PresignChatAttachmentDownload401", typeof PresignChatAttachmentDownload401.Type>
    | ChalkApiError<"PresignChatAttachmentDownload403", typeof PresignChatAttachmentDownload403.Type>
    | ChalkApiError<"PresignChatAttachmentDownload503", typeof PresignChatAttachmentDownload503.Type>
  >;
  /**
   * Create upload URLs for one or more chat attachments.
   */
  readonly presignChatAttachmentUpload: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof PresignChatAttachmentUploadRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof PresignChatAttachmentUpload200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"PresignChatAttachmentUpload400", typeof PresignChatAttachmentUpload400.Type>
    | ChalkApiError<"PresignChatAttachmentUpload401", typeof PresignChatAttachmentUpload401.Type>
    | ChalkApiError<"PresignChatAttachmentUpload403", typeof PresignChatAttachmentUpload403.Type>
    | ChalkApiError<"PresignChatAttachmentUpload503", typeof PresignChatAttachmentUpload503.Type>
  >;
  /**
   * Upload a pending chat attachment as multipart form data.
   */
  readonly uploadChatAttachment: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof UploadChatAttachmentRequestFormData.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<void, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"UploadChatAttachment400", typeof UploadChatAttachment400.Type>
    | ChalkApiError<"UploadChatAttachment401", typeof UploadChatAttachment401.Type>
    | ChalkApiError<"UploadChatAttachment403", typeof UploadChatAttachment403.Type>
    | ChalkApiError<"UploadChatAttachment503", typeof UploadChatAttachment503.Type>
  >;
  /**
   * End an active room session. All participants are disconnected and
   * the room status is set to 'ended'. The room can be reactivated later.
   */
  readonly endRoom: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof EndRoom200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"EndRoom400", typeof EndRoom400.Type> | ChalkApiError<"EndRoom401", typeof EndRoom401.Type> | ChalkApiError<"EndRoom500", typeof EndRoom500.Type>>;
  /**
   * Create an opaque join token for a room. This token can be exchanged
   * by unauthenticated clients for scoped participant access.
   */
  readonly createJoinToken: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof CreateJoinToken200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"CreateJoinToken401", typeof CreateJoinToken401.Type> | ChalkApiError<"CreateJoinToken404", typeof CreateJoinToken404.Type> | ChalkApiError<"CreateJoinToken500", typeof CreateJoinToken500.Type>
  >;
  /**
   * List all participants in a room
   */
  readonly listParticipants: <Config extends OperationConfig>(
    id: string,
    options: { readonly params?: typeof ListParticipantsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ListParticipants200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ListParticipants400", typeof ListParticipants400.Type> | ChalkApiError<"ListParticipants401", typeof ListParticipants401.Type> | ChalkApiError<"ListParticipants500", typeof ListParticipants500.Type>
  >;
  /**
   * Add a new participant to a room. Returns participant info along with
   * JWT tokens and Cloudflare auth token for SDK connection.
   */
  readonly addParticipant: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof AddParticipantRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof AddParticipant201.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"AddParticipant400", typeof AddParticipant400.Type> | ChalkApiError<"AddParticipant401", typeof AddParticipant401.Type> | ChalkApiError<"AddParticipant500", typeof AddParticipant500.Type>
  >;
  /**
   * Remove (kick) a participant from the room
   */
  readonly removeParticipant: <Config extends OperationConfig>(
    id: string,
    pid: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof RemoveParticipant200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"RemoveParticipant400", typeof RemoveParticipant400.Type>
    | ChalkApiError<"RemoveParticipant401", typeof RemoveParticipant401.Type>
    | ChalkApiError<"RemoveParticipant404", typeof RemoveParticipant404.Type>
    | ChalkApiError<"RemoveParticipant500", typeof RemoveParticipant500.Type>
  >;
  /**
   * Update participant metadata (display name and/or role)
   */
  readonly updateParticipant: <Config extends OperationConfig>(
    id: string,
    pid: string,
    options: { readonly payload: typeof UpdateParticipantRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof UpdateParticipant200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"UpdateParticipant400", typeof UpdateParticipant400.Type>
    | ChalkApiError<"UpdateParticipant401", typeof UpdateParticipant401.Type>
    | ChalkApiError<"UpdateParticipant403", typeof UpdateParticipant403.Type>
    | ChalkApiError<"UpdateParticipant404", typeof UpdateParticipant404.Type>
    | ChalkApiError<"UpdateParticipant500", typeof UpdateParticipant500.Type>
  >;
  /**
   * Generate a new token pair and Cloudflare auth token for a participant.
   * Use this when the current token is about to expire.
   */
  readonly refreshParticipantToken: <Config extends OperationConfig>(
    id: string,
    pid: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof RefreshParticipantToken200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"RefreshParticipantToken400", typeof RefreshParticipantToken400.Type>
    | ChalkApiError<"RefreshParticipantToken401", typeof RefreshParticipantToken401.Type>
    | ChalkApiError<"RefreshParticipantToken404", typeof RefreshParticipantToken404.Type>
    | ChalkApiError<"RefreshParticipantToken500", typeof RefreshParticipantToken500.Type>
  >;
  /**
   * Requires host role.
   */
  readonly "POST/api/v1/rooms/{id}/participants/bulk": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1RoomsIdParticipantsBulkRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RoomsIdParticipantsBulk200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RoomsIdParticipantsBulk400", typeof ApiV1RoomsIdParticipantsBulk400.Type>
    | ChalkApiError<"ApiV1RoomsIdParticipantsBulk401", typeof ApiV1RoomsIdParticipantsBulk401.Type>
    | ChalkApiError<"ApiV1RoomsIdParticipantsBulk404", typeof ApiV1RoomsIdParticipantsBulk404.Type>
  >;
  /**
   * Move a recording from R2 to S3 Glacier for long-term storage
   */
  readonly archiveRoomRecording: <Config extends OperationConfig>(
    id: string,
    rid: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ArchiveRoomRecording200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ArchiveRoomRecording400", typeof ArchiveRoomRecording400.Type>
    | ChalkApiError<"ArchiveRoomRecording401", typeof ArchiveRoomRecording401.Type>
    | ChalkApiError<"ArchiveRoomRecording404", typeof ArchiveRoomRecording404.Type>
    | ChalkApiError<"ArchiveRoomRecording500", typeof ArchiveRoomRecording500.Type>
  >;
  /**
   * Start recording a room session via Cloudflare
   */
  readonly startRecording: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof StartRecording201.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"StartRecording400", typeof StartRecording400.Type>
    | ChalkApiError<"StartRecording401", typeof StartRecording401.Type>
    | ChalkApiError<"StartRecording404", typeof StartRecording404.Type>
    | ChalkApiError<"StartRecording409", typeof StartRecording409.Type>
    | ChalkApiError<"StartRecording500", typeof StartRecording500.Type>
  >;
  /**
   * Stop the active recording for a room
   */
  readonly stopRecording: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof StopRecording200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"StopRecording400", typeof StopRecording400.Type>
    | ChalkApiError<"StopRecording401", typeof StopRecording401.Type>
    | ChalkApiError<"StopRecording404", typeof StopRecording404.Type>
    | ChalkApiError<"StopRecording500", typeof StopRecording500.Type>
  >;
  /**
   * Requires host role.
   */
  readonly "POST/api/v1/rooms/{id}/recordings/sync": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RoomsIdRecordingsSync200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RoomsIdRecordingsSync400", typeof ApiV1RoomsIdRecordingsSync400.Type>
    | ChalkApiError<"ApiV1RoomsIdRecordingsSync401", typeof ApiV1RoomsIdRecordingsSync401.Type>
    | ChalkApiError<"ApiV1RoomsIdRecordingsSync404", typeof ApiV1RoomsIdRecordingsSync404.Type>
    | ChalkApiError<"ApiV1RoomsIdRecordingsSync500", typeof ApiV1RoomsIdRecordingsSync500.Type>
  >;
  /**
   * List Room Transcripts
   */
  readonly "GET/api/v1/rooms/{id}/transcripts": <Config extends OperationConfig>(
    id: string,
    options: { readonly params?: typeof ApiV1RoomsIdTranscriptsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1RoomsIdTranscripts200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1RoomsIdTranscripts400", typeof ApiV1RoomsIdTranscripts400.Type>
    | ChalkApiError<"ApiV1RoomsIdTranscripts401", typeof ApiV1RoomsIdTranscripts401.Type>
    | ChalkApiError<"ApiV1RoomsIdTranscripts404", typeof ApiV1RoomsIdTranscripts404.Type>
    | ChalkApiError<"ApiV1RoomsIdTranscripts500", typeof ApiV1RoomsIdTranscripts500.Type>
  >;
  /**
   * Create a short-lived download URL for whiteboard files.
   */
  readonly presignWhiteboardDownload: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof PresignWhiteboardDownloadRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof PresignWhiteboardDownload200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"PresignWhiteboardDownload400", typeof PresignWhiteboardDownload400.Type>
    | ChalkApiError<"PresignWhiteboardDownload401", typeof PresignWhiteboardDownload401.Type>
    | ChalkApiError<"PresignWhiteboardDownload403", typeof PresignWhiteboardDownload403.Type>
    | ChalkApiError<"PresignWhiteboardDownload500", typeof PresignWhiteboardDownload500.Type>
  >;
  /**
   * Create a short-lived upload URL for whiteboard files.
   */
  readonly presignWhiteboardUpload: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof PresignWhiteboardUploadRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof PresignWhiteboardUpload200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"PresignWhiteboardUpload400", typeof PresignWhiteboardUpload400.Type>
    | ChalkApiError<"PresignWhiteboardUpload401", typeof PresignWhiteboardUpload401.Type>
    | ChalkApiError<"PresignWhiteboardUpload403", typeof PresignWhiteboardUpload403.Type>
    | ChalkApiError<"PresignWhiteboardUpload500", typeof PresignWhiteboardUpload500.Type>
  >;
  /**
   * Schedule a room to become active on first join at or after the
   * configured start time (optionally with an early-join window).
   */
  readonly scheduleRoom: <Config extends OperationConfig>(options: {
    readonly payload: typeof ScheduleRoomRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ScheduleRoom201.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ScheduleRoom400", typeof ScheduleRoom400.Type> | ChalkApiError<"ScheduleRoom401", typeof ScheduleRoom401.Type> | ChalkApiError<"ScheduleRoom500", typeof ScheduleRoom500.Type>
  >;
  /**
   * Get Public Status Summary
   */
  readonly "GET/api/v1/status": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1Status200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1Status500", typeof ApiV1Status500.Type>>;
  /**
   * Get Public Incident Details
   */
  readonly "GET/api/v1/status/incidents/{incidentCode}": <Config extends OperationConfig>(
    incidentCode: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1StatusIncidentsIncidentCode200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1StatusIncidentsIncidentCode404", typeof ApiV1StatusIncidentsIncidentCode404.Type>>;
  /**
   * Create a new tenant (organization). Returns the tenant with a one-time
   * visible API key. Store this key securely - it cannot be retrieved again.
   */
  readonly createTenant: <Config extends OperationConfig>(options: {
    readonly payload: typeof CreateTenantRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<WithOptionalResponse<typeof CreateTenant201.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"CreateTenant400", typeof CreateTenant400.Type> | ChalkApiError<"CreateTenant500", typeof CreateTenant500.Type>>;
  /**
   * Retrieve tenant information by ID
   */
  readonly getTenant: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof GetTenant200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"GetTenant400", typeof GetTenant400.Type> | ChalkApiError<"GetTenant401", typeof GetTenant401.Type> | ChalkApiError<"GetTenant404", typeof GetTenant404.Type>>;
  /**
   * Delete a tenant and all associated data
   */
  readonly deleteTenant: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"DeleteTenant400", typeof DeleteTenant400.Type> | ChalkApiError<"DeleteTenant401", typeof DeleteTenant401.Type> | ChalkApiError<"DeleteTenant500", typeof DeleteTenant500.Type>>;
  /**
   * Update tenant settings and limits
   */
  readonly updateTenant: <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof UpdateTenantRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof UpdateTenant200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"UpdateTenant400", typeof UpdateTenant400.Type> | ChalkApiError<"UpdateTenant401", typeof UpdateTenant401.Type> | ChalkApiError<"UpdateTenant500", typeof UpdateTenant500.Type>
  >;
  /**
   * Update Tenant Runtime Config
   */
  readonly "PATCH/api/v1/tenants/{id}/config": <Config extends OperationConfig>(
    id: string,
    options: { readonly payload: typeof ApiV1TenantsIdConfigRequestJson.Encoded; readonly config?: Config | undefined },
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1TenantsIdConfig200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1TenantsIdConfig400", typeof ApiV1TenantsIdConfig400.Type>
    | ChalkApiError<"ApiV1TenantsIdConfig403", typeof ApiV1TenantsIdConfig403.Type>
    | ChalkApiError<"ApiV1TenantsIdConfig404", typeof ApiV1TenantsIdConfig404.Type>
    | ChalkApiError<"ApiV1TenantsIdConfig500", typeof ApiV1TenantsIdConfig500.Type>
  >;
  /**
   * Generate a new API key for the tenant. The old key is immediately
   * invalidated. Store the new key securely.
   */
  readonly rotateTenantApiKey: <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof RotateTenantApiKey200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"RotateTenantApiKey400", typeof RotateTenantApiKey400.Type> | ChalkApiError<"RotateTenantApiKey401", typeof RotateTenantApiKey401.Type> | ChalkApiError<"RotateTenantApiKey500", typeof RotateTenantApiKey500.Type>
  >;
  /**
   * Get Post-Meeting Transcript
   */
  readonly "GET/api/v1/transcription/{id}": <Config extends OperationConfig>(
    id: string,
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1TranscriptionId200.Type, Config>,
    HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1TranscriptionId400", typeof ApiV1TranscriptionId400.Type> | ChalkApiError<"ApiV1TranscriptionId401", typeof ApiV1TranscriptionId401.Type> | ChalkApiError<"ApiV1TranscriptionId404", typeof ApiV1TranscriptionId404.Type>
  >;
  /**
   * List Available Transcription Providers
   */
  readonly "GET/api/v1/transcription/providers": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof ApiV1TranscriptionProviders200.Type, Config>, HttpClientError.HttpClientError | SchemaError>;
  /**
   * Handle Cloudflare Transcription Callback
   */
  readonly "POST/api/v1/transcription/providers/cloudflare/callback": <Config extends OperationConfig>(options: {
    readonly payload: typeof ApiV1TranscriptionProvidersCloudflareCallbackRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof ApiV1TranscriptionProvidersCloudflareCallback200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"ApiV1TranscriptionProvidersCloudflareCallback400", typeof ApiV1TranscriptionProvidersCloudflareCallback400.Type>
    | ChalkApiError<"ApiV1TranscriptionProvidersCloudflareCallback401", typeof ApiV1TranscriptionProvidersCloudflareCallback401.Type>
    | ChalkApiError<"ApiV1TranscriptionProvidersCloudflareCallback503", typeof ApiV1TranscriptionProvidersCloudflareCallback503.Type>
  >;
  /**
   * Webhook endpoint for Cloudflare to notify when a recording is ready.
   * Downloads the recording and uploads it to R2 storage.
   */
  readonly handleRecordingReadyWebhook: <Config extends OperationConfig>(options: {
    readonly payload: typeof HandleRecordingReadyWebhookRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof HandleRecordingReadyWebhook200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"HandleRecordingReadyWebhook400", typeof HandleRecordingReadyWebhook400.Type>
    | ChalkApiError<"HandleRecordingReadyWebhook404", typeof HandleRecordingReadyWebhook404.Type>
    | ChalkApiError<"HandleRecordingReadyWebhook500", typeof HandleRecordingReadyWebhook500.Type>
  >;
  /**
   * Local endpoint for testing post-meeting webhook delivery.
   * Intended for self-calls in development/testing environments.
   */
  readonly handleLocalPostMeetingWebhook: <Config extends OperationConfig>(options: {
    readonly payload: typeof HandleLocalPostMeetingWebhookRequestJson.Encoded;
    readonly config?: Config | undefined;
  }) => Effect.Effect<
    WithOptionalResponse<typeof HandleLocalPostMeetingWebhook200.Type, Config>,
    | HttpClientError.HttpClientError
    | SchemaError
    | ChalkApiError<"HandleLocalPostMeetingWebhook400", typeof HandleLocalPostMeetingWebhook400.Type>
    | ChalkApiError<"HandleLocalPostMeetingWebhook401", typeof HandleLocalPostMeetingWebhook401.Type>
    | ChalkApiError<"HandleLocalPostMeetingWebhook404", typeof HandleLocalPostMeetingWebhook404.Type>
    | ChalkApiError<"HandleLocalPostMeetingWebhook500", typeof HandleLocalPostMeetingWebhook500.Type>
  >;
  /**
   * Get Latest Release Notes
   */
  readonly "GET/api/v1/whats-new": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1WhatsNew200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1WhatsNew404", typeof ApiV1WhatsNew404.Type> | ChalkApiError<"ApiV1WhatsNew502", typeof ApiV1WhatsNew502.Type>>;
  /**
   * List Release Notes
   */
  readonly "GET/api/v1/whats-new/releases": <Config extends OperationConfig>(
    options: { readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<typeof ApiV1WhatsNewReleases200.Type, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"ApiV1WhatsNewReleases404", typeof ApiV1WhatsNewReleases404.Type> | ChalkApiError<"ApiV1WhatsNewReleases502", typeof ApiV1WhatsNewReleases502.Type>>;
  /**
   * Returns the health status of the API
   */
  readonly healthCheck: <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof HealthCheck200.Type, Config>, HttpClientError.HttpClientError | SchemaError>;
  /**
   * WebSocket handshake endpoint. JWT token is provided via Sec-WebSocket-Protocol as token.<jwt> (preferred) or query param fallback.
   */
  readonly "GET/ws": <Config extends OperationConfig>(
    options: { readonly params?: typeof WsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined,
  ) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError | ChalkApiError<"Ws400", typeof Ws400.Type> | ChalkApiError<"Ws401", typeof Ws401.Type> | ChalkApiError<"Ws403", typeof Ws403.Type>>;
}

export interface ChalkApiError<Tag extends string, E> {
  readonly _tag: Tag;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly cause: E;
}

class ChalkApiErrorImpl extends Data.Error<{
  _tag: string;
  cause: any;
  request: HttpClientRequest.HttpClientRequest;
  response: HttpClientResponse.HttpClientResponse;
}> {}

export const ChalkApiError = <Tag extends string, E>(tag: Tag, cause: E, response: HttpClientResponse.HttpClientResponse): ChalkApiError<Tag, E> =>
  new ChalkApiErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any;
