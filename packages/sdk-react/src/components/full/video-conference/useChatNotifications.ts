import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import type { SoundEffect } from "../../../hooks/useSoundEffects";
import type { Phase } from "./types";

interface ChatMessage {
  senderId: string;
  senderName: string;
  content: string;
}

export interface UseChatNotificationsParams {
  phase: Phase;
  messages: readonly ChatMessage[];
  localParticipantId?: string;
  unreadCount: number;
  markAsRead: () => void;
  play: (name: SoundEffect) => void;
}

export interface UseChatNotificationsReturn {
  handleChatOpen: () => void;
}

export function useChatNotifications({ phase, messages, localParticipantId, unreadCount, markAsRead, play }: UseChatNotificationsParams): UseChatNotificationsReturn {
  const prevMessageCountRef = useRef(messages.length);
  const isChatOpenRef = useRef(false);

  const handleChatOpen = useCallback(() => {
    isChatOpenRef.current = true;
    markAsRead();
  }, [markAsRead]);

  useEffect(() => {
    if (unreadCount > 0) {
      isChatOpenRef.current = false;
    }
  }, [unreadCount]);

  useEffect(() => {
    if (phase !== "meeting") return;

    const previousCount = prevMessageCountRef.current;
    const newCount = messages.length;

    if (newCount > previousCount) {
      const newMessages = messages.slice(previousCount);
      const lastRemoteMessage = [...newMessages].reverse().find((message) => message.senderId !== localParticipantId);

      if (lastRemoteMessage && !isChatOpenRef.current) {
        play("message");
        toast.info(`${lastRemoteMessage.senderName}: ${lastRemoteMessage.content}`, {
          duration: 4000,
        });
      }
    }

    prevMessageCountRef.current = newCount;
  }, [messages, localParticipantId, phase, play]);

  return {
    handleChatOpen,
  };
}
