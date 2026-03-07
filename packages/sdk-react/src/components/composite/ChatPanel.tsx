import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Message01Icon, SentIcon, PlusSignIcon } from '../../utils/icons';
import { MessageBubble } from './MessageBubble';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { Button } from '../ui';
import { getParticipantThemeVariables } from '../../utils/colorGenerator';

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
  participantColorSeed?: string;
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
  participantColorSeed,
  className
}: ChatPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

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
        "bg-transparent text-card-foreground",
        !prefersReducedMotion && variant !== 'mobile' && "animate-in slide-in-from-right-5 duration-300",
        className
      )}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
      style={themeVariables as React.CSSProperties}
    >
      {variant === 'sidebar' && (
        <div className="flex items-center justify-between px-6 py-5">
          <h2 className="text-2xl font-bold text-card-foreground">{title}</h2>
          <div className="flex items-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-8 h-8 rounded-full transition-colors hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Close chat"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
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
          "[scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]"
        )}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-primary/10 text-primary">
              <Message01Icon className="w-8 h-8" />
            </div>
            <h3 className="font-medium mb-1 text-card-foreground">No messages yet</h3>
            <p className="text-sm max-w-[200px] text-muted-foreground">
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
        <Button
          onClick={() => scrollToBottom()}
          size="sm"
          className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          New messages
        </Button>
      )}

      <div className="px-6 py-5 border-t border-border/30">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="flex-shrink-0 w-11 h-11 rounded-full bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted/80"
            aria-label="Add attachment"
          >
            <PlusSignIcon className="w-5 h-5" />
          </Button>

          <div className="flex-1">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || "Write message..."}
              disabled={disabled}
              className={cn(
                "w-full py-3 px-5 resize-none outline-none rounded-2xl text-sm",
                "bg-muted/50 backdrop-blur-sm",
                "text-foreground",
                "placeholder:text-muted-foreground",
                "focus:ring-2 focus:ring-primary/50 focus:bg-muted/70",
                "transition-all"
              )}
              style={{ minHeight: '44px', maxHeight: '120px' }}
              rows={1}
            />
          </div>

          <Button
            onClick={handleSend}
            disabled={!inputValue.trim() || disabled}
            size="icon"
            className="flex-shrink-0 w-11 h-11 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25"
            aria-label="Send message"
          >
            <SentIcon className="w-5 h-5 ml-0.5" />
          </Button>
        </div>
      </div>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
