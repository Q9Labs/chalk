import type { ChatAttachment, ChatFilesController } from "../client-compat";

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

export async function uploadChatAttachment(file: ChatAttachmentFile, chatFiles: ChatFilesController, _options: UploadChatAttachmentOptions = {}): Promise<ChatAttachment> {
  return chatFiles.upload(file);
}
