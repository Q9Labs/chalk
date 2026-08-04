import type { ChatAttachment, ChatFilesController } from "../../client-compat";

export interface UploadChatAttachmentOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly randomUUID?: () => string;
}

export async function uploadChatAttachment(file: File, chatFiles: ChatFilesController, _options: UploadChatAttachmentOptions = {}): Promise<ChatAttachment> {
  return chatFiles.upload(file);
}
