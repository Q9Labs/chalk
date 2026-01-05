import React from 'react';
import { cn } from '../../utils/cn';
import { Avatar } from '../atomic/Avatar';
import { Check, CheckCheck } from 'lucide-react';

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

export const MessageBubble = React.memo<MessageBubbleProps>(({
  content,
  senderName,
  senderAvatar,
  timestamp,
  isLocal = false,
  isSystem = false,
  showSender = true,
  showTimestamp = true,
  showAvatar = true,
  isFirstInGroup = true,
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
            className={cn(
              "underline break-all transition-colors",
              isLocal
                ? "text-white/90 hover:text-white"
                : "text-purple-400 hover:text-purple-300"
            )}
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
        return <div className="w-3 h-3 rounded-full border-2 border-white/40 border-t-transparent animate-spin" />;
      case 'sent':
        return <Check className="w-3.5 h-3.5 text-white/50" />;
      case 'delivered':
        return <CheckCheck className="w-3.5 h-3.5 text-white/50" />;
      case 'read':
        return <CheckCheck className="w-3.5 h-3.5 text-purple-400" />;
      default:
        return null;
    }
  };

  // System message (join/leave notifications)
  if (isSystem) {
    return (
      <div className={cn('flex flex-col items-center gap-1 py-3', className)}>
        <div className="px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10">
          <p className="text-xs text-gray-400 text-center">
            {renderContent(content)}
          </p>
        </div>
        {showTimestamp && (
          <span className="text-[10px] text-gray-500">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex gap-2.5 w-full group',
        isLocal ? 'flex-row' : 'flex-row-reverse', // Swapped: local on left, remote on right
        !isLastInGroup && 'mb-0.5',
        isLastInGroup && 'mb-1',
        className
      )}
    >
      {/* Avatar - only show for last message in group */}
      <div className="w-8 flex-shrink-0">
        {showAvatar && isLastInGroup && isLocal && (
          <Avatar
            name={senderName}
            src={senderAvatar}
            size="sm"
            className="!w-8 !h-8 ring-2 ring-[#0D0D0D] shadow-lg"
          />
        )}
      </div>

      {/* Message content */}
      <div className={cn(
        'flex flex-col max-w-[75%]',
        isLocal ? 'items-start' : 'items-end' // Swapped alignment
      )}>
        {/* Sender name - only for first message in group from local user */}
        {showSender && isFirstInGroup && isLocal && (
          <span className="text-xs font-medium text-gray-400 mb-1 ml-1">
            {senderName}
          </span>
        )}

        {/* Message bubble */}
        <div
          className={cn(
            'relative px-4 py-2.5 text-sm break-words whitespace-pre-wrap',
            'shadow-lg transition-all duration-200',
            // Bubble shape based on position in group - swapped colors
            isLocal ? (
              cn(
                'bg-[#1E1E1E] text-gray-100 border border-white/5', // Local: dark gray (left)
                'rounded-2xl',
                isFirstInGroup && 'rounded-tl-2xl',
                isLastInGroup && 'rounded-bl-md',
                !isFirstInGroup && !isLastInGroup && 'rounded-l-md',
                isFirstInGroup && isLastInGroup && 'rounded-bl-md'
              )
            ) : (
              cn(
                'bg-gradient-to-br from-purple-600 to-purple-700 text-white', // Remote: purple (right)
                'rounded-2xl',
                isFirstInGroup && 'rounded-tr-2xl',
                isLastInGroup && 'rounded-br-md',
                !isFirstInGroup && !isLastInGroup && 'rounded-r-md',
                isFirstInGroup && isLastInGroup && 'rounded-br-md'
              )
            ),
            // Hover effect
            'hover:shadow-xl',
            isLocal ? 'hover:bg-[#252525]' : 'hover:from-purple-500 hover:to-purple-600'
          )}
        >
          {/* Message text */}
          <p className="leading-relaxed">
            {renderContent(content)}
          </p>
        </div>

        {/* Timestamp and status - only for last message in group */}
        {showTimestamp && isLastInGroup && (
          <div className={cn(
            'flex items-center gap-1.5 mt-1 px-1',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-200',
            isLocal ? 'flex-row' : 'flex-row-reverse'
          )}>
            <span className="text-[10px] text-gray-500 font-medium">
              {formatTime(timestamp)}
            </span>
            {renderStatus()}
          </div>
        )}
      </div>

      {/* Spacer for remote messages (instead of avatar) */}
      {!isLocal && <div className="w-8 flex-shrink-0" />}
    </div>
  );
});

MessageBubble.displayName = 'MessageBubble';
