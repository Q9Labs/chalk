import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useHaptics } from "../../internal/useHaptics";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { Search01Icon } from "../../utils/icons";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { DEFAULT_QUICK_REACTIONS, EMOJI_CATEGORIES, EMOJI_KEYWORDS, type ReactionCategoryKey } from "@q9labsai/chalk-ui/reactions";
import type { ReactionPickerProps } from "./ReactionPicker";
import { ReactionTray } from "./ReactionTray";

export const ClassicReactionPicker = React.memo(({ isOpen, onClose, onSelect, recentReactions = [], allowedReactions, position = "top", participantColorSeed, participantGradientPreference, className, size = "default" }: ReactionPickerProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const [activeCategory, setActiveCategory] = useState<ReactionCategoryKey>("smileys");
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

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

  const quickReactions = allowedReactions ?? (recentReactions.length >= 6 ? recentReactions.slice(0, 6) : DEFAULT_QUICK_REACTIONS);
  const categories = Object.entries(EMOJI_CATEGORIES) as [ReactionCategoryKey, (typeof EMOJI_CATEGORIES)[ReactionCategoryKey]][];

  // Search for specific emojis when query exists
  const isSearching = searchQuery.trim() !== "";
  const query = searchQuery.toLowerCase().trim();

  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    const results: string[] = [];
    for (const [emoji, keywords] of Object.entries(EMOJI_KEYWORDS)) {
      if (keywords.includes(query)) {
        results.push(emoji);
      }
    }
    return results;
  }, [query, isSearching]);

  const currentEmojis = isSearching ? searchResults : EMOJI_CATEGORIES[activeCategory]?.emojis || [];

  if (!isOpen) return null;

  if (allowedReactions) {
    return (
      <ReactionTray
        reactions={allowedReactions}
        position={position}
        className={className}
        onSelect={(emoji) => {
          onSelect(emoji);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />

      {/* Picker Panel */}
      <div
        className={cn(
          "absolute z-50 rounded-2xl shadow-2xl flex flex-col overflow-hidden",
          size === "mini" ? "w-[220px]" : size === "compact" ? "w-[260px]" : "w-[340px]",
          "bg-[var(--chalk-surface)] shadow-2xl",
          "border border-[var(--chalk-line)]",
          "ring-1 ring-[var(--chalk-surface)]",
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
        <div className={cn("flex items-center justify-between border-b border-[var(--chalk-line)]", size === "mini" ? "px-1.5 py-1" : size === "compact" ? "px-2 py-1.5" : "px-3 py-2")}>
          <div className="flex items-center justify-between w-full">
            {quickReactions.map((emoji, index) => (
              <button
                type="button"
                key={`quick-${emoji}-${index}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  "flex items-center justify-center rounded-xl transition-all duration-150",
                  size === "mini" ? "w-6 h-6 text-lg" : size === "compact" ? "w-8 h-8 text-xl" : "w-10 h-10 text-2xl",
                  "hover:bg-[var(--chalk-accent)] hover:scale-110 active:scale-95",
                  !prefersReducedMotion && "hover:animate-pulse",
                )}
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        {!allowedReactions ? (
          <div className={cn("flex items-center gap-2 border-b border-[var(--chalk-line)] bg-[var(--chalk-stage)] focus-within:bg-[var(--chalk-stage)] transition-colors", size === "mini" ? "px-1.5 py-1" : size === "compact" ? "px-2 py-1.5" : "px-3 py-2")}>
            <Search01Icon size={16} className="text-[var(--chalk-muted-text)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search categories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent border-none text-sm text-[var(--chalk-text)] placeholder:text-[var(--chalk-muted-text)] focus:outline-none min-w-0"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--chalk-line)] bg-[var(--chalk-canvas)] text-[10px] font-medium text-[var(--chalk-muted-text)] uppercase">Esc</kbd>
          </div>
        ) : null}

        {/* Vertical Rail + Matrix */}
        {!allowedReactions ? (
          <div className={cn("flex", size === "mini" ? "h-36" : size === "compact" ? "h-48" : "h-64")}>
            {/* Left Rail - Only show when not searching */}
            {!isSearching && (
              <div className={cn("flex flex-col items-center py-2 gap-1 border-r border-[var(--chalk-line)] bg-[var(--chalk-stage)] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]", size === "mini" ? "w-8" : size === "compact" ? "w-10" : "w-12")}>
                {categories.map(([key, category]) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => {
                      void trigger("selection");
                      setActiveCategory(key);
                    }}
                    className={cn(
                      "rounded-xl flex items-center justify-center transition-all",
                      size === "mini" ? "w-6 h-6 text-sm" : size === "compact" ? "w-8 h-8 text-base" : "w-9 h-9 text-lg",
                      activeCategory === key ? "bg-[var(--chalk-accent)] text-[var(--chalk-accent-text)] shadow-[var(--chalk-shadow)]" : "text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]",
                    )}
                    aria-label={category.name}
                    title={category.name}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
            )}

            {/* Emoji Grid */}
            <div className={cn("flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent", size === "mini" ? "p-1.5" : size === "compact" ? "p-2" : "p-3")}>
              {isSearching && currentEmojis.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-[var(--chalk-muted-text)]">No emojis found</div>
              ) : (
                <div className={cn("grid gap-1", isSearching ? (size === "mini" ? "grid-cols-5" : size === "compact" ? "grid-cols-6" : "grid-cols-7") : size === "mini" ? "grid-cols-5" : size === "compact" ? "grid-cols-5" : "grid-cols-6")}>
                  {currentEmojis.map((emoji, index) => (
                    <button
                      type="button"
                      key={`${emoji}-${index}`}
                      onClick={() => handleSelect(emoji)}
                      className={cn(
                        size === "mini" ? "w-7 h-7 text-base" : size === "compact" ? "w-8 h-8 text-lg" : "w-10 h-10 text-xl",
                        "flex items-center justify-center rounded-lg transition-all duration-150",
                        "hover:bg-[var(--chalk-accent)] hover:scale-110 active:scale-95",
                        !prefersReducedMotion && "hover:animate-pulse",
                      )}
                      aria-label={`React with ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
});

ClassicReactionPicker.displayName = "ReactionPicker";
