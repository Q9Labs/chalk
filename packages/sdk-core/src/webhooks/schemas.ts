/**
 * Webhook payload schemas for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import { Schema } from "@effect/schema";

/**
 * Meeting info in webhook payload
 */
export const WebhookMeeting = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.String,
  duration_seconds: Schema.Number,
  participant_count: Schema.Number,
});

/**
 * Participant info included in webhook payload
 */
export const WebhookParticipant = Schema.Struct({
  id: Schema.String,
  external_user_id: Schema.optional(Schema.NullOr(Schema.String)),
  external_id: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.String,
  role: Schema.String,
  joined_at: Schema.String,
  left_at: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

/**
 * Recording info (optional based on include_recording)
 */
export const WebhookRecording = Schema.Struct({
  id: Schema.String,
  duration_seconds: Schema.Number,
  size_bytes: Schema.Number,
  download_url: Schema.String,
  download_api: Schema.String,
  expires_at: Schema.String,
});

/**
 * Transcript segment with timing info
 */
export const TranscriptSegment = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
});

/**
 * Transcript info (optional based on include_transcript)
 */
export const WebhookTranscript = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  word_count: Schema.Number,
  language: Schema.String,
  provider: Schema.String,
  segments: Schema.optional(Schema.Array(TranscriptSegment)),
});

/**
 * Error info for graceful degradation
 */
export const WebhookError = Schema.Struct({
  field: Schema.String,
  code: Schema.String,
  message: Schema.String,
});

/**
 * Main webhook payload for meeting.recording_ready event
 */
export const WebhookPayload = Schema.Struct({
  event: Schema.Literal("meeting.recording_ready"),
  timestamp: Schema.String,
  meeting: WebhookMeeting,
  participants: Schema.optional(Schema.Array(WebhookParticipant)),
  recording: Schema.optional(Schema.NullOr(WebhookRecording)),
  transcript: Schema.optional(Schema.NullOr(WebhookTranscript)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  action_items: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  errors: Schema.optional(Schema.Array(WebhookError)),
});

/**
 * Parses JSON string AND validates against WebhookPayload in one step.
 * Replaces manual JSON.parse() + Schema.decodeUnknownSync().
 */
export const WebhookPayloadFromJson = Schema.parseJson(WebhookPayload);
