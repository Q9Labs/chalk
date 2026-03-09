/**
 * useChat hook - Chat messaging functionality
 * Uses API WebSocket for real-time messaging
 */

import type { ChatMessage } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";

export interface UseChatResult {
  messages: ChatMessage[];
  sendMessage: (content: string) => void;
}

export function useChat(): UseChatResult {
  const { wsClient, wsConnectionState, wsRoomId } = useChalk();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!wsClient) {
      return;
    }

    const unsubscribeMessage = wsClient.on("chat.message", (message) => {
      setMessages((prev) => [...prev, message]);
    });

    const unsubscribeDisconnected = wsClient.on("disconnected", () => {
      setMessages([]);
    });

    return () => {
      unsubscribeMessage();
      unsubscribeDisconnected();
    };
  }, [wsClient]);

  useEffect(() => {
    setMessages([]);
  }, [wsRoomId]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!wsClient || wsConnectionState !== "connected") {
        logger.info({
          event: "chat.send.skipped",
          roomId: wsRoomId,
          reason: wsClient ? "ws_not_connected" : "ws_client_unavailable",
        });
        return;
      }
      wsClient.sendChatMessage(content);
    },
    [wsClient, wsConnectionState, wsRoomId],
  );

  return {
    messages,
    sendMessage,
  };
}
