/**
 * Entity type exports for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types/entities
 */

export type { AudioLevel, MediaDevice, MediaDeviceKind, ScreenShareOptions, Track, TrackKind, TrackSource, VideoBackgroundEffect, VideoBackgroundMode } from "./media";
export type { ChatMessage, MessageReaction, Reaction, ReactionEmoji } from "./message";
export type { ConnectionQuality, Participant, ParticipantInfo, ParticipantRole } from "./participant";
export type { Recording, RecordingStatus, StorageProvider } from "./recording";
export type { JoinOptions, LeaveOptions, ConferenceSession, JoinSessionConfig, SessionConnectionState } from "./room";
export type {
  AnnotationAccessMode,
  ScreenAnnotationAccessMode,
  ScreenAnnotationAccessChanged,
  ScreenAnnotationAccessChange,
  ScreenAnnotationCursor,
  ScreenAnnotationFreehandItem,
  ScreenAnnotationItem,
  ScreenAnnotationPoint,
  ScreenAnnotationSession,
  ScreenAnnotationSessionEnded,
  ScreenAnnotationSessionStarted,
  ScreenAnnotationShape,
  ScreenAnnotationShapeKind,
  ScreenAnnotationShapeItem,
  ScreenAnnotationSnapshot,
  ScreenAnnotationStyle,
  ScreenAnnotationTextItem,
  ScreenAnnotationTool,
  ScreenAnnotationUpdate,
} from "./annotations";
export type { WhiteboardCursor, WhiteboardFeature, WhiteboardPermission, WhiteboardSnapshot, WhiteboardUpdate } from "./whiteboard";
