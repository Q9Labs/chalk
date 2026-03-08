import type { ChatMessage, Participant, Reaction, SessionSnapshot } from "../types.ts";
import type { ScreenAnnotationItem } from "../types/entities/annotations.ts";
import type {
  AnnotationAccessChangedPayload,
  AnnotationCursorPayload,
  AnnotationDataPayload,
  AnnotationSessionEndedPayload,
  AnnotationSessionStartedPayload,
  AnnotationSnapshotPayload,
  ChatMessagePayload,
  ParticipantJoinedPayload,
  ParticipantPayload,
  PermissionChangedPayload,
  ReactionPayload,
  RoomSnapshotPayload,
  WhiteboardClosedPayload,
  WhiteboardCursorPayload,
  WhiteboardDataPayload,
  WhiteboardOpenedPayload,
  WhiteboardSnapshotPayload,
} from "../effect/schemas/ws-events.ts";

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

export const unwrapParticipantJoined = (payload: ParticipantJoinedPayload) => ("participant" in payload ? payload.participant : payload);

export const toParticipant = (p: ParticipantPayload): Participant => ({
  id: p.id,
  displayName: p.displayName,
  role: p.role ?? "participant",
  isLocal: false,
  videoEnabled: p.videoEnabled ?? false,
  audioEnabled: p.audioEnabled ?? false,
  isSpeaking: p.isSpeaking ?? false,
  isScreenSharing: p.isScreenSharing ?? false,
  handRaised: p.handRaised ?? false,
  connectionQuality: p.connectionQuality ?? 100,
  joinedAt: p.joinedAt ? toDate(p.joinedAt) : undefined,
  metadata: p.metadata,
});

export const toSnapshot = (payload: RoomSnapshotPayload): SessionSnapshot => ({
  roomId: payload.roomId,
  participants: payload.participants.map(toParticipant),
  isRecording: payload.isRecording,
  recordingId: payload.recordingId,
  lastSeq: payload.lastSeq,
  messages: payload.messages?.map(toChatMessage),
});

export const toChatMessage = (payload: ChatMessagePayload): ChatMessage => ({
  id: payload.id,
  senderId: payload.participantId,
  senderName: payload.displayName,
  content: payload.content,
  timestamp: new Date(payload.timestamp),
  attachments: payload.attachments?.map((attachment) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
  })),
  readBy: payload.readBy?.map((receipt) => ({
    participantId: receipt.participantId,
    displayName: receipt.displayName,
    readAt: new Date(receipt.readAt),
  })),
});

export const toReaction = (payload: ReactionPayload): Reaction => ({
  participantId: payload.participantId,
  participantName: payload.participantName ?? "Unknown",
  emoji: payload.emoji as Reaction["emoji"],
  timestamp: toDate(payload.timestamp),
});

export const toWhiteboardData = (payload: WhiteboardDataPayload) => ({
  ...payload,
  elements: payload.elements as unknown[],
  files: payload.files as Record<string, unknown> | undefined,
  timestamp: toDate(payload.timestamp),
});

export const toWhiteboardSnapshot = (payload: WhiteboardSnapshotPayload) => ({
  ...payload,
  elements: payload.elements as unknown[],
  files: payload.files as Record<string, unknown>,
  appState: payload.appState,
});

export const toWhiteboardCursor = (payload: WhiteboardCursorPayload) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});

export const toPermissionChanged = (payload: PermissionChangedPayload) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});

export const toWhiteboardOpened = (payload: WhiteboardOpenedPayload) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});

export const toWhiteboardClosed = (payload: WhiteboardClosedPayload) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});

export const toAnnotationSessionStarted = (
  payload: AnnotationSessionStartedPayload,
) => ({
  shareSessionId: payload.shareSessionId,
  sharerParticipantId: payload.sharerParticipantId,
  accessMode: payload.accessMode,
});

export const toAnnotationSessionEnded = (
  payload: AnnotationSessionEndedPayload,
) => ({
  shareSessionId: payload.shareSessionId,
  endedAt: toDate(payload.timestamp),
});

export const toAnnotationSnapshot = (payload: AnnotationSnapshotPayload) => ({
  ...payload,
  items: payload.items as ScreenAnnotationItem[],
});

export const toAnnotationUpdate = (payload: AnnotationDataPayload) => ({
  ...payload,
  items: payload.items as ScreenAnnotationItem[],
  timestamp: toDate(payload.timestamp),
});

export const toAnnotationCursor = (payload: AnnotationCursorPayload) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});

export const toAnnotationAccessChanged = (
  payload: AnnotationAccessChangedPayload,
) => ({
  ...payload,
  timestamp: toDate(payload.timestamp),
});
