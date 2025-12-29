import React, { useEffect, useRef, useState } from 'react';
import { X, Send } from 'lucide-react';
import { IconButton, Textarea } from '../atomic';
import { cn } from '../../utils/cn';

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
}

export function ChatPanel({
  messages,
  onSendMessage,
  onClose,
  disabled = false,
  placeholder = "Type a message...",
  className
}: ChatPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = () => {
    if (inputValue.trim() && !disabled) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div 
      className={cn(
        "flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl chalk-animate-slide-right",
        className
      )}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
    >
      <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
        <h2 className="text-sm font-semibold text-chalk-text-primary">Chat</h2>
        {onClose && (
          <IconButton 
            icon={<X className="w-4 h-4" />} 
            size="sm" 
            variant="ghost" 
            onClick={onClose}
            aria-label="Close chat"
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-chalk-text-muted opacity-60">
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div 
              key={msg.id} 
              className={cn(
                "flex flex-col max-w-[85%]",
                msg.isLocal ? "ml-auto items-end" : "mr-auto items-start"
              )}
            >
              {!msg.isLocal && (
                <span className="text-xs text-chalk-text-secondary mb-1 ml-1">
                  {msg.senderName}
                </span>
              )}
              
              <div 
                className={cn(
                  "px-3 py-2 rounded-lg text-sm break-words shadow-sm",
                  msg.isLocal 
                    ? "bg-chalk-accent text-white rounded-br-none" 
                    : "bg-chalk-bg-subtle text-chalk-text-primary rounded-bl-none"
                )}
              >
                {msg.content}
              </div>
              
              <span className={cn(
                "text-[10px] text-chalk-text-muted mt-1",
                msg.isLocal ? "mr-1" : "ml-1"
              )}>
                {formatTime(msg.timestamp)}
              </span>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-chalk-border-subtle bg-chalk-bg-surface">
        <div className="relative">
          <Textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className="pr-10 min-h-[44px] max-h-32 py-3"
            resize="none"
          />
          <div className="absolute right-2 bottom-2">
            <IconButton
              icon={<Send className="w-4 h-4" />}
              size="sm"
              variant="ghost"
              onClick={handleSend}
              disabled={!inputValue.trim() || disabled}
              className={cn(
                "text-chalk-accent hover:text-chalk-accent-hover hover:bg-chalk-accent/10",
                (!inputValue.trim() || disabled) && "opacity-50 cursor-not-allowed"
              )}
              aria-label="Send message"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
