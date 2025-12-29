import React from 'react';
import { Pin, X, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import { IconButton } from '../atomic/IconButton';

export interface PinnedMessageBannerProps {
  message: {
    content: string;
    senderName: string;
    timestamp: Date;
  };
  onUnpin?: () => void;
  onJumpToMessage?: () => void;
  className?: string;
}

export const PinnedMessageBanner: React.FC<PinnedMessageBannerProps> = ({
  message,
  onUnpin,
  onJumpToMessage,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 bg-[var(--chalk-bg-tertiary)] border-b border-[var(--chalk-border-color)] text-sm',
        className
      )}
    >
      <div className="flex-shrink-0 text-[var(--chalk-accent)]">
        <Pin size={16} className="fill-current" />
      </div>

      <div 
        className="flex-1 min-w-0 cursor-pointer" 
        onClick={onJumpToMessage}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            onJumpToMessage?.();
          }
        }}
      >
        <div className="font-semibold text-[var(--chalk-text-primary)]">
          Pinned Message
        </div>
        <div className="text-[var(--chalk-text-secondary)] truncate">
          <span className="font-medium mr-1">{message.senderName}:</span>
          {message.content}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {onJumpToMessage && (
           <IconButton
             icon={<ChevronRight size={16} />}
             variant="ghost"
             size="sm"
             onClick={onJumpToMessage}
             aria-label="Jump to message"
           />
        )}
        {onUnpin && (
          <IconButton
            icon={<X size={16} />}
            variant="ghost"
            size="sm"
            onClick={onUnpin}
            aria-label="Unpin message"
          />
        )}
      </div>
    </div>
  );
};
