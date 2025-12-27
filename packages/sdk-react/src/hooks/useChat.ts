/**
 * useChat hook - Chat functionality
 */

import { useState, useCallback, useEffect } from 'react';
import { useChalk } from '../context.tsx';
import type { ChatMessage } from '@chalk/core';

export interface UseChatResult {
  messages: ChatMessage[];
  sendMessage: (content: string) => void;
}

export function useChat(): UseChatResult {
  const { room } = useChalk();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!room) {
      setMessages([]);
      return;
    }

    // Initialize with existing messages
    setMessages(room.messages);

    const unsub = room.on('chat-message', (message) => {
      setMessages((prev) => [...prev, message]);
    });

    return unsub;
  }, [room]);

  const sendMessage = useCallback(
    (content: string) => {
      if (room) {
        room.sendMessage(content);
      }
    },
    [room]
  );

  return {
    messages,
    sendMessage,
  };
}
