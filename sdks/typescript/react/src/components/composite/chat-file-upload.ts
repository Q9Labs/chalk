import type { ChatAttachment, ChatFilesController, ChatUploadFile } from "@q9labsai/chalk-client";

export interface UploadChatAttachmentOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly randomUUID?: () => string;
}

export async function uploadChatAttachment(file: ChatUploadFile, chatFiles: ChatFilesController, _options: UploadChatAttachmentOptions = {}): Promise<ChatAttachment> {
  return chatFiles.upload(file);
}
