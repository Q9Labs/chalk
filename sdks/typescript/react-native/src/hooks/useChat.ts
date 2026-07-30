import type { ChalkPendingChatMessage, ChalkReaction, ChalkSendChatMessageInput } from "@q9labsai/chalk-client";
import { useCallback, useMemo } from "react";
import { useChalkSession } from "../context/chalk-native-provider";
import { createNativeRoomActionCommands, projectNativeRoomActions } from "../room-actions/native-room-actions";
import type { NativeChatMessage } from "../ui/native-types";
import { useChalkSnapshot } from "./useChalkRoomActions";

export interface UseChatReturn {
  messages: readonly NativeChatMessage[];
  isEnabled: boolean;
  count: number;
  unreadCount: number;
  pendingMessages: readonly ChalkPendingChatMessage[];
  hasMore: boolean;
  isLoadingOlder: boolean;
  sendMessage: (content: string | ChalkSendChatMessageInput) => Promise<void>;
  retryMessage: (clientMessageId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  reactToMessage: (messageId: string, emoji: ChalkReaction) => void;
  markAsRead: (throughSequence?: string) => Promise<void>;
  markAsHidden: (throughSequence?: string) => Promise<void>;
  getMessage: (id: string) => NativeChatMessage | undefined;
}

export function useChat(): UseChatReturn {
  const store = useChalkSession();
  const snapshot = useChalkSnapshot();
  const projection = useMemo(() => projectNativeRoomActions(snapshot), [snapshot]);
  const commands = useMemo(() => createNativeRoomActionCommands(store), [store]);

  const sendMessage = useCallback(
    async (content: string | ChalkSendChatMessageInput) => {
      if (typeof content === "string") await commands.sendChatMessage(content);
      else await store.sendChatMessage(content);
    },
    [commands],
  );
  const retryMessage = useCallback(
    async (clientMessageId: string) => {
      await store.retryChatMessage(clientMessageId);
    },
    [store],
  );
  const loadOlderMessages = useCallback(async () => {
    await store.loadOlderChatMessages();
  }, [store]);
  const reactToMessage = useCallback((_messageId: string, _emoji: ChalkReaction) => {
    throw new Error("Per-message reactions are not part of the room-actions contract.");
  }, []);
  const markAsRead = useCallback(
    async (throughSequence?: string) => {
      await store.markChatRead(throughSequence);
    },
    [store],
  );
  const markAsHidden = markAsRead;
  const getMessage = useCallback((id: string) => projection.messages.find((message) => message.id === id), [projection.messages]);

  return useMemo(
    () => ({
      messages: projection.messages,
      isEnabled: projection.chatEnabled,
      count: projection.messages.length,
      unreadCount: snapshot.chat.unreadCount,
      pendingMessages: snapshot.chat.pending,
      hasMore: snapshot.chat.hasOlder,
      isLoadingOlder: snapshot.chat.status === "loading",
      sendMessage,
      retryMessage,
      loadOlderMessages,
      reactToMessage,
      markAsRead,
      markAsHidden,
      getMessage,
    }),
    [projection, snapshot.chat, sendMessage, retryMessage, loadOlderMessages, reactToMessage, markAsRead, markAsHidden, getMessage],
  );
}
