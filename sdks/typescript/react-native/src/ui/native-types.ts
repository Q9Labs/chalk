import type { ChatAttachment, ChatReadReceipt, Participant, Reaction } from "@q9labsai/chalk-client";

export type Layout = "grid" | "focus" | "presentation";
export type NativePanel = "chat" | "participants" | "whiteboard" | null;
export type ParticipantGradientPreference = "auto" | "subtle" | "vivid" | "mono";

export type NativeParticipant = Participant & {
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
  readonly attachments: readonly ChatAttachment[];
  readonly readBy: readonly (ChatReadReceipt & { readonly displayName: string })[];
  readonly timestamp: number;
};

export type NativeReaction = {
  readonly id: string;
  readonly emoji: Reaction;
  readonly participantId: string;
  readonly participantName: string;
};
