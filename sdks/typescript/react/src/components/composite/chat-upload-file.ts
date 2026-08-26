import type { ChatUploadFile } from "@q9labsai/chalk-client";

export interface ChatUploadFileDescription {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export function describeChatUploadFile(file: ChatUploadFile): ChatUploadFileDescription {
  if ("arrayBuffer" in file) {
    return { fileName: file.name, mimeType: file.type, byteLength: file.size };
  }
  return { fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
}
