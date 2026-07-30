import type { SyncV3ServerFrame } from "../generated/sync-v3";
import type { ChalkChatMessage, ChalkChatReadReceipt, ChalkRoomReaction } from "./types";

type RoomReactionFrame = Extract<SyncV3ServerFrame, { readonly type: "room_reaction" }>;
type ChatMessageFrame = Extract<SyncV3ServerFrame, { readonly type: "chat_message" }>;
type ChatReadReceiptFrame = Extract<SyncV3ServerFrame, { readonly type: "chat_read_receipt" }> | Extract<SyncV3ServerFrame, { readonly type: "chat_read_result"; readonly outcome: "accepted" }>;

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
    attachments:
      "attachments" in frame
        ? frame.attachments.map((attachment) => ({
            attachmentId: attachment.attachment_id,
            fileName: attachment.file_name,
            mimeType: attachment.mime_type,
            byteLength: attachment.byte_length,
          }))
        : [],
  };
}

export function chatReadReceiptFromFrame(frame: ChatReadReceiptFrame): ChalkChatReadReceipt {
  return {
    participantSessionId: frame.participant_session_id,
    participantSessionGeneration: frame.participant_session_generation,
    readThroughSequence: frame.sequence,
    readAt: frame.read_at,
  };
}
