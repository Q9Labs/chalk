import type { ChatAttachment, ChatMessage, ChatReadReceipt, ChatUploadFile } from "@q9labsai/chalk-client";

export type { ChatAttachment, ChatMessage, ChatReadReceipt };

export interface ChatPanelFileDrop {
  readonly files: readonly ChatUploadFile[];
}
