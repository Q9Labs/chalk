import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useHaptics } from "../../hooks/ui/useHaptics";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { Search01Icon } from "../../utils/icons";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  position?: "top" | "bottom";
  participantColorSeed?: string;
  className?: string;
}

const DEFAULT_QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

const EMOJI_CATEGORIES = {
  smileys: {
    label: "😀",
    name: "Smileys",
    emojis: ["😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂", "😉", "😌", "😍", "🥰", "😘", "😋", "😛", "🤪", "🤨", "🧐", "🤓", "😎", "🥳", "😏", "😒", "🙄", "😬", "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤", "😠", "🤯", "😱", "🥶", "🥵"],
  },
  gestures: {
    label: "👋",
    name: "Gestures",
    emojis: ["👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "💪", "🦾"],
  },
  hearts: {
    label: "❤️",
    name: "Hearts",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️", "😍", "🥰", "😘", "😻"],
  },
  celebration: {
    label: "🎉",
    name: "Celebration",
    emojis: ["🎉", "🎊", "🥳", "🎈", "🎁", "🎀", "🏆", "🥇", "🏅", "⭐", "🌟", "✨", "💫", "🔥", "💥", "💯", "🙌", "👏", "🤩", "🥂", "🍾", "🎆", "🎇", "🪅", "🎯"],
  },
  objects: {
    label: "💡",
    name: "Objects",
    emojis: ["💡", "📌", "📍", "🔔", "🔕", "📢", "📣", "💬", "💭", "🗯️", "✅", "❌", "❓", "❗", "💤", "💢", "💦", "💨", "🕐", "⏰", "📅", "📆", "🔒", "🔓", "🔑"],
  },
} as const;

type CategoryKey = keyof typeof EMOJI_CATEGORIES;

export const ReactionPicker = React.memo(({ isOpen, onClose, onSelect, recentReactions = [], position = "top", participantColorSeed, className }: ReactionPickerProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("smileys");
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setSearchQuery("");
      setActiveCategory("smileys");
    }
  }, [isOpen]);

  const handleSelect = useCallback(
    (emoji: string) => {
      void trigger("success");
      onSelect(emoji);
      onClose();
    },
    [onClose, onSelect, trigger],
  );

  // Handle escape key
  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const quickReactions = recentReactions.length >= 6 ? recentReactions.slice(0, 6) : DEFAULT_QUICK_REACTIONS;
  const categories = Object.entries(EMOJI_CATEGORIES) as [CategoryKey, (typeof EMOJI_CATEGORIES)[CategoryKey]][];

  // Simple search that just filters categories based on search query
  const filteredCategories = searchQuery.trim() !== "" 
    ? categories.filter(([_, cat]) => cat.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : categories;

  const displayCategory = filteredCategories.length > 0 
    ? (filteredCategories.find(([key]) => key === activeCategory) ? activeCategory : (filteredCategories[0]?.[0] ?? activeCategory))
    : activeCategory;

  const currentEmojis = EMOJI_CATEGORIES[displayCategory]?.emojis || [];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />

      {/* Picker Panel */}
      <div
        className={cn(
          "absolute z-50 w-[340px] rounded-2xl shadow-2xl flex flex-col overflow-hidden",
          "bg-popover/95 backdrop-blur-xl",
          "border border-border",
          "ring-1 ring-white/5",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200",
          position === "top" ? "bottom-full mb-3" : "top-full mt-3",
          "left-1/2 -translate-x-1/2",
          className,
        )}
        role="dialog"
        aria-label="Reaction picker"
        style={themeVariables as React.CSSProperties}
      >
        {/* Quick Dock (Top) */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <div className="flex items-center justify-between w-full">
            {quickReactions.map((emoji, index) => (
              <button
                key={`quick-${emoji}-${index}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  "w-10 h-10 flex items-center justify-center rounded-xl text-2xl transition-all duration-150",
                  "hover:bg-primary/20 hover:scale-110 active:scale-95",
                  !prefersReducedMotion && "hover:animate-pulse"
                )}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        {/* Command Palette Search */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-accent/30 focus-within:bg-accent/40 transition-colors">
          <Search01Icon size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search categories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent border-none text-sm text-popover-foreground placeholder:text-muted-foreground focus:outline-none min-w-0"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/50 bg-background/50 text-[10px] font-medium text-muted-foreground uppercase">
            Esc
          </kbd>
        </div>

        {/* Vertical Rail + Matrix */}
        <div className="flex h-64">
           {/* Left Rail */}
           <div className="w-12 flex flex-col items-center py-2 gap-1 border-r border-border/50 bg-accent/30 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
             {filteredCategories.map(([key, category]) => (
                <button
                  key={key}
                  onClick={() => {
                    void trigger("selection");
                    setActiveCategory(key);
                  }}
                  className={cn(
                    "w-9 h-9 rounded-xl flex items-center justify-center text-lg transition-all",
                    displayCategory === key 
                      ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25" 
                      : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-popover-foreground"
                  )}
                  aria-label={category.name}
                  title={category.name}
                >
                  {category.label}
                </button>
             ))}
           </div>
           
           {/* Emoji Grid */}
           <div className="flex-1 p-3 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
             <div className="grid grid-cols-6 gap-1">
               {currentEmojis.map((emoji, index) => (
                 <button
                   key={`${emoji}-${index}`}
                   onClick={() => handleSelect(emoji)}
                   className={cn(
                     "w-10 h-10 flex items-center justify-center rounded-lg text-xl transition-all duration-150",
                     "hover:bg-primary/20 hover:scale-110 active:scale-95",
                     !prefersReducedMotion && "hover:animate-pulse"
                   )}
                   aria-label={`React with ${emoji}`}
                 >
                   {emoji}
                 </button>
               ))}
             </div>
           </div>
        </div>
      </div>
    </>
  );
});

ReactionPicker.displayName = "ReactionPicker";
