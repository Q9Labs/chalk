import type { ChatMessage, ChatState, ReactionEmoji } from "../internal/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseChatReturn {
  messages: readonly ChatMessage[];
  isEnabled: boolean;
  count: number;
  unreadCount: number;
  sendMessage: (content: string) => void;
  reactToMessage: (messageId: string, emoji: ReactionEmoji) => void;
  markAsRead: () => void;
  markAsHidden: () => void;
  getMessage: (id: string) => ChatMessage | undefined;
}

export function useChat(): UseChatReturn {
  const session = useSession();
  const { chat } = session;
  const [state, setState] = useState<ChatState>(() => chat.getState());

  useEffect(() => chat.subscribe(setState), [chat]);

  const sendMessage = useCallback((content: string) => chat.sendMessage(content), [chat]);
  const reactToMessage = useCallback((messageId: string, emoji: ReactionEmoji) => chat.reactToMessage(messageId, emoji), [chat]);
  const markAsRead = useCallback(() => chat.markAsRead(), [chat]);
  const markAsHidden = useCallback(() => chat.markAsHidden(), [chat]);
  const getMessage = useCallback((id: string) => chat.getMessage(id), [chat]);

  return useMemo(
    () => ({
      messages: state.messages,
      isEnabled: state.isEnabled,
      count: state.count,
      unreadCount: state.unreadCount,
      sendMessage,
      reactToMessage,
      markAsRead,
      markAsHidden,
      getMessage,
    }),
    [state, sendMessage, reactToMessage, markAsRead, markAsHidden, getMessage],
  );
}
