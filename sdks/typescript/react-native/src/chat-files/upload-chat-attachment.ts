import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChalkChatAttachment, type ChalkChatAttachmentMimeType, type ChalkSessionStore } from "@q9labsai/chalk-client";

type ChatFiles = NonNullable<ChalkSessionStore["chatFiles"]>;

export interface ChatAttachmentFile {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly mimeType: string;
}

export interface UploadChatAttachmentOptions {
  readonly digestSha256?: (bytes: ArrayBuffer) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly randomUUID?: () => string;
}

export async function uploadChatAttachment(file: ChatAttachmentFile, chatFiles: ChatFiles, options: UploadChatAttachmentOptions = {}): Promise<ChalkChatAttachment> {
  const mimeType = allowedMimeType(file.mimeType);
  const byteLength = file.bytes.byteLength;
  if (byteLength < 1 || byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) {
    throw new Error(`${file.fileName} must be smaller than 25 MB.`);
  }
  if (new TextEncoder().encode(file.fileName).byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes) {
    throw new Error(`${file.fileName} has a file name that is too long.`);
  }

  const initiation = await chatFiles.initiateUpload({
    clientAttachmentId: options.randomUUID?.() ?? requireRandomUUID(),
    fileName: file.fileName,
    mimeType,
    byteLength,
    sha256: await (options.digestSha256 ?? digestSha256)(file.bytes),
  });
  const response = await (options.fetch ?? globalThis.fetch)(initiation.uploadUrl, {
    method: initiation.method,
    headers: initiation.headers,
    body: file.bytes,
  });
  if (!response.ok) throw new Error(`Attachment upload failed with HTTP ${response.status}.`);
  return chatFiles.finalizeUpload(initiation.uploadId);
}

function allowedMimeType(value: string): ChalkChatAttachmentMimeType {
  const mimeType = CHALK_CHAT_ATTACHMENT_MIME_TYPES.find((candidate) => candidate === value);
  if (!mimeType) throw new Error("This file type is not supported for chat attachments.");
  return mimeType;
}

async function digestSha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this React Native runtime.");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireRandomUUID(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value) throw new Error("Secure UUID generation is unavailable in this React Native runtime.");
  return value;
}
