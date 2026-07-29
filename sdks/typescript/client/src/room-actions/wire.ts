import type { SyncV3ServerFrame } from "../generated/sync-v3";
import type { ChalkChatMessage, ChalkRoomReaction } from "./types";

type RoomReactionFrame = Extract<SyncV3ServerFrame, { readonly type: "room_reaction" }>;
type ChatMessageFrame = Extract<SyncV3ServerFrame, { readonly type: "chat_message" }>;

export function roomReactionFromFrame(frame: RoomReactionFrame): ChalkRoomReaction {
  return {
    eventId: frame.event_id,
    participantSessionId: frame.participant_session_id,
    displayName: frame.display_name,
    reaction: frame.reaction,
    occurredAt: frame.occurred_at,
    expiresAt: frame.expires_at,
  };
}

export function chatMessageFromFrame(frame: ChatMessageFrame): ChalkChatMessage {
  return {
    messageId: frame.message_id,
    clientMessageId: frame.client_message_id,
    sequence: frame.sequence,
    participantSessionId: frame.participant_session_id,
    displayName: frame.display_name,
    text: frame.text,
    createdAt: frame.created_at,
  };
}
