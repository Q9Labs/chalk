import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Message01Icon, SentIcon } from '../../utils/icons';
import { MessageBubble } from './MessageBubble';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  isLocal?: boolean;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onClose?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  /** Variant for different layouts */
  variant?: 'sidebar' | 'mobile';
}

// Group messages by sender within a time window (2 minutes)
const groupMessages = (messages: ChatMessage[]) => {
  const groups: { messages: ChatMessage[]; senderId: string }[] = [];
  const TIME_WINDOW = 2 * 60 * 1000; // 2 minutes

  messages.forEach((msg) => {
    const lastGroup = groups[groups.length - 1];
    const lastMsg = lastGroup?.messages[lastGroup.messages.length - 1];

    // Check if this message belongs to the same group
    const isSameSender = lastGroup && lastGroup.senderId === msg.senderId;
    const isWithinTimeWindow = lastMsg &&
      (new Date(msg.timestamp).getTime() - new Date(lastMsg.timestamp).getTime()) < TIME_WINDOW;

    if (isSameSender && isWithinTimeWindow) {
      lastGroup.messages.push(msg);
    } else {
      groups.push({ messages: [msg], senderId: msg.senderId });
    }
  });

  return groups;
};

export const ChatPanel = React.memo(({
  messages,
  onSendMessage,
  onClose,
  disabled = false,
  placeholder = "Type a message...",
  title = "Chat",
  variant = 'sidebar',
  className
}: ChatPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const messageGroups = useMemo(() => groupMessages(messages), [messages]);

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth && !prefersReducedMotion ? 'smooth' : 'auto'
    });
  };

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [messages, isAtBottom]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
  };

  const handleSend = () => {
    if (inputValue.trim() && !disabled) {
      onSendMessage(inputValue.trim());
      setInputValue('');
      setTimeout(() => scrollToBottom(), 100);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full w-full",
        "bg-[var(--card,var(--chalk-bg-secondary))] text-[var(--card-foreground,var(--chalk-text-primary))]",
        !prefersReducedMotion && variant !== 'mobile' && "animate-in slide-in-from-right-5 duration-300",
        className
      )}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
    >
      {variant === 'sidebar' && (
        <div className="flex items-center justify-between px-6 py-5">
          <h2 className="text-2xl font-bold text-[var(--card-foreground,var(--chalk-text-primary))]">{title}</h2>
          <div className="flex items-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center transition-opacity hover:opacity-70 text-[var(--card-foreground,var(--chalk-text-primary))]"
                aria-label="More options"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className={cn(
          "flex-1 overflow-y-auto py-4",
          "[scrollbar-width:thin] [scrollbar-color:var(--border,var(--chalk-border-subtle))_transparent]"
        )}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-[var(--muted,var(--chalk-bg-tertiary))] text-[var(--muted-foreground,var(--chalk-text-muted))]">
              <Message01Icon className="w-8 h-8" />
            </div>
            <h3 className="font-medium mb-1 text-[var(--card-foreground,var(--chalk-text-primary))]">No messages yet</h3>
            <p className="text-sm max-w-[200px] text-[var(--muted-foreground,var(--chalk-text-muted))]">
              Send a message to start the conversation
            </p>
          </div>
        ) : (
          <div>
            {messageGroups.map((group, groupIndex) => (
              <div key={`group-${groupIndex}`}>
                {group.messages.map((msg, msgIndex) => (
                  <MessageBubble
                    key={msg.id}
                    content={msg.content}
                    senderName={msg.senderName}
                    timestamp={msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)}
                    isLocal={msg.isLocal}
                    isFirstInGroup={msgIndex === 0}
                    isLastInGroup={msgIndex === group.messages.length - 1}
                    showSender={msgIndex === 0}
                    showTimestamp={msgIndex === group.messages.length - 1}
                    showAvatar={true}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        <div ref={messagesEndRef} className="h-1" />
      </div>

      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={() => scrollToBottom()}
          className={cn(
            "absolute bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-sm font-medium transition-all",
            "bg-[var(--primary,var(--chalk-accent))] text-[var(--primary-foreground,#fff)]"
          )}
        >
          New messages
        </button>
      )}

      <div className="px-6 py-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={cn(
              "flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full transition-opacity hover:opacity-80",
              "bg-[var(--secondary,var(--chalk-bg-tertiary))] text-[var(--secondary-foreground,var(--chalk-text-primary))]"
            )}
            aria-label="Add attachment"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <div className="flex-1">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || "Write message..."}
              disabled={disabled}
              className={cn(
                "w-full py-3.5 px-6 resize-none outline-none rounded-3xl text-sm",
                "bg-[var(--input,var(--chalk-bg-tertiary))]",
                "text-[var(--foreground,var(--chalk-text-primary))]",
                "placeholder:text-[var(--muted-foreground,var(--chalk-text-muted))]",
                "focus:ring-2 focus:ring-[var(--ring,var(--chalk-accent))]"
              )}
              style={{ minHeight: '48px', maxHeight: '120px' }}
              rows={1}
            />
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || disabled}
            className={cn(
              "flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full transition-opacity",
              "bg-[var(--primary,var(--chalk-accent))] text-[var(--primary-foreground,#fff)]",
              "shadow-lg",
              (!inputValue.trim() || disabled) && "opacity-50"
            )}
            aria-label="Send message"
          >
            <SentIcon className="w-5 h-5 ml-0.5" />
          </button>
        </div>
      </div>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
