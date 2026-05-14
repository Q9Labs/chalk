/**
 * useChat - Chat from ChatManager
 */

import type { ChatMessage, ChatState, ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseChatReturn {
  /** All messages */
  messages: readonly ChatMessage[];
  /** Whether chat is enabled */
  isEnabled: boolean;
  /** Message count */
  count: number;
  /** Unread message count */
  unreadCount: number;
  /** Send a message */
  sendMessage: (content: string) => void;
  /** Send a message with uploaded attachments */
  sendMessageWithAttachments: (content: string, files: File[]) => Promise<void>;
  /** React to a message */
  reactToMessage: (messageId: string, emoji: ReactionEmoji) => void;
  /** Mark chat as read (resets unread count) */
  markAsRead: () => void;
  /** Mark chat as hidden */
  markAsHidden: () => void;
  /** Get a message by ID */
  getMessage: (id: string) => ChatMessage | undefined;
  /** Resolve a private download URL for an attachment */
  getAttachmentDownloadUrl: (attachmentId: string) => Promise<string>;
}

/**
 * Hook for chat functionality
 *
 * @example
 * ```tsx
 * function ChatPanel() {
 *   const { messages, sendMessage, unreadCount } = useChat();
 *   const [input, setInput] = useState('');
 *
 *   const handleSend = () => {
 *     sendMessage(input);
 *     setInput('');
 *   };
 *
 *   return (
 *     <div>
 *       <div className="messages">
 *         {messages.map(msg => (
 *           <div key={msg.id}>{msg.senderName}: {msg.content}</div>
 *         ))}
 *       </div>
 *       <input value={input} onChange={e => setInput(e.target.value)} />
 *       <button onClick={handleSend}>Send</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useChat(): UseChatReturn {
  const session = useSession();
  const { chat } = session;

  const [state, setState] = useState<ChatState>(() => chat.getState());

  useEffect(() => {
    return chat.subscribe(setState);
  }, [chat]);

  const sendMessage = useCallback((content: string): void => chat.sendMessage(content), [chat]);

  const sendMessageWithAttachments = useCallback((content: string, files: File[]): Promise<void> => chat.sendMessageWithAttachments(content, files), [chat]);

  const reactToMessage = useCallback((messageId: string, emoji: ReactionEmoji): void => chat.reactToMessage(messageId, emoji), [chat]);

  const markAsRead = useCallback((): void => chat.markAsRead(), [chat]);

  const markAsHidden = useCallback((): void => chat.markAsHidden(), [chat]);

  const getMessage = useCallback((id: string): ChatMessage | undefined => chat.getMessage(id), [chat]);

  const getAttachmentDownloadUrl = useCallback((attachmentId: string): Promise<string> => chat.getAttachmentDownloadUrl(attachmentId), [chat]);

  return useMemo(
    (): UseChatReturn => ({
      messages: state.messages,
      isEnabled: state.isEnabled,
      count: state.count,
      unreadCount: state.unreadCount,
      sendMessage,
      sendMessageWithAttachments,
      reactToMessage,
      markAsRead,
      markAsHidden,
      getMessage,
      getAttachmentDownloadUrl,
    }),
    [state, sendMessage, sendMessageWithAttachments, reactToMessage, markAsRead, markAsHidden, getMessage, getAttachmentDownloadUrl],
  );
}
