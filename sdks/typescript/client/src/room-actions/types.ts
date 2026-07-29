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

export type ChalkChatMessage = {
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly sequence: string;
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly text: string;
  readonly createdAt: string;
};

export type ChalkPendingChatMessageState<TFailure> = {
  readonly clientMessageId: string;
  readonly text: string;
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
  readonly error: TFailure | null;
};

export type ChalkChatPageResult = { readonly status: "loaded"; readonly count: number; readonly hasOlder: boolean } | { readonly status: "cursor_reset"; readonly retainedFloorSequence: string };

export type ChalkSendChatMessageInput = {
  readonly text: string;
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
