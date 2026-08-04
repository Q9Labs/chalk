import { sha256 } from "@noble/hashes/sha2.js";
import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChalkChatMessage, type ChalkChatReadReceipt } from "../collaboration/types";
import type { ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, ChatUploadFile } from "./types";

export const MAX_CHAT_PAGE_SIZE = 100;
export const MAX_LOADED_CHAT_MESSAGES = 500;

const MAX_CHAT_TEXT_BYTES = 16_384;
const MAX_CHAT_TEXT_SCALARS = 4_000;
const encoder = new TextEncoder();
const allowedMimeTypes = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

export function validateChatMessage(input: ChatSendInput): string | null {
  const attachments = input.attachments ?? [];
  if (input.text.length === 0 && attachments.length === 0) return "A chat message requires text or an attachment";
  if (Array.from(input.text).length > MAX_CHAT_TEXT_SCALARS || encoder.encode(input.text).byteLength > MAX_CHAT_TEXT_BYTES) return `Chat text must not exceed ${MAX_CHAT_TEXT_SCALARS} characters or ${MAX_CHAT_TEXT_BYTES} bytes`;
  if (attachments.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) return `A chat message supports at most ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} attachments`;
  if (new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length) return "Chat attachment IDs must be unique";
  return attachments.map(validateChatAttachment).find((value): value is string => value !== null) ?? null;
}

export function validateChatUpload(file: ChatUploadFile, bytes: ArrayBuffer, clientAttachmentId: string): { readonly fileName: string; readonly mimeType: ChatAttachment["mimeType"] } | string {
  const fileName = "fileName" in file ? file.fileName : file.name;
  const mimeType = "mimeType" in file ? file.mimeType : file.type;
  const error = validateChatAttachment({ attachmentId: clientAttachmentId, fileName, mimeType: mimeType as ChatAttachment["mimeType"], byteLength: bytes.byteLength });
  return error ?? { fileName, mimeType: mimeType as ChatAttachment["mimeType"] };
}

export function chatDigest(bytes: ArrayBuffer): string {
  return Array.from(sha256(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function chatMessageFor(message: ChalkChatMessage): ChatMessage {
  return Object.freeze({ ...message, attachments: Object.freeze([...message.attachments]) });
}

export function chatReceiptFor(receipt: ChalkChatReadReceipt): ChatReadReceipt {
  return Object.freeze({ ...receipt });
}

export function mergeChatMessage(messages: readonly ChatMessage[], existing: ChatMessage, incoming: ChatMessage): readonly ChatMessage[] {
  if (sameChatMessage(existing, incoming)) return messages;
  return Object.freeze(
    messages
      .map((message) => (message === existing ? incoming : message))
      .sort((left, right) => compareChatSequence(left.sequence, right.sequence))
      .slice(-MAX_LOADED_CHAT_MESSAGES),
  );
}

export function compareChatSequence(left: string, right: string): number {
  if (left === right) return 0;
  if (!/^\d+$/u.test(left) || !/^\d+$/u.test(right)) return left < right ? -1 : 1;
  const normalizedLeft = left.replace(/^0+/u, "") || "0";
  const normalizedRight = right.replace(/^0+/u, "") || "0";
  return normalizedLeft.length === normalizedRight.length ? (normalizedLeft < normalizedRight ? -1 : 1) : normalizedLeft.length - normalizedRight.length;
}

function validateChatAttachment(attachment: ChatAttachment): string | null {
  const fileNameBytes = encoder.encode(attachment.fileName).byteLength;
  if (!attachment.attachmentId || fileNameBytes < 1 || fileNameBytes > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes) return "Chat attachment metadata is invalid";
  if (!Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 1 || attachment.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "Chat attachment metadata is invalid";
  return allowedMimeTypes.has(attachment.mimeType) ? null : "Chat attachment MIME type is not allowed";
}

function sameChatMessage(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.messageId === right.messageId &&
    left.clientMessageId === right.clientMessageId &&
    left.sequence === right.sequence &&
    left.participantId === right.participantId &&
    left.displayName === right.displayName &&
    left.text === right.text &&
    left.createdAt === right.createdAt &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => {
      const candidate = right.attachments[index];
      return candidate?.attachmentId === attachment.attachmentId && candidate.fileName === attachment.fileName && candidate.mimeType === attachment.mimeType && candidate.byteLength === attachment.byteLength;
    })
  );
}
