import React from 'react';
import { cn } from '../../utils/cn';

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  position?: 'top' | 'bottom';
  className?: string;
}

const DEFAULT_REACTIONS = ['👍', '👎', '😀', '😂', '❤️', '🎉', '👏', '🔥', '😮', '😢'];

export const ReactionPicker = React.memo(({
  isOpen,
  onClose,
  onSelect,
  recentReactions = [],
  position = 'top',
  className,
}: ReactionPickerProps) => {
  if (!isOpen) return null;

  return (
    <>
      <div 
        className="fixed inset-0 z-40" 
        onClick={onClose} 
        aria-hidden="true"
      />
      <div 
        className={cn(
          "absolute z-50 p-2 bg-background-primary rounded-lg shadow-xl border border-border animate-in fade-in zoom-in-95 duration-200",
          position === 'top' ? "bottom-full mb-2" : "top-full mt-2",
          "left-1/2 -translate-x-1/2 w-64",
          className
        )}
        role="dialog"
        aria-label="Reaction picker"
      >
        {recentReactions.length > 0 && (
          <div className="mb-2 pb-2 border-b border-border">
            <div className="text-xs text-foreground-secondary mb-1 px-1">Recent</div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {recentReactions.map((emoji, i) => (
                <button
                  key={`recent-${i}`}
                  onClick={() => { onSelect(emoji); onClose(); }}
                  className="w-8 h-8 flex items-center justify-center rounded hover:bg-background-tertiary transition-colors text-xl"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
        
        <div className="grid grid-cols-5 gap-1">
          {DEFAULT_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => { onSelect(emoji); onClose(); }}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-background-tertiary transition-colors text-xl"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </>
  );
});

ReactionPicker.displayName = 'ReactionPicker';
