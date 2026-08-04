import { useEffect, useMemo, useState } from "react";

const MESSAGE_ROTATION_MS = 1_800;
const EMPTY_SUPPORTING_MESSAGES: readonly string[] = [];

export function useJoiningScreenMessage(message: string, supportingMessages: readonly string[] = EMPTY_SUPPORTING_MESSAGES): string {
  const supportingMessagesKey = JSON.stringify(supportingMessages);
  const messages = useMemo(() => [message, ...supportingMessages], [message, supportingMessagesKey]);
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    setMessageIndex(0);
  }, [messages]);

  useEffect(() => {
    if (messages.length <= 1) return;

    const intervalId = setInterval(() => {
      setMessageIndex((currentIndex) => (currentIndex + 1) % messages.length);
    }, MESSAGE_ROTATION_MS);

    return () => clearInterval(intervalId);
  }, [messages]);

  return messages[messageIndex] ?? message;
}
