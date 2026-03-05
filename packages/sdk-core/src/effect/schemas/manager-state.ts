/**
 * Effect Schema definitions for manager state types
 *
 * Single source of truth - types are inferred from schemas.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/effect/schemas
 */

import { Schema } from "@effect/schema";

// ============================================================================
// ConferenceSession Manager Schemas
// ============================================================================

/** ConferenceSession connection status */
export const RoomStatusSchema = Schema.Literal(
  "connecting",
  "connected",
  "reconnecting",
  "disconnected",
  "failed"
);

/** ConferenceSession state schema */
export const RoomStateSchema = Schema.Struct({
  status: RoomStatusSchema,
  roomId: Schema.NullOr(Schema.String),
  roomName: Schema.NullOr(Schema.String),
  isJoining: Schema.Boolean,
  hostId: Schema.NullOr(Schema.String),
});

/** ConferenceSession event schemas */
export const RoomConnectedEvent = Schema.Struct({
  _tag: Schema.Literal("Connected"),
  roomId: Schema.String,
});

export const RoomDisconnectedEvent = Schema.Struct({
  _tag: Schema.Literal("Disconnected"),
  reason: Schema.String,
});

export const RoomStatusChangedEvent = Schema.Struct({
  _tag: Schema.Literal("StatusChanged"),
  status: RoomStatusSchema,
});

export const RoomEndedEvent = Schema.Struct({
  _tag: Schema.Literal("RoomEnded"),
  reason: Schema.String,
});

export const RoomErrorEvent = Schema.Struct({
  _tag: Schema.Literal("Error"),
  error: Schema.Unknown,
});

export const RoomEventSchema = Schema.Union(
  RoomConnectedEvent,
  RoomDisconnectedEvent,
  RoomStatusChangedEvent,
  RoomEndedEvent,
  RoomErrorEvent
);

// ============================================================================
// Participant Manager Schemas
// ============================================================================

/** Participant role schema */
export const ParticipantRoleSchema = Schema.Literal("host", "participant");

/** MediaStreamTrack schema (opaque type for browser API) */
const MediaStreamTrackSchema = Schema.declare(
  (input): input is MediaStreamTrack =>
    typeof MediaStreamTrack !== "undefined" && input instanceof MediaStreamTrack
);

/** Participant schema (minimal for state) */
export const ParticipantSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  role: ParticipantRoleSchema,
  isLocal: Schema.Boolean,
  videoEnabled: Schema.Boolean,
  audioEnabled: Schema.Boolean,
  isScreenSharing: Schema.Boolean,
  isSpeaking: Schema.Boolean,
  handRaised: Schema.Boolean,
  connectionQuality: Schema.Number,
  videoTrack: Schema.optional(Schema.Union(MediaStreamTrackSchema, Schema.Undefined)),
  audioTrack: Schema.optional(Schema.Union(MediaStreamTrackSchema, Schema.Undefined)),
  screenShareTrack: Schema.optional(Schema.Union(MediaStreamTrackSchema, Schema.Undefined)),
  screenShareAudioTrack: Schema.optional(Schema.Union(MediaStreamTrackSchema, Schema.Undefined)),
  joinedAt: Schema.optional(Schema.DateFromSelf),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

/** Participant state schema */
export const ParticipantStateSchema = Schema.Struct({
  participants: Schema.Array(ParticipantSchema),
  activeSpeaker: Schema.NullOr(ParticipantSchema),
  localParticipant: Schema.NullOr(ParticipantSchema),
  count: Schema.Number,
});

/** Participant event schemas */
export const ParticipantJoinedEvent = Schema.Struct({
  _tag: Schema.Literal("Joined"),
  participant: ParticipantSchema,
});

export const ParticipantLeftEvent = Schema.Struct({
  _tag: Schema.Literal("Left"),
  participantId: Schema.String,
});

export const ParticipantUpdatedEvent = Schema.Struct({
  _tag: Schema.Literal("Updated"),
  participantId: Schema.String,
  participant: ParticipantSchema,
});

export const ActiveSpeakerChangedEvent = Schema.Struct({
  _tag: Schema.Literal("ActiveSpeakerChanged"),
  participant: Schema.NullOr(ParticipantSchema),
});

export const ParticipantEventSchema = Schema.Union(
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  ParticipantUpdatedEvent,
  ActiveSpeakerChangedEvent
);

// ============================================================================
// Media Manager Schemas
// ============================================================================

/** Media device schema */
export const MediaDeviceSchema = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  kind: Schema.Literal("videoinput", "audioinput", "audiooutput"),
});

/** Media state schema */
export const MediaStateSchema = Schema.Struct({
  isVideoEnabled: Schema.Boolean,
  isAudioEnabled: Schema.Boolean,
  isTogglingVideo: Schema.Boolean,
  isTogglingAudio: Schema.Boolean,
  selectedCamera: Schema.NullOr(Schema.String),
  selectedMicrophone: Schema.NullOr(Schema.String),
  selectedSpeaker: Schema.NullOr(Schema.String),
  devices: Schema.Array(MediaDeviceSchema),
});

/** Media event schemas */
export const VideoChangedEvent = Schema.Struct({
  _tag: Schema.Literal("VideoChanged"),
  enabled: Schema.Boolean,
  track: Schema.Unknown,
});

export const AudioChangedEvent = Schema.Struct({
  _tag: Schema.Literal("AudioChanged"),
  enabled: Schema.Boolean,
  track: Schema.Unknown,
});

export const DevicesChangedEvent = Schema.Struct({
  _tag: Schema.Literal("DevicesChanged"),
  devices: Schema.Array(MediaDeviceSchema),
});

export const MediaErrorEvent = Schema.Struct({
  _tag: Schema.Literal("MediaError"),
  error: Schema.Unknown,
});

export const MediaEventSchema = Schema.Union(
  VideoChangedEvent,
  AudioChangedEvent,
  DevicesChangedEvent,
  MediaErrorEvent
);

// ============================================================================
// Inferred Types (single source of truth)
// ============================================================================

export type SessionConnectionState = Schema.Schema.Type<typeof RoomStatusSchema>;
export type RoomState = Schema.Schema.Type<typeof RoomStateSchema>;
export type RoomEvent = Schema.Schema.Type<typeof RoomEventSchema>;

export type ParticipantData = Schema.Schema.Type<typeof ParticipantSchema>;
export type ParticipantState = Schema.Schema.Type<typeof ParticipantStateSchema>;
export type ParticipantEvent = Schema.Schema.Type<typeof ParticipantEventSchema>;

export type MediaDeviceData = Schema.Schema.Type<typeof MediaDeviceSchema>;
export type MediaState = Schema.Schema.Type<typeof MediaStateSchema>;
export type MediaEvent = Schema.Schema.Type<typeof MediaEventSchema>;
