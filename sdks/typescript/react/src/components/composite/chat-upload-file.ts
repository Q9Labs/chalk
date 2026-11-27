import { CHALK_CHAT_ATTACHMENT_LIMITS, CHALK_CHAT_ATTACHMENT_MIME_TYPES, resolveFileMimeType, type ChatUploadFile } from "@q9labsai/chalk-client";

export interface ChatUploadFileDescription {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export function describeChatUploadFile(file: ChatUploadFile): ChatUploadFileDescription {
  if ("arrayBuffer" in file) return { fileName: file.name, mimeType: resolveFileMimeType(file.name, file.type), byteLength: file.size };
  return { fileName: file.fileName, mimeType: resolveFileMimeType(file.fileName, file.mimeType), byteLength: file.bytes.byteLength };
}

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

export interface ChatAttachmentBatch {
  readonly accepted: readonly ChatUploadFile[];
  readonly emptyCount: number;
  readonly overflowCount: number;
  readonly invalid?: ChatUploadFileDescription;
}

/** Selects the files one composer message can carry, skipping empty files and overflow without rejecting the valid rest. */
export function prepareChatAttachmentBatch(files: FileList | readonly ChatUploadFile[], stagedCount: number): ChatAttachmentBatch {
  const selected: ChatUploadFile[] = Array.from(files);
  const nonEmpty = selected.filter((file) => describeChatUploadFile(file).byteLength > 0);
  const capacity = Math.max(0, CHALK_CHAT_ATTACHMENT_LIMITS.maximumPerMessage - stagedCount);
  const accepted = nonEmpty.slice(0, capacity);
  const invalidFile = accepted.find((file) => {
    const description = describeChatUploadFile(file);
    const fileNameBytes = new TextEncoder().encode(description.fileName).byteLength;
    return !description.fileName || !Number.isSafeInteger(description.byteLength) || description.byteLength > CHALK_CHAT_ATTACHMENT_LIMITS.maximumByteLength || fileNameBytes > CHALK_CHAT_ATTACHMENT_LIMITS.maximumFileNameBytes || !ALLOWED_ATTACHMENT_MIME_TYPES.has(description.mimeType);
  });
  return {
    accepted,
    emptyCount: selected.length - nonEmpty.length,
    overflowCount: nonEmpty.length - accepted.length,
    invalid: invalidFile ? describeChatUploadFile(invalidFile) : undefined,
  };
}
