export interface ChatAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  url?: string;
  kind?: "image" | "document" | "file";
}

export interface ChatReadReceipt {
  participantId: string;
  displayName: string;
  readAt: Date;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  isLocal?: boolean;
  attachments?: ChatAttachment[];
  readBy?: ChatReadReceipt[];
}
