import type { ChalkChatAttachment, ChalkChatReadReceipt, ChalkParticipant, ChalkReaction } from "../client-compat";

export type Layout = "grid" | "focus" | "presentation";
export type NativePanel = "chat" | "participants" | "whiteboard" | null;
export type ParticipantGradientPreference = "auto" | "subtle" | "vivid" | "mono";

export type NativeParticipant = ChalkParticipant & {
  readonly id: string;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly audioTrack: MediaStreamTrack | null;
  readonly videoTrack: MediaStreamTrack | null;
  readonly screenShareTrack: MediaStreamTrack | null;
};

export type NativeParticipantState = {
  readonly participants: readonly NativeParticipant[];
  readonly localParticipant: NativeParticipant | null;
  readonly activeSpeaker: NativeParticipant | null;
  readonly count: number;
};

export type NativeChatMessage = {
  readonly id: string;
  readonly sequence: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly content: string;
  readonly attachments: readonly ChalkChatAttachment[];
  readonly readBy: readonly (ChalkChatReadReceipt & { readonly displayName: string })[];
  readonly timestamp: number;
};

export type NativeReaction = {
  readonly id: string;
  readonly emoji: ChalkReaction;
  readonly participantId: string;
  readonly participantName: string;
};
