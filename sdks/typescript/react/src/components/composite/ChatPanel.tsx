import { Message01Icon, SentIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Button } from "../ui";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./chat-types";
import React, { useEffect, useMemo, useRef, useState } from "react";

export type { ChatMessage };

export interface ChatPanelPendingMessage {
  readonly id: string;
  readonly content: string;
  readonly state: "sending" | "failed";
  readonly error?: string;
}

export interface ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly pendingMessages?: readonly ChatPanelPendingMessage[];
  readonly onSendMessage: (content: string) => Promise<void>;
  readonly onRetryMessage?: (id: string) => Promise<void>;
  readonly onLoadOlder?: () => Promise<void>;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly localParticipantId?: string;
  readonly onClose?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly title?: string;
  readonly variant?: "sidebar" | "mobile";
  readonly error?: string | null;
}

export const ChatPanel = React.memo(
  ({ messages, pendingMessages = [], onSendMessage, onRetryMessage, onLoadOlder, hasOlder = false, loadingOlder = false, localParticipantId, onClose, disabled = false, placeholder = "Type a message...", title = "Chat", variant = "sidebar", error, className }: ChatPanelProps) => {
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const grouped = useMemo(() => groupMessages(messages), [messages]);

    useEffect(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, pendingMessages]);

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }, [draft]);

    const send = async () => {
      const text = draft.trim();
      if (!text || disabled || sending) return;
      setSending(true);
      try {
        await onSendMessage(text);
        setDraft("");
        setComposerError(null);
      } catch (cause) {
        setComposerError(cause instanceof Error ? cause.message : "Message could not be sent.");
      } finally {
        setSending(false);
      }
    };

    return (
      <div className={cn("relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-transparent text-card-foreground", variant !== "mobile" && "animate-in slide-in-from-right-5 duration-300", className)} role="complementary" aria-label="Chat panel">
        {variant === "sidebar" ? (
          <header className="flex items-center justify-between px-6 py-5">
            <h2 className="text-2xl font-bold">{title}</h2>
            {onClose ? (
              <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close chat">
                Close
              </button>
            ) : null}
          </header>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
          {hasOlder && onLoadOlder ? (
            <Button variant="ghost" size="sm" className="mx-auto mb-3 flex" disabled={loadingOlder} onClick={() => void onLoadOlder()}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </Button>
          ) : null}
          {messages.length === 0 && pendingMessages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Message01Icon className="h-8 w-8" />
              </div>
              <h3 className="mb-1 font-medium">No messages yet</h3>
              <p className="max-w-[220px] text-sm text-muted-foreground">Send a message to start the conversation.</p>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={`${group.senderId}-${group.firstMessageId}`}>
                {group.messages.map((message, index) => (
                  <MessageBubble
                    key={message.id}
                    content={message.content}
                    senderName={message.senderName}
                    timestamp={message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)}
                    isLocal={message.isLocal ?? (localParticipantId !== undefined && message.senderId === localParticipantId)}
                    isFirstInGroup={index === 0}
                    isLastInGroup={index === group.messages.length - 1}
                    showSender={index === 0}
                    showTimestamp={index === group.messages.length - 1}
                    showAvatar
                  />
                ))}
              </div>
            ))
          )}
          {pendingMessages.map((pending) => (
            <div key={pending.id} className="my-2 ml-auto max-w-[85%] rounded-2xl bg-primary/10 px-3 py-2 text-sm">
              <p>{pending.content}</p>
              <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span>{pending.state === "sending" ? "Sending…" : pending.error || "Not sent"}</span>
                {pending.state === "failed" && onRetryMessage ? (
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => void onRetryMessage(pending.id)}>
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {(error || composerError) && (
          <p role="alert" className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {composerError || error}
          </p>
        )}
        <div className="flex items-end gap-3 border-t border-border/30 px-4 py-4">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void send();
            }}
            placeholder={placeholder}
            disabled={disabled || sending}
            aria-label="Message"
            className="min-h-11 max-h-[120px] flex-1 resize-none rounded-2xl bg-muted/50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/50"
            rows={1}
          />
          <Button type="button" size="icon" className="h-11 w-11 shrink-0 rounded-full" disabled={!draft.trim() || disabled || sending} onClick={() => void send()} aria-label="Send message">
            <SentIcon className="h-5 w-5" />
          </Button>
        </div>
      </div>
    );
  },
);

ChatPanel.displayName = "ChatPanel";

function groupMessages(messages: readonly ChatMessage[]) {
  const groups: { readonly senderId: string; readonly firstMessageId: string; readonly messages: ChatMessage[] }[] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.messages.at(-1);
    const withinWindow = previous && new Date(message.timestamp).getTime() - new Date(previous.timestamp).getTime() < 120_000;
    if (group && group.senderId === message.senderId && withinWindow) {
      group.messages.push(message);
    } else {
      groups.push({ senderId: message.senderId, firstMessageId: message.id, messages: [message] });
    }
  }
  return groups;
}
