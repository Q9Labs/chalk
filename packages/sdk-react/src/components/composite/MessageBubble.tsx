import React from 'react';
import { cn } from '../../utils/cn';
import { Avatar } from '../atomic/Avatar';

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

export const MessageBubble: React.FC<MessageBubbleProps> = ({
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
        'flex gap-3 w-full max-w-[85%]',
        isLocal ? 'ml-auto flex-row-reverse' : 'mr-auto',
        className
      )}
    >
      {!isLocal && showSender && (
        <Avatar
          name={senderName}
          src={senderAvatar}
          size="sm"
          className="mt-0.5"
        />
      )}
      
      {!isLocal && !showSender && <div className="w-8" />} 

      <div className={cn('flex flex-col gap-1', isLocal ? 'items-end' : 'items-start')}>
        {showSender && !isLocal && (
          <span className="text-xs font-medium text-[var(--chalk-text-secondary)] ml-1">
            {senderName}
          </span>
        )}

        <div
          className={cn(
            'px-3 py-2 rounded-[var(--chalk-border-radius-lg)] text-sm shadow-sm break-words whitespace-pre-wrap',
            isLocal
              ? 'bg-[var(--chalk-primary)] text-white rounded-tr-none'
              : 'bg-[var(--chalk-bg-secondary)] text-[var(--chalk-text-primary)] rounded-tl-none border border-[var(--chalk-border-color)]'
          )}
        >
          {renderContent(content)}
        </div>

        {showTimestamp && (
          <span className={cn('text-[10px] text-[var(--chalk-text-muted)]', isLocal ? 'mr-1' : 'ml-1')}>
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  );
};
