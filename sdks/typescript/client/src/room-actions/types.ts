export type ChalkRoomActionsPhase = "disabled" | "negotiating" | "healthy" | "recovering" | "failed" | "stopped";

export type ChalkSyncV3RoomActionCapability = "sendReaction" | "sendChat";
export type ChalkWhiteboardV1Capability = "drawWhiteboard" | "manageWhiteboard";
export type ChalkRoomActionCapability = ChalkSyncV3RoomActionCapability | ChalkWhiteboardV1Capability;

export type ChalkParticipantMediaState = {
  readonly microphone: "active" | "inactive" | "unknown";
  readonly camera: "active" | "inactive" | "unknown";
  readonly screenShare: "active" | "inactive" | "unknown";
};

export type ChalkReaction = "👍" | "❤️" | "😂" | "😮" | "😢" | "🎉";

export type ChalkRoomReaction = {
  readonly eventId: string;
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly reaction: ChalkReaction;
  readonly occurredAt: string;
  readonly expiresAt: string;
};

export const CHALK_CHAT_ATTACHMENT_LIMITS = {
  maximumPerMessage: 5,
  maximumByteLength: 25 * 1024 * 1024,
  maximumFileNameBytes: 255,
} as const;

export const CHALK_CHAT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
] as const;

export type ChalkChatAttachmentMimeType = (typeof CHALK_CHAT_ATTACHMENT_MIME_TYPES)[number];

export type ChalkChatAttachment = {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: ChalkChatAttachmentMimeType;
  readonly byteLength: number;
};

export type ChalkChatReadReceipt = {
  readonly participantSessionId: string;
  readonly participantSessionGeneration: number;
  readonly readThroughSequence: string;
  readonly readAt: string;
};

export type ChalkChatMessage = {
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly sequence: string;
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: readonly ChalkChatAttachment[];
};

export type ChalkPendingChatMessageState<TFailure> = {
  readonly clientMessageId: string;
  readonly text: string;
  readonly attachments: readonly ChalkChatAttachment[];
  readonly state: "sending" | "failed";
  readonly error: TFailure | null;
};

export type ChalkChatStateSnapshot<TFailure, TPendingMessage> = {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly messages: readonly ChalkChatMessage[];
  readonly pending: readonly TPendingMessage[];
  readonly hasOlder: boolean;
  readonly historyTruncated: boolean;
  readonly retainedFloorSequence: string | null;
  readonly unreadCount: number;
  readonly readReceipts: readonly ChalkChatReadReceipt[];
  readonly localReadThroughSequence: string | null;
  readonly error: TFailure | null;
};

export type ChalkChatPageResult = { readonly status: "loaded"; readonly count: number; readonly hasOlder: boolean } | { readonly status: "cursor_reset"; readonly retainedFloorSequence: string };

export type ChalkSendChatMessageInput = {
  readonly text: string;
  readonly attachments?: readonly ChalkChatAttachment[];
  readonly clientMessageId?: string;
};

export type ChalkIncomingMediaRequest = {
  readonly requestId: string;
  readonly kind: "unmute" | "start_camera";
  readonly actorParticipantSessionId: string;
  readonly actorDisplayName: string | null;
  readonly expiresAt: string;
};

export type ChalkDirectedRequestResult =
  | { readonly status: "delivered"; readonly requestId: string }
  | {
      readonly status: "target_unavailable" | "expired" | "rejected" | "rate_limited";
      readonly requestId: string;
    };
