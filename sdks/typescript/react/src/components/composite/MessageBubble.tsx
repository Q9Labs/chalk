import type { ChatAttachment, ChatReadReceipt } from "@q9labsai/chalk-client";
import React from "react";
import { ClassicMessageBubble } from "./ClassicMessageBubble";

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: string;
  /** Frozen display text for deterministic projections; live views format timestamp locally. */
  displayTime?: string;
  /** Stable message identity for deterministic Chalk chrome across projection seeks. */
  seed?: number | string;
  /** Stable participant identity for the sender avatar's Chalk chrome. */
  avatarSeed?: number | string;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  showAvatar?: boolean;
  generatedAvatars?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  status?: "queued" | "pending" | "sent" | "read";
  attachments?: readonly ChatAttachment[];
  readBy?: readonly ChatReadReceipt[];
  participantNames?: Readonly<Record<string, string>>;
  onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  className?: string;
}

export const MessageBubble = React.memo<MessageBubbleProps>((props) => {
  return <ClassicMessageBubble {...props} />;
});

MessageBubble.displayName = "MessageBubble";
