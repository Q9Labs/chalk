import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MessageSquare, Send, Smile, Paperclip, X } from 'lucide-react';
import { IconButton, Textarea } from '../atomic';
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
        "flex flex-col h-full bg-[#0D0D0D] w-full",
        !prefersReducedMotion && "animate-in slide-in-from-right-5 duration-300",
        className
      )}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <p className="text-xs text-gray-500">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </p>
          </div>
        </div>
        {onClose && (
          <IconButton
            icon={<X className="w-5 h-5" />}
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="text-gray-400 hover:text-white hover:bg-white/10 rounded-xl"
            aria-label="Close chat"
          />
        )}
      </div>

      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 scroll-smooth"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' }}
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-purple-500/10 flex items-center justify-center mb-4">
              <MessageSquare className="w-8 h-8 text-purple-400/60" />
            </div>
            <h3 className="text-white font-medium mb-1">No messages yet</h3>
            <p className="text-sm text-gray-500 max-w-[200px]">
              Send a message to start the conversation
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group, groupIndex) => (
              <div key={`group-${groupIndex}`} className="space-y-0.5">
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
          className="absolute bottom-28 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-purple-600 text-white text-xs font-medium shadow-lg hover:bg-purple-500 transition-all animate-in fade-in slide-in-from-bottom-2"
        >
          New messages
        </button>
      )}

      {/* Input area */}
      <div className="p-4 border-t border-white/5 bg-[#0A0A0A]">
        <div className="flex items-end gap-2">
          {/* Attachment button */}
          <IconButton
            icon={<Paperclip className="w-5 h-5" />}
            size="sm"
            variant="ghost"
            className="text-gray-500 hover:text-purple-400 hover:bg-purple-500/10 rounded-xl h-10 w-10 flex-shrink-0"
            aria-label="Add attachment"
          />

          {/* Input field */}
          <div className="flex-1 relative">
            <Textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className={cn(
                "w-full bg-[#1A1A1A] border border-white/5 rounded-2xl py-2.5 px-4",
                "text-white placeholder:text-gray-500 text-sm",
                "min-h-[44px] max-h-32 resize-none",
                "focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500/50",
                "transition-all duration-200"
              )}
              resize="none"
            />
          </div>

          {/* Emoji button */}
          <IconButton
            icon={<Smile className="w-5 h-5" />}
            size="sm"
            variant="ghost"
            className="text-gray-500 hover:text-yellow-400 hover:bg-yellow-500/10 rounded-xl h-10 w-10 flex-shrink-0"
            aria-label="Add emoji"
          />

          {/* Send button */}
          <IconButton
            icon={<Send className="w-5 h-5" />}
            onClick={handleSend}
            disabled={!inputValue.trim() || disabled}
            className={cn(
              "h-10 w-10 rounded-xl flex-shrink-0 transition-all duration-200",
              inputValue.trim() && !disabled
                ? "bg-purple-600 text-white hover:bg-purple-500 shadow-lg shadow-purple-500/25"
                : "bg-[#1A1A1A] text-gray-600 cursor-not-allowed"
            )}
            aria-label="Send message"
          />
        </div>

        {/* Typing hint */}
        <p className="text-[10px] text-gray-600 mt-2 text-center">
          Press <kbd className="px-1 py-0.5 rounded bg-white/5 text-gray-500">Enter</kbd> to send, <kbd className="px-1 py-0.5 rounded bg-white/5 text-gray-500">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
