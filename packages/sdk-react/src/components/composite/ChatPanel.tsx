import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical, Send, Plus } from 'lucide-react';
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
}

export const ChatPanel = React.memo(({
  messages,
  onSendMessage,
  disabled = false,
  placeholder = "Write message...",
  className
}: ChatPanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
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

  return (
    <div 
      className={cn(
        "flex flex-col h-full bg-[#0D0D0D] w-full",
        !prefersReducedMotion && "chalk-animate-slide-right",
        className
      )}
      data-tour="chat-panel"
      role="complementary"
      aria-label="Chat panel"
    >
      <div className="flex items-center justify-between p-6">
        <h2 className="text-2xl font-bold text-white">Chat</h2>
        <IconButton 
          icon={<MoreVertical className="w-5 h-5" />} 
          size="sm" 
          variant="ghost" 
          onClick={() => {}}
          className="text-white hover:bg-white/10"
          aria-label="Options"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 opacity-60">
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
                key={msg.id}
                content={msg.content}
                senderName={msg.senderName}
                // senderAvatar={`https://i.pravatar.cc/150?u=${msg.senderId}`}
                timestamp={msg.timestamp}
                isLocal={msg.isLocal}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-6 pt-4 pb-8">
        <div className="flex items-end gap-3">
            <IconButton
                icon={<Plus className="w-5 h-5" />}
                className="w-12 h-12 rounded-full bg-[#1A1A1A] text-purple-500 hover:bg-[#252525] flex-shrink-0 border border-white/5"
                aria-label="Add attachment"
            />
            <div className="flex-1 relative">
                <Textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="w-full bg-[#1A1A1A] border-none rounded-2xl py-3 px-4 text-white placeholder:text-gray-500 min-h-[48px] max-h-32 resize-none focus:ring-1 focus:ring-purple-500/50"
                    resize="none"
                />
            </div>
            <IconButton
                icon={<Send className="w-5 h-5 ml-0.5" />}
                onClick={handleSend}
                disabled={!inputValue.trim() || disabled}
                className={cn(
                    "w-12 h-12 rounded-full bg-[#6E00E6] text-white hover:bg-[#5a00bd] flex-shrink-0 shadow-lg shadow-purple-500/20",
                    (!inputValue.trim() || disabled) && "opacity-50 cursor-not-allowed bg-gray-700"
                )}
                aria-label="Send message"
            />
        </div>
      </div>
    </div>
  );
});

ChatPanel.displayName = 'ChatPanel';
