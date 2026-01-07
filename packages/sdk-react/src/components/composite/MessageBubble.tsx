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

const styles = {
  senderBubble: {
    background: 'var(--chalk-accent)',
    color: '#FFFFFF',
    borderRadius: '20px 4px 20px 20px', // top-left, TOP-RIGHT (tail), bottom-right, bottom-left
  } as React.CSSProperties,

  receiverBubble: {
    background: 'var(--chalk-bg-tertiary)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    color: 'var(--chalk-text-primary)',
    borderRadius: '4px 20px 20px 20px', // TOP-LEFT (tail), top-right, bottom-right, bottom-left
  } as React.CSSProperties,

  systemBubble: {
    background: 'var(--chalk-bg-tertiary)',
    color: 'var(--chalk-text-muted)',
  } as React.CSSProperties,

  timestamp: {
    color: 'var(--chalk-text-muted)',
    fontSize: '11px',
  } as React.CSSProperties,
};

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
            style={{ color: 'var(--chalk-accent)', textDecoration: 'underline' }}
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  // Render read receipt status (blue double-ticks like reference)
  const renderStatus = () => {
    if (!isLocal) return null;

    switch (status) {
      case 'sending':
        return (
          <div
            className="w-3 h-3 rounded-full animate-spin"
            style={{ border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'transparent' }}
          />
        );
      case 'sent':
        return <Check className="w-3.5 h-3.5" style={{ color: 'var(--chalk-text-muted)' }} />;
      case 'delivered':
        return <CheckCheck className="w-3.5 h-3.5" style={{ color: 'var(--chalk-text-muted)' }} />;
      case 'read':
        return <CheckCheck className="w-3.5 h-3.5" style={{ color: 'var(--chalk-accent)' }} />;
      default:
        return null;
    }
  };

  // System message (join/leave notifications)
  if (isSystem) {
    return (
      <div className={cn('flex flex-col items-center gap-1 py-3', className)}>
        <div
          className="px-4 py-2 rounded-full"
          style={styles.systemBubble}
        >
          <p style={{ fontSize: '12px', textAlign: 'center' }}>
            {renderContent(content)}
          </p>
        </div>
        {showTimestamp && (
          <span style={styles.timestamp}>
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    );
  }

  // SENDER (you) = isLocal=true = RIGHT side, blue, tail top-right
  // RECEIVER (others) = isLocal=false = LEFT side, glassmorphism, tail top-left
  const bubbleStyle: React.CSSProperties = isLocal ? styles.senderBubble : styles.receiverBubble;

  // Use inline styles to guarantee positioning works regardless of Tailwind
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '12px',
    width: '100%',
    padding: '0 16px',
    marginBottom: isLastInGroup ? '16px' : '4px',
    // KEY: This controls LEFT vs RIGHT positioning
    justifyContent: isLocal ? 'flex-end' : 'flex-start',
    flexDirection: 'row',
  };

  const contentStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: isLocal ? 'flex-end' : 'flex-start',
    maxWidth: '70%',
  };

  const timestampContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '4px',
    padding: '0 4px',
    flexDirection: isLocal ? 'row-reverse' : 'row',
  };

  return (
    <div style={containerStyle} className={className}>
      {/* Avatar for RECEIVER messages (left side) */}
      {!isLocal && (
        <div style={{ flexShrink: 0, width: '40px' }}>
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

      {/* Message content */}
      <div style={contentStyle}>
        {/* Message bubble with asymmetric talk-bubble shape */}
        <div
          style={{
            ...bubbleStyle,
            padding: '12px 16px',
          }}
        >
          <p style={{
            color: isLocal ? '#FFFFFF' : '#E5E5E5',
            fontSize: '14px',
            lineHeight: '1.5',
            margin: 0,
            wordBreak: 'break-word',
          }}>
            {renderContent(content)}
          </p>
        </div>

        {/* Timestamp and status */}
        {showTimestamp && isLastInGroup && (
          <div style={timestampContainerStyle}>
            <span style={styles.timestamp}>
              {formatTime(timestamp)}
            </span>
            {renderStatus()}
          </div>
        )}
      </div>

      {/* Avatar for SENDER messages (right side) */}
      {isLocal && (
        <div style={{ flexShrink: 0, width: '40px' }}>
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
