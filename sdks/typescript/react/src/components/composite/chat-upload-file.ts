import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatUploadFile } from "@q9labsai/chalk-client";

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

export interface ChatUploadFileDescription {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

function isUnsupportedChatUpload(file: ChatUploadFile): boolean {
  const { fileName, mimeType, byteLength } = describeChatUploadFile(file);
  const fileNameBytes = new TextEncoder().encode(fileName).byteLength;
  return !fileName || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength || fileNameBytes > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes || !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType);
}

/** Why the composer refuses these files, or undefined when it accepts them. */
export function chatAttachmentRefusal(stagedCount: number, files: readonly ChatUploadFile[]): string | undefined {
  if (stagedCount + files.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) return `You can attach up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files.`;
  const invalid = files.find(isUnsupportedChatUpload);
  return invalid ? `${describeChatUploadFile(invalid).fileName} is not a supported chat attachment.` : undefined;
}

export function describeChatUploadFile(file: ChatUploadFile): ChatUploadFileDescription {
  if ("arrayBuffer" in file) return { fileName: file.name, mimeType: file.type, byteLength: file.size };
  return { fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
}
