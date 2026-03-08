import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useHaptics } from '../../hooks/ui/useHaptics';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { Cancel01Icon } from '../../utils/icons';
import { getParticipantThemeVariables } from '../../utils/colorGenerator';

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  position?: 'top' | 'bottom';
  participantColorSeed?: string;
  className?: string;
}

const EMOJI_CATEGORIES = {
  recent: { label: 'Recent', emojis: [] as string[] },
  smileys: {
    label: '😀',
    emojis: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😋', '😛', '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '🙄', '😬', '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😤', '😠', '🤯', '😱', '🥶', '🥵'],
  },
  gestures: {
    label: '👋',
    emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪', '🦾'],
  },
  hearts: {
    label: '❤️',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '😍', '🥰', '😘', '😻'],
  },
  celebration: {
    label: '🎉',
    emojis: ['🎉', '🎊', '🥳', '🎈', '🎁', '🎀', '🏆', '🥇', '🏅', '⭐', '🌟', '✨', '💫', '🔥', '💥', '💯', '🙌', '👏', '🤩', '🥂', '🍾', '🎆', '🎇', '🪅', '🎯'],
  },
  objects: {
    label: '💡',
    emojis: ['💡', '📌', '📍', '🔔', '🔕', '📢', '📣', '💬', '💭', '🗯️', '✅', '❌', '❓', '❗', '💤', '💢', '💦', '💨', '🕐', '⏰', '📅', '📆', '🔒', '🔓', '🔑'],
  },
} as const;

type CategoryKey = keyof typeof EMOJI_CATEGORIES;

export const ReactionPicker = React.memo(({
  isOpen,
  onClose,
  onSelect,
  recentReactions = [],
  position = 'top',
  participantColorSeed,
  className,
}: ReactionPickerProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('smileys');
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

  // Reset to smileys when closed
  useEffect(() => {
    if (!isOpen) {
      setActiveCategory(recentReactions.length > 0 ? 'recent' : 'smileys');
    }
  }, [isOpen, recentReactions.length]);

  const handleSelect = useCallback((emoji: string) => {
    void trigger('success');
    onSelect(emoji);
    onClose();
  }, [onClose, onSelect, trigger]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const categories = Object.entries(EMOJI_CATEGORIES).filter(
    ([key]) => key !== 'recent' || recentReactions.length > 0
  ) as [CategoryKey, typeof EMOJI_CATEGORIES[CategoryKey]][];

  const currentEmojis = activeCategory === 'recent'
    ? recentReactions
    : EMOJI_CATEGORIES[activeCategory].emojis;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Picker Panel */}
      <div
        className={cn(
          "absolute z-50 w-80 rounded-2xl shadow-2xl overflow-hidden",
          "bg-popover/95 backdrop-blur-xl",
          "border border-border",
          "ring-1 ring-white/5",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200",
          position === 'top' ? "bottom-full mb-3" : "top-full mt-3",
          "left-1/2 -translate-x-1/2",
          className
        )}
        role="dialog"
        aria-label="Reaction picker"
        style={themeVariables as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
          <h3 className="text-sm font-semibold text-popover-foreground">Reactions</h3>
          <button
            onClick={() => {
              void trigger('selection');
              onClose();
            }}
            className="p-1 rounded-lg text-muted-foreground hover:text-popover-foreground hover:bg-accent transition-colors"
            aria-label="Close"
          >
            <Cancel01Icon size={16} />
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border/50 bg-accent/30">
          {categories.map(([key, category]) => (
            <button
              key={key}
              onClick={() => {
                void trigger('selection');
                setActiveCategory(key);
              }}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                activeCategory === key
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                  : "text-muted-foreground hover:text-popover-foreground hover:bg-accent"
              )}
              aria-label={key === 'recent' ? 'Recent reactions' : `${category.label} category`}
            >
              {key === 'recent' ? '🕐' : category.label}
            </button>
          ))}
        </div>

        {/* Emoji Grid */}
        <div className="p-3 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
          <div className="grid grid-cols-8 gap-1">
            {currentEmojis.map((emoji, index) => (
              <button
                key={`${emoji}-${index}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  "w-9 h-9 flex items-center justify-center rounded-lg text-xl",
                  "transition-all duration-150",
                  "hover:bg-primary/20 hover:scale-110",
                  "active:scale-95",
                  !prefersReducedMotion && "hover:animate-pulse"
                )}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border/50 bg-accent/30">
          <p className="text-xs text-muted-foreground text-center">
            Click to react • <span className="text-primary">Esc</span> to close
          </p>
        </div>
      </div>
    </>
  );
});

ReactionPicker.displayName = 'ReactionPicker';
