import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatAttachment, type ChatSendInput, type ChatUploadFile } from "@q9labsai/chalk-client";

const allowedMimeTypes = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);
const encoder = new TextEncoder();

export interface NativeChatFileDraft {
  readonly file: ChatUploadFile;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export function describeChatUploadFile(file: ChatUploadFile): NativeChatFileDraft {
  if ("bytes" in file) {
    return { file, fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
  }
  return { file, fileName: file.name, mimeType: file.type, byteLength: file.size };
}

export function validateChatFileDraft(draft: NativeChatFileDraft): string | null {
  if (!draft.fileName || encoder.encode(draft.fileName).byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes) return "This file name is too long.";
  if (!Number.isSafeInteger(draft.byteLength) || draft.byteLength < 1 || draft.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength) return "This file is too large or empty.";
  if (!allowedMimeTypes.has(draft.mimeType)) return "This file type is not supported in Space chat.";
  return null;
}

export function normalizeChatFileDrafts(files: readonly ChatUploadFile[]): { readonly files: readonly NativeChatFileDraft[]; readonly error: string | null } {
  if (files.length > CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage) {
    return { files: [], error: `You can attach up to ${CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage} files per message.` };
  }
  const drafts = files.map(describeChatUploadFile);
  const error = drafts.map(validateChatFileDraft).find((message): message is string => message !== null) ?? null;
  return error ? { files: [], error } : { files: drafts, error: null };
}

export async function uploadAndSendNativeChatAttachments(files: readonly NativeChatFileDraft[], text: string, upload: (file: ChatUploadFile) => Promise<ChatAttachment>, send: (input: ChatSendInput) => Promise<unknown>): Promise<void> {
  const attachments = await Promise.all(files.map((draft) => upload(draft.file)));
  await send({ text, ...(attachments.length ? { attachments } : {}) });
}
