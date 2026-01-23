import React from 'react';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

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
  const prefersReducedMotion = usePrefersReducedMotion();
  if (!isOpen) return null;

  const handleSelect = (emoji: string) => {
    onSelect(emoji);
    onClose();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          "absolute z-50 p-2 w-64 rounded-lg shadow-xl",
          "bg-[var(--popover,var(--chalk-bg-panel))]",
          "border border-[var(--border,var(--chalk-border-subtle))]",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200",
          position === 'top' ? "bottom-full mb-2" : "top-full mt-2",
          "left-1/2 -translate-x-1/2",
          className
        )}
        role="dialog"
        aria-label="Reaction picker"
      >
        {recentReactions.length > 0 && (
          <div className="mb-2 pb-2 border-b border-[var(--border,var(--chalk-border-subtle))]">
            <div className="text-xs px-1 mb-1 text-[var(--muted-foreground,var(--chalk-text-muted))]">Recent</div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {recentReactions.map((emoji, i) => (
                <button
                  key={`recent-${i}`}
                  onClick={() => handleSelect(emoji)}
                  className={cn(
                    "w-8 h-8 flex items-center justify-center rounded text-xl transition-colors",
                    "hover:bg-[var(--accent,var(--chalk-bg-tertiary))]"
                  )}
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
              onClick={() => handleSelect(emoji)}
              className={cn(
                "w-8 h-8 flex items-center justify-center rounded text-xl transition-colors",
                "hover:bg-[var(--accent,var(--chalk-bg-tertiary))]"
              )}
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
