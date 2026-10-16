import type { ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, ChatUploadFile, SpaceSnapshot } from "@q9labsai/chalk-client";
import React from "react";
import { ClassicChatPanel, ClassicChatPanelSurface } from "./ClassicChatPanel";
export type { ChatMessage } from "./chat-types";
export interface ChatPanelProps {
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onClose?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly title?: string;
  readonly variant?: "sidebar" | "mobile";
  readonly generatedAvatars?: boolean;
}
export interface ChatPanelSurfaceProps extends ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly pendingMessages?: SpaceSnapshot["chat"]["pendingSends"];
  readonly readReceipts?: readonly ChatReadReceipt[];
  readonly localReadThroughSequence?: string | null;
  readonly participantNames?: Readonly<Record<string, string>>;
  readonly onSendMessage?: (input: Pick<ChatSendInput, "text" | "attachments">) => Promise<void>;
  readonly onUploadAttachment?: (file: ChatUploadFile) => Promise<ChatAttachment>;
  readonly onResolveAttachmentUrl?: (attachmentId: string) => Promise<string>;
  readonly onMarkRead?: (throughSequence: string) => void | Promise<unknown>;
  readonly onLoadOlder?: () => Promise<void>;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly localParticipantId?: string;
  readonly error?: string | null;
  readonly messageDisplayTime?: (message: ChatMessage) => string;
  readonly autoScrollBehavior?: ScrollBehavior;
}
export const ChatPanel = React.memo((props: ChatPanelProps): React.JSX.Element => {
  return <ClassicChatPanel {...props} />;
});
/** Data-driven chat presentation without a Space client or bindings provider. */
export const ChatPanelPresentation = React.memo((props: ChatPanelSurfaceProps): React.JSX.Element => {
  return <ClassicChatPanelSurface {...props} />;
});
ChatPanel.displayName = "ChatPanel";
ChatPanelPresentation.displayName = "ChatPanelPresentation";
