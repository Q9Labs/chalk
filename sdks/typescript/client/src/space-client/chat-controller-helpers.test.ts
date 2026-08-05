import { describe, expect, it } from "vitest";
import type { ChalkChatMessage } from "../collaboration/types";
import { chatDigest, chatMessageFor, compareChatSequence, mergeChatMessage, validateChatMessage, validateChatUpload } from "./chat-controller-helpers";
import type { ChatAttachment, ChatMessage } from "./types";

const attachment: ChatAttachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 };

describe("ChatController helpers", () => {
  it("validates message and upload boundaries shared by send and files.upload", () => {
    expect(validateChatMessage({ text: "", attachments: [attachment] })).toBeNull();
    expect(validateChatMessage({ text: "" })).toBe("A chat message requires text or an attachment");
    expect(validateChatMessage({ text: "duplicate", attachments: [attachment, attachment] })).toBe("Chat attachment IDs must be unique");
    expect(validateChatMessage({ text: "unsupported", attachments: [{ ...attachment, mimeType: "application/octet-stream" as ChatAttachment["mimeType"] }] })).toBe("Chat attachment MIME type is not allowed");

    const bytes = new TextEncoder().encode("hello").buffer;
    expect(validateChatUpload({ fileName: "note.txt", mimeType: "text/plain", bytes }, bytes, "client-attachment")).toEqual({ fileName: "note.txt", mimeType: "text/plain" });
  });

  it("digests upload bytes and preserves canonical participant fields", () => {
    const bytes = new TextEncoder().encode("hello").buffer;
    expect(chatDigest(bytes)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

    const wireMessage: ChalkChatMessage = {
      messageId: "message-1",
      clientMessageId: "client-1",
      sequence: "7",
      participantId: "participant-1",
      displayName: "Ada",
      text: "hello",
      createdAt: "2026-08-04T12:00:00.000Z",
      attachments: [attachment],
    };
    expect(chatMessageFor(wireMessage)).toMatchObject({ participantId: "participant-1", attachments: [attachment] });
    expect(Object.isFrozen(chatMessageFor(wireMessage))).toBe(true);
  });

  it("deduplicates unchanged messages and orders numeric sequences without lexical drift", () => {
    expect(compareChatSequence("0009", "10")).toBe(-1);
    expect(compareChatSequence("10", "0009")).toBe(1);
    expect(compareChatSequence("alpha", "beta")).toBe(-1);

    const existing = chatMessage("9");
    const later = chatMessage("10");
    const messages = Object.freeze([existing, later]);
    expect(mergeChatMessage(messages, existing, existing)).toBe(messages);

    const replacement = chatMessage("9", "updated");
    expect(mergeChatMessage(messages, existing, replacement)).toEqual([replacement, later]);
  });
});

function chatMessage(sequence: string, text = `Message ${sequence}`): ChatMessage {
  return { messageId: `message-${sequence}`, clientMessageId: `client-${sequence}`, sequence, participantId: "participant-1", displayName: "Ada", text, createdAt: "2026-08-04T12:00:00.000Z", attachments: [] };
}
