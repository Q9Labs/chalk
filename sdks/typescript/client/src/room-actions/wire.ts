import type { SyncV1ServerFrame } from "../generated/sync";
import type { ChalkChatMessage, ChalkChatReadReceipt, ChalkRoomReaction } from "./types";

type ReactionFrame = Extract<SyncV1ServerFrame, { readonly type: "reaction" }>;
type ChatMessageFrame = Extract<SyncV1ServerFrame, { readonly type: "chat_message" }>;
type ChatReadReceiptFrame = Extract<SyncV1ServerFrame, { readonly type: "chat_read_receipt" }> | Extract<SyncV1ServerFrame, { readonly type: "chat_read_result"; readonly outcome: "accepted" }>;

export function roomReactionFromFrame(frame: ReactionFrame): ChalkRoomReaction {
  const legacy = frame as ReactionFrame & { readonly participant_session_id?: string };
  return {
    eventId: frame.event_id,
    participantSessionId: frame.participant_id ?? legacy.participant_session_id!,
    displayName: frame.display_name,
    reaction: frame.reaction,
    occurredAt: frame.occurred_at,
    expiresAt: frame.expires_at,
  };
}

export function chatMessageFromFrame(frame: ChatMessageFrame): ChalkChatMessage {
  const legacy = frame as ChatMessageFrame & { readonly participant_session_id?: string };
  return {
    messageId: frame.message_id,
    clientMessageId: frame.client_message_id,
    sequence: frame.sequence,
    participantSessionId: frame.participant_id ?? legacy.participant_session_id!,
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
  const legacy = frame as ChatReadReceiptFrame & {
    readonly participant_session_id?: string;
    readonly participant_session_generation?: number;
  };
  return {
    participantSessionId: frame.participant_id ?? legacy.participant_session_id!,
    participantSessionGeneration: frame.participant_generation ?? legacy.participant_session_generation!,
    readThroughSequence: frame.sequence,
    readAt: frame.read_at,
  };
}
