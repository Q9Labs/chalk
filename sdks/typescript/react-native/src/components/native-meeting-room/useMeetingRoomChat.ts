import type { ChalkChatAttachment, ChalkSessionStore } from "@q9labsai/chalk-client";
import { useState, type Dispatch, type SetStateAction } from "react";
import { Linking } from "react-native";

import type { UseChatReturn } from "../../hooks/useChat";
import type { MeetingRoomProps } from "../MeetingRoom";
import type { MeetingRoomActionRunner } from "./types";

export interface MeetingRoomChat {
  readonly chatDraft: string;
  readonly chatAttachments: readonly ChalkChatAttachment[];
  readonly chatAttachmentsLoading: boolean;
  readonly setChatDraft: Dispatch<SetStateAction<string>>;
  readonly sendChatMessage: () => void;
  readonly pickChatAttachments?: () => void;
  readonly removeChatAttachment: (attachmentId: string) => void;
  readonly openChatAttachment: (attachmentId: string) => void;
  readonly markChatMessageVisible: (sequence: string) => void;
}

interface UseMeetingRoomChatOptions {
  readonly session: Pick<ChalkSessionStore, "chatFiles">;
  readonly chat: Pick<UseChatReturn, "sendMessage" | "markAsRead">;
  readonly pickChatAttachments: MeetingRoomProps["pickChatAttachments"];
  readonly run: MeetingRoomActionRunner;
}

export function useMeetingRoomChat({ session, chat, pickChatAttachments, run }: UseMeetingRoomChatOptions): MeetingRoomChat {
  const [chatDraft, setChatDraft] = useState("");
  const [chatAttachments, setChatAttachments] = useState<readonly ChalkChatAttachment[]>([]);
  const [chatAttachmentsLoading, setChatAttachmentsLoading] = useState(false);

  return {
    chatDraft,
    chatAttachments,
    chatAttachmentsLoading,
    setChatDraft,
    sendChatMessage: () => {
      const text = chatDraft.trim();
      if (!text && chatAttachments.length === 0) return;
      setChatDraft("");
      setChatAttachments([]);
      void run(() => chat.sendMessage({ text, attachments: chatAttachments }));
    },
    pickChatAttachments:
      pickChatAttachments && session.chatFiles
        ? () =>
            void run(async () => {
              setChatAttachmentsLoading(true);
              try {
                const attachments = await pickChatAttachments(session.chatFiles!);
                setChatAttachments((current) => [...current, ...attachments].slice(0, 5));
              } finally {
                setChatAttachmentsLoading(false);
              }
            })
        : undefined,
    removeChatAttachment: (attachmentId: string) => setChatAttachments((current) => current.filter((attachment) => attachment.attachmentId !== attachmentId)),
    openChatAttachment: (attachmentId: string) =>
      void run(async () => {
        if (!session.chatFiles) throw new Error("Chat attachment downloads are unavailable.");
        const { downloadUrl } = await session.chatFiles.getDownloadUrl(attachmentId);
        await Linking.openURL(downloadUrl);
      }),
    markChatMessageVisible: (sequence: string) => void run(() => chat.markAsRead(sequence)),
  };
}
