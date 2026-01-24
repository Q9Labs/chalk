import React, { useState, useCallback, useEffect } from 'react';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { Cancel01Icon } from '../../utils/icons';

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  position?: 'top' | 'bottom';
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
  className,
}: ReactionPickerProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('smileys');

  // Reset to smileys when closed
  useEffect(() => {
    if (!isOpen) {
      setActiveCategory(recentReactions.length > 0 ? 'recent' : 'smileys');
    }
  }, [isOpen, recentReactions.length]);

  const handleSelect = useCallback((emoji: string) => {
    onSelect(emoji);
    onClose();
  }, [onSelect, onClose]);

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
          "bg-zinc-900/95 backdrop-blur-xl",
          "border border-teal-500/20",
          "ring-1 ring-white/5",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200",
          position === 'top' ? "bottom-full mb-3" : "top-full mt-3",
          "left-1/2 -translate-x-1/2",
          className
        )}
        role="dialog"
        aria-label="Reaction picker"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h3 className="text-sm font-semibold text-white">Reactions</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <Cancel01Icon size={16} />
          </button>
        </div>

        {/* Category Tabs */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10 bg-white/5">
          {categories.map(([key, category]) => (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                activeCategory === key
                  ? "bg-teal-500 text-white shadow-lg shadow-teal-500/25"
                  : "text-zinc-400 hover:text-white hover:bg-white/10"
              )}
              aria-label={key === 'recent' ? 'Recent reactions' : `${category.label} category`}
            >
              {key === 'recent' ? '🕐' : category.label}
            </button>
          ))}
        </div>

        {/* Emoji Grid */}
        <div className="p-3 max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent">
          <div className="grid grid-cols-8 gap-1">
            {currentEmojis.map((emoji, index) => (
              <button
                key={`${emoji}-${index}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  "w-9 h-9 flex items-center justify-center rounded-lg text-xl",
                  "transition-all duration-150",
                  "hover:bg-teal-500/20 hover:scale-110",
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
        <div className="px-4 py-2 border-t border-white/10 bg-white/5">
          <p className="text-xs text-zinc-500 text-center">
            Click to react • <span className="text-teal-400">Esc</span> to close
          </p>
        </div>
      </div>
    </>
  );
});

ReactionPicker.displayName = 'ReactionPicker';
