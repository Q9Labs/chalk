import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES } from "@q9labsai/chalk-client";
import type { ChalkChatAttachment, ChalkChatAttachmentMimeType, ChalkSessionStore } from "@q9labsai/chalk-client";

type ChatFiles = NonNullable<ChalkSessionStore["chatFiles"]>;

export interface UploadChatAttachmentOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly randomUUID?: () => string;
}

export async function uploadChatAttachment(file: File, chatFiles: ChatFiles, options: UploadChatAttachmentOptions = {}): Promise<ChalkChatAttachment> {
  if (!CHALK_CHAT_ATTACHMENT_MIME_TYPES.some((mimeType) => mimeType === file.type)) throw new Error(`${file.name} is not a supported chat attachment.`);
  if (file.size > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) throw new Error(`${file.name} is too large to attach.`);
  if (new TextEncoder().encode(file.name).byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes) throw new Error(`${file.name} has a file name that is too long.`);
  const bytes = await file.arrayBuffer();
  const sha256 = await digestSha256(bytes);
  const initiation = await chatFiles.initiateUpload({
    clientAttachmentId: options.randomUUID?.() ?? crypto.randomUUID(),
    fileName: file.name,
    mimeType: file.type as ChalkChatAttachmentMimeType,
    byteLength: file.size,
    sha256,
  });
  const response = await (options.fetch ?? fetch)(initiation.uploadUrl, {
    method: initiation.method,
    headers: initiation.headers,
    body: bytes,
  });
  if (!response.ok) throw new Error(`Attachment upload failed with HTTP ${response.status}.`);
  return chatFiles.finalizeUpload(initiation.uploadId);
}

async function digestSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
