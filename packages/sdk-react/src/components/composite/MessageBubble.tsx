import React from 'react';
import { cn } from '../../utils/cn';
import { Avatar } from '../atomic/Avatar';
import { CheckCheck } from 'lucide-react';

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: Date;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  className?: string;
}

export const MessageBubble = React.memo<MessageBubbleProps>(({
  content,
  senderName,
  senderAvatar,
  timestamp,
  isLocal = false,
  isSystem = false,
  showSender = true,
  showTimestamp = true,
  className,
}) => {
  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    }).format(date);
  };

  const renderContent = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--chalk-accent)] underline hover:text-[var(--chalk-accent-hover)] break-all"
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  if (isSystem) {
    return (
      <div className={cn('flex flex-col items-center gap-1 py-2', className)}>
        <p className="text-sm italic text-[var(--chalk-text-muted)] text-center px-4">
          {renderContent(content)}
        </p>
        {showTimestamp && (
          <span className="text-xs text-[var(--chalk-text-muted)] opacity-70">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex gap-3 w-full',
        isLocal ? 'justify-end' : 'justify-start',
        className
      )}
    >
      {!isLocal && (
        <Avatar
          name={senderName}
          src={senderAvatar}
          size="md"
          className="mt-1 !w-10 !h-10 border-2 border-[#0D0D0D]"
        />
      )}
      
      <div className={cn('flex flex-col gap-1 max-w-[75%]', isLocal ? 'items-end' : 'items-start')}>
        {showSender && !isLocal && (
          <span className="sr-only">
            {senderName}
          </span>
        )}

        <div
          className={cn(
            'px-4 py-3 rounded-2xl text-sm shadow-sm break-words whitespace-pre-wrap',
            isLocal
              ? 'bg-[#0056D2] text-white rounded-br-none' // Blue for local
              : 'bg-[#2A2A2A] text-white/90 rounded-bl-none' // Dark gray for remote
          )}
        >
          {renderContent(content)}
        </div>

        {showTimestamp && (
          <div className={cn('flex items-center gap-1.5 mt-0.5', isLocal ? 'justify-end' : 'justify-start')}>
            {!isLocal && (
                <CheckCheck className="w-3 h-3 text-[#0056D2]" />
            )}
            <span className="text-[10px] text-gray-400 font-medium">
              {formatTime(timestamp)}
            </span>
          </div>
        )}
      </div>

      {isLocal && (
        <Avatar
          name={senderName}
          src={senderAvatar}
          size="md"
          className="mt-1 !w-10 !h-10 border-2 border-[#0D0D0D]"
        />
      )}
    </div>
  );
});

MessageBubble.displayName = 'MessageBubble';
