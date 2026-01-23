import React from 'react';
import { cn } from '../../utils/cn';
import { Avatar } from '../atomic/Avatar';
import { Tick01Icon, TickDouble01Icon } from '../../utils/icons';

export interface MessageBubbleProps {
  content: string;
  senderName: string;
  senderAvatar?: string;
  timestamp: Date;
  isLocal?: boolean;
  isSystem?: boolean;
  showSender?: boolean;
  showTimestamp?: boolean;
  showAvatar?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  status?: 'sending' | 'sent' | 'delivered' | 'read';
  className?: string;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export const MessageBubble = React.memo<MessageBubbleProps>(({
  content,
  senderName,
  senderAvatar,
  timestamp,
  isLocal = false,
  isSystem = false,
  showSender: _showSender = true,
  showTimestamp = true,
  showAvatar = true,
  isFirstInGroup: _isFirstInGroup = true,
  isLastInGroup = true,
  status = 'delivered',
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
    const parts = text.split(URL_REGEX);

    return parts.map((part, index) => {
      if (part.match(URL_REGEX)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  const renderStatus = () => {
    if (!isLocal) return null;

    switch (status) {
      case 'sending':
        return (
          <div className="w-3 h-3 rounded-full animate-spin border-2 border-muted-foreground/40 border-t-transparent" />
        );
      case 'sent':
        return <Tick01Icon className="w-3.5 h-3.5 text-muted-foreground" />;
      case 'delivered':
        return <TickDouble01Icon className="w-3.5 h-3.5 text-muted-foreground" />;
      case 'read':
        return <TickDouble01Icon className="w-3.5 h-3.5 text-primary" />;
      default:
        return null;
    }
  };

  if (isSystem) {
    return (
      <div className={cn('flex flex-col items-center gap-1 py-3', className)}>
        <div className="px-4 py-2 rounded-full bg-muted text-muted-foreground">
          <p className="text-xs text-center">
            {renderContent(content)}
          </p>
        </div>
        {showTimestamp && (
          <span className="text-[11px] text-muted-foreground">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-end gap-3 w-full px-4",
        isLastInGroup ? "mb-4" : "mb-1",
        isLocal ? "justify-end" : "justify-start",
        className
      )}
    >
      {!isLocal && (
        <div className="shrink-0 w-10">
          {showAvatar && isLastInGroup && (
            <Avatar
              name={senderName}
              src={senderAvatar}
              size="sm"
              className="!w-10 !h-10"
            />
          )}
        </div>
      )}

      <div className={cn("flex flex-col max-w-[70%]", isLocal ? "items-end" : "items-start")}>
        <div
          className={cn(
            "px-4 py-3 backdrop-blur-sm",
            isLocal
              ? "bg-primary text-primary-foreground rounded-[20px_4px_20px_20px]"
              : "bg-card text-card-foreground rounded-[4px_20px_20px_20px]"
          )}
        >
          <p className="text-sm leading-relaxed break-words">
            {renderContent(content)}
          </p>
        </div>

        {showTimestamp && isLastInGroup && (
          <div className={cn(
            "flex items-center gap-1.5 mt-1 px-1",
            isLocal ? "flex-row-reverse" : "flex-row"
          )}>
            <span className="text-[11px] text-muted-foreground">
              {formatTime(timestamp)}
            </span>
            {renderStatus()}
          </div>
        )}
      </div>

      {isLocal && (
        <div className="shrink-0 w-10">
          {showAvatar && isLastInGroup && (
            <Avatar
              name={senderName}
              src={senderAvatar}
              size="sm"
              className="!w-10 !h-10"
            />
          )}
        </div>
      )}
    </div>
  );
});

MessageBubble.displayName = 'MessageBubble';
