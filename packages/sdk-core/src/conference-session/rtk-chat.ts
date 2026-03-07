import type { ChatMessage } from "../types.ts";
import type { RtkSignalingDeps } from "./rtk-signaling-deps.ts";

const extractChatMessage = (payload: unknown): ChatMessage | null => {
  const rawData = payload as Record<string, unknown>;

  if (rawData.action && rawData.action !== "add") {
    return null;
  }

  const messageData = (rawData.message as Record<string, unknown>) ?? rawData;

  const chatMessage: ChatMessage = {
    id: (messageData.id as string) ?? crypto.randomUUID(),
    senderId: (messageData.userId as string) ?? "unknown",
    senderName: (messageData.displayName as string) ?? "Unknown",
    content: (messageData.message as string) ?? (messageData.text as string) ?? (messageData.content as string) ?? "",
    timestamp: new Date((messageData.time as string) ?? (messageData.timestamp as string) ?? Date.now()),
  };

  if (typeof chatMessage.content !== "string") {
    chatMessage.content = String(chatMessage.content);
  }

  return chatMessage;
};

export const setupRtkChatListener = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient?.chat) {
    return;
  }

  const chat = rtkClient.chat as unknown as {
    on: (event: string, handler: (data: unknown) => void) => void;
    messages?: unknown[];
  };

  const chatEventHandler = (_eventName: string) => (payload: unknown) => {
    const chatMessage = extractChatMessage(payload);
    if (!chatMessage) {
      return;
    }

    const isDuplicate = deps.getMessages().some((message) => message.id === chatMessage.id || (message.senderId === chatMessage.senderId && message.content === chatMessage.content && Math.abs(new Date(message.timestamp).getTime() - new Date(chatMessage.timestamp).getTime()) < 5000));

    if (isDuplicate) {
      return;
    }

    deps.getMessages().push(chatMessage);
    deps.emit("chat.message", chatMessage);
  };

  const chatEvents = ["chatUpdate", "newMessage", "messageReceived", "message"];
  for (const eventName of chatEvents) {
    try {
      chat.on(eventName, chatEventHandler(eventName));
    } catch {
      // best effort
    }
  }
};
