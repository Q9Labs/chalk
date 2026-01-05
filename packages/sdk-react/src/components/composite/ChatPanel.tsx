import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MessageSquare, Send } from 'lucide-react';
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
}

// Inline styles matching the reference design
const chatStyles = {
  // Deep dark purple gradient background: #35004A at 21%, #8D00C5 at 3%
  container: {
    background: 'linear-gradient(180deg, rgba(141, 0, 197, 0.08) 0%, rgba(53, 0, 74, 0.36) 100%)',
    backgroundColor: '#0D0A14',
    color: '#FFFFFF',
  } as React.CSSProperties,
  header: {
    background: 'transparent',
    padding: '16px 20px',
  } as React.CSSProperties,
  title: {
    color: '#FFFFFF',
    fontSize: '20px',
    fontWeight: 600,
  } as React.CSSProperties,
  // Muted dark grey-purple for empty state
  emptyState: {
    color: '#6B7280',
  } as React.CSSProperties,
  emptyIcon: {
    background: 'rgba(53, 0, 74, 0.5)',
    color: '#9CA3AF',
  } as React.CSSProperties,
  inputArea: {
    background: 'transparent',
    padding: '16px 20px',
  } as React.CSSProperties,
  inputField: {
    background: 'rgba(45, 42, 62, 0.8)',
    border: 'none',
    color: '#FFFFFF',
    borderRadius: '24px',
    fontSize: '14px',
  } as React.CSSProperties,
  placeholder: {
    color: '#6B7280',
  } as React.CSSProperties,
  // Bright saturated purple for action buttons
  actionButton: {
    background: '#7C3AED',
    color: '#FFFFFF',
    borderRadius: '50%',
    width: '44px',
    height: '44px',
  } as React.CSSProperties,
  moreButton: {
    color: '#9CA3AF',
  } as React.CSSProperties,
};

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
  className
}: ChatPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Group messages for better visual presentation
  const messageGroups = useMemo(() => groupMessages(messages), [messages]);

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth && !prefersReducedMotion ? 'smooth' : 'auto'
    });
  };

  // Auto-scroll when new messages arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [messages, isAtBottom]);

  // Track scroll position
  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
  };

  const handleSend = () => {
    if (inputValue.trim() && !disabled) {
      onSendMessage(inputValue.trim());
      setInputValue('');
      // Scroll to bottom after sending
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
        !prefersReducedMotion && "animate-in slide-in-from-right-5 duration-300",
        className
      )}
      style={chatStyles.container}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
    >
      {/* Header - "Chat" with three-dot menu */}
      <div
        className="flex items-center justify-between"
        style={chatStyles.header}
      >
        <h2 style={chatStyles.title}>{title}</h2>
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center transition-opacity hover:opacity-70"
              style={chatStyles.moreButton}
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

      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-4"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#2D2A3E transparent' }}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={chatStyles.emptyIcon}
            >
              <MessageSquare className="w-8 h-8" />
            </div>
            <h3 style={{ color: '#FFFFFF', fontWeight: 500, marginBottom: '4px' }}>No messages yet</h3>
            <p style={{ ...chatStyles.emptyState, fontSize: '14px', maxWidth: '200px' }}>
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

      {/* Scroll to bottom indicator */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-sm font-medium transition-all"
          style={{ background: '#7C3AED', color: '#FFFFFF' }}
        >
          New messages
        </button>
      )}

      {/* Input area - "+" button, text field, Send button */}
      <div style={chatStyles.inputArea}>
        <div className="flex items-center gap-3">
          {/* Plus/Attachment button - bright purple circle */}
          <button
            type="button"
            className="flex-shrink-0 flex items-center justify-center transition-opacity hover:opacity-80"
            style={chatStyles.actionButton}
            aria-label="Add attachment"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          {/* Input field - "Write message..." */}
          <div className="flex-1">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || "Write message..."}
              disabled={disabled}
              className="w-full py-3 px-5 resize-none outline-none"
              style={{
                ...chatStyles.inputField,
                minHeight: '48px',
                maxHeight: '120px',
              }}
              rows={1}
            />
          </div>

          {/* Send button - bright purple circle with paper plane */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || disabled}
            className="flex-shrink-0 flex items-center justify-center transition-opacity"
            style={{
              ...chatStyles.actionButton,
              opacity: inputValue.trim() && !disabled ? 1 : 0.5,
            }}
            aria-label="Send message"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
