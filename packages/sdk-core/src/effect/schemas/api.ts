/**
 * @effect/schema definitions for API response payloads
 *
 * Provides runtime validation for all API responses.
 * Replaces type assertions with proper validation.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

import { Schema } from "@effect/schema";

/**
 * API error schema
 */
export const ApiErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type ApiError = Schema.Schema.Type<typeof ApiErrorSchema>;

/**
 * Generic API response wrapper
 */
export const ApiResponse = <A, I, R>(dataSchema: Schema.Schema<A, I, R>) =>
  Schema.Union(
    Schema.Struct({
      success: Schema.Literal(true),
      data: dataSchema,
    }),
    Schema.Struct({
      success: Schema.Literal(false),
      error: ApiErrorSchema,
    })
  );

/**
 * Room info schema
 */
export const RoomInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});
export type RoomInfo = Schema.Schema.Type<typeof RoomInfoSchema>;

/**
 * Token set schema
 */
export const TokenSetSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  rtcToken: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
});
export type TokenSet = Schema.Schema.Type<typeof TokenSetSchema>;

/**
 * Create room response schema
 */
export const CreateRoomResponseSchema = Schema.Struct({
  roomId: Schema.String,
  name: Schema.optional(Schema.String),
});
export type CreateRoomResponse = Schema.Schema.Type<typeof CreateRoomResponseSchema>;

/**
 * Join room response schema (transformed from snake_case)
 */
export const JoinRoomResponseSchema = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  participantId: Schema.String,
  role: Schema.optional(Schema.Union(Schema.Literal("host"), Schema.Literal("participant"))),
  // Token fields - API may return different field names
  accessToken: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  authToken: Schema.String, // RTC token
  token: Schema.optional(Schema.String), // Demo mode token
  expiresAt: Schema.optional(Schema.Number),
  room: RoomInfoSchema,
});
export type JoinRoomResponse = Schema.Schema.Type<typeof JoinRoomResponseSchema>;

/**
 * Raw join room response (snake_case from Go API)
 */
export const RawJoinRoomResponseSchema = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  room_id: Schema.optional(Schema.String),
  participant_id: Schema.String,
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  auth_token: Schema.String,
  token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
  room: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
});
export type RawJoinRoomResponse = Schema.Schema.Type<typeof RawJoinRoomResponseSchema>;

/**
 * Recording schema
 */
export const RecordingSchema = Schema.Struct({
  id: Schema.String,
  roomId: Schema.String,
  status: Schema.Union(
    Schema.Literal("pending"),
    Schema.Literal("recording"),
    Schema.Literal("processing"),
    Schema.Literal("ready"),
    Schema.Literal("archived"),
    Schema.Literal("failed"),
    Schema.Literal("deleted")
  ),
  durationSeconds: Schema.optional(Schema.Number),
  sizeBytes: Schema.optional(Schema.Number),
  downloadUrl: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
});
export type Recording = Schema.Schema.Type<typeof RecordingSchema>;

/**
 * Start recording response
 */
export const StartRecordingResponseSchema = Schema.Struct({
  recordingId: Schema.String,
});
export type StartRecordingResponse = Schema.Schema.Type<typeof StartRecordingResponseSchema>;

/**
 * Download URL response
 */
export const DownloadUrlResponseSchema = Schema.Struct({
  url: Schema.String,
});
export type DownloadUrlResponse = Schema.Schema.Type<typeof DownloadUrlResponseSchema>;

/**
 * Participant role schema
 */
export const ParticipantRoleSchema = Schema.Union(
  Schema.Literal("host"),
  Schema.Literal("participant")
);
export type ParticipantRole = Schema.Schema.Type<typeof ParticipantRoleSchema>;

/**
 * Room status schema
 */
export const RoomStatusSchema = Schema.Union(
  Schema.Literal("connecting"),
  Schema.Literal("connected"),
  Schema.Literal("reconnecting"),
  Schema.Literal("disconnected"),
  Schema.Literal("failed")
);
export type RoomStatus = Schema.Schema.Type<typeof RoomStatusSchema>;

/**
 * Decode helper - validates unknown input against schema
 */
export const decode = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(schema);

/**
 * Decode with Effect - returns Effect<A, ParseError>
 */
export const decodeEffect = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(schema);

/**
 * Encode helper - converts typed value to serializable form
 */
export const encode = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.encode(schema);
