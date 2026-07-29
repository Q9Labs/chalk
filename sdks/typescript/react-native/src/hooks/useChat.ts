import type { ChatMessage, ReactionEmoji } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useChalkSessionStore } from "../context/chalk-native-provider";
import { createNativeRoomActionCommands, projectNativeRoomActions } from "../room-actions/native-room-actions";
import { useOptionalChalkSnapshot } from "./useChalkRoomActions";

export interface UseChatReturn {
  messages: readonly ChatMessage[];
  isEnabled: boolean;
  count: number;
  unreadCount: number;
  sendMessage: (content: string) => Promise<void>;
  reactToMessage: (messageId: string, emoji: ReactionEmoji) => void;
  markAsRead: () => void;
  markAsHidden: () => void;
  getMessage: (id: string) => ChatMessage | undefined;
}

export function useChat(): UseChatReturn {
  const store = useChalkSessionStore();
  const snapshot = useOptionalChalkSnapshot();
  const projection = useMemo(() => projectNativeRoomActions(snapshot), [snapshot]);
  const commands = useMemo(() => (store ? createNativeRoomActionCommands(store) : null), [store]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!commands) throw new Error("ChalkNativeProvider requires sessionStore for durable chat.");
      await commands.sendChatMessage(content);
    },
    [commands],
  );
  const reactToMessage = useCallback((_messageId: string, _emoji: ReactionEmoji) => {
    throw new Error("Per-message reactions are not part of the room-actions contract.");
  }, []);
  const markAsRead = useCallback(() => store?.markChatRead(), [store]);
  const markAsHidden = markAsRead;
  const getMessage = useCallback((id: string) => projection.messages.find((message) => message.id === id), [projection.messages]);

  return useMemo(
    () => ({
      messages: projection.messages,
      isEnabled: projection.chatEnabled,
      count: projection.messages.length,
      unreadCount: snapshot?.chat.unreadCount ?? 0,
      sendMessage,
      reactToMessage,
      markAsRead,
      markAsHidden,
      getMessage,
    }),
    [projection, snapshot?.chat.unreadCount, sendMessage, reactToMessage, markAsRead, markAsHidden, getMessage],
  );
}
