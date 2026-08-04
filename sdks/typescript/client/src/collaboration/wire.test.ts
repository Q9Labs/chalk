import { describe, expect, it } from "vitest";
import { chatMessageFromFrame, chatReadReceiptFromFrame, reactionFromFrame } from "./wire";

const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const eventId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const clientMessageId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";

describe("collaboration wire projections", () => {
  it("projects server-stamped reactions without retaining wire names", () => {
    expect(
      reactionFromFrame({
        type: "reaction",
        event_id: eventId,
        participant_id: participantId,
        display_name: "Ada",
        reaction: "🎉",
        occurred_at: "2026-07-29T12:00:00.000Z",
        expires_at: "2026-07-29T12:00:05.000Z",
      }),
    ).toEqual({
      eventId,
      participantId,
      displayName: "Ada",
      reaction: "🎉",
      occurredAt: "2026-07-29T12:00:00.000Z",
      expiresAt: "2026-07-29T12:00:05.000Z",
    });
  });

  it("keeps unsigned decimal chat sequences as strings", () => {
    expect(
      chatMessageFromFrame({
        type: "chat_message",
        message_id: eventId,
        client_message_id: clientMessageId,
        sequence: "18446744073709551615",
        participant_id: participantId,
        display_name: "Ada",
        text: "Hello",
        created_at: "2026-07-29T12:00:00.000Z",
      }),
    ).toEqual({
      messageId: eventId,
      clientMessageId,
      sequence: "18446744073709551615",
      participantId,
      displayName: "Ada",
      text: "Hello",
      createdAt: "2026-07-29T12:00:00.000Z",
      attachments: [],
    });
  });

  it("projects ordered attachment metadata and generation-scoped read receipts", () => {
    const attachmentId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24";
    expect(
      chatMessageFromFrame({
        type: "chat_message",
        message_id: eventId,
        client_message_id: clientMessageId,
        sequence: "9",
        participant_id: participantId,
        display_name: "Ada",
        text: "",
        attachments: [{ attachment_id: attachmentId, file_name: "notes.txt", mime_type: "text/plain", byte_length: 128 }],
        created_at: "2026-07-29T12:00:00.000Z",
      }),
    ).toMatchObject({
      attachments: [{ attachmentId, fileName: "notes.txt", mimeType: "text/plain", byteLength: 128 }],
    });
    expect(
      chatReadReceiptFromFrame({
        type: "chat_read_receipt",
        participant_id: participantId,
        participant_generation: 2,
        sequence: "9",
        read_at: "2026-07-29T12:01:00.000Z",
      }),
    ).toEqual({
      participantId,
      participantGeneration: 2,
      readThroughSequence: "9",
      readAt: "2026-07-29T12:01:00.000Z",
    });
  });
});
