import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useHaptics } from "../../hooks/ui/useHaptics";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { Search01Icon } from "../../utils/icons";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  position?: "top" | "bottom";
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
  size?: "default" | "compact";
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

const EMOJI_KEYWORDS: Record<string, string> = {
  "😀": "grinning smile happy face", "😃": "smiley happy face big eyes", "😄": "smile happy face", "😁": "grin teeth face", "😅": "sweat smile face", "😂": "cry tears joy laugh face", "🤣": "rofl laughing face", "😊": "blush happy face", "😇": "innocent angel face", "🙂": "slightly smiling happy face", "😉": "wink face", "😌": "relieved face", "😍": "heart eyes love face", "🥰": "hearts love face", "😘": "kissing heart face", "😋": "yum tongue face", "😛": "stuck out tongue face", "🤪": "zany crazy face", "🤨": "raised eyebrow face", "🧐": "monocle inspecting face", "🤓": "nerd glasses face", "😎": "sunglasses cool face", "🥳": "partying face", "😏": "smirk sly face", "😒": "unamused face", "🙄": "roll eyes face", "😬": "grimacing teeth face", "😮": "open mouth surprise face", "😯": "hushed surprise face", "😲": "astonished surprise face", "😳": "flushed embarrassed face", "🥺": "pleading puppy eyes face", "😢": "cry sad face", "😭": "sob crying face", "😤": "triumph steam face", "😠": "angry mad face", "🤯": "exploding head mind blown", "😱": "scream scared face", "🥶": "cold freezing face", "🥵": "hot sweating face",
  "👋": "wave hello hand", "🤚": "raised back hand", "🖐️": "raised hand fingers splayed", "✋": "raised hand stop", "🖖": "vulcan salute star trek", "👌": "ok perfect hand", "🤌": "pinched fingers italian", "🤏": "pinching small hand", "✌️": "peace victory hand", "🤞": "crossed fingers luck", "🤟": "love you hand", "🤘": "horns rock on hand", "🤙": "call me shaka hand", "👈": "point left hand", "👉": "point right hand", "👆": "point up hand", "👇": "point down hand", "☝️": "point up index", "👍": "thumbs up yes cool", "👎": "thumbs down no", "✊": "fist power", "👊": "fist bump punch", "🤛": "left-facing fist", "🤜": "right-facing fist", "👏": "clap applause hand", "🙌": "raise hands celebrate", "👐": "open hands", "🤲": "palms up together", "🤝": "handshake agree", "🙏": "pray please thank you", "💪": "muscle flex strong", "🦾": "mechanical arm robot",
  "❤️": "red heart love", "🧡": "orange heart love", "💛": "yellow heart love", "💚": "green heart love", "💙": "blue heart love", "💜": "purple heart love", "🖤": "black heart love", "🤍": "white heart love", "🤎": "brown heart love", "💔": "broken heart sad", "❤️‍🔥": "heart on fire", "❤️‍🩹": "mending heart heal", "💕": "two hearts love", "💞": "revolving hearts love", "💓": "beating heart love", "💗": "growing heart love", "💖": "sparkling heart love", "💘": "heart with arrow love", "💝": "heart with ribbon gift", "💟": "heart decoration love", "♥️": "heart suit card", "😻": "heart eyes cat love",
  "🎉": "party popper celebrate", "🎊": "confetti ball celebrate", "🎈": "balloon party celebrate", "🎁": "gift present box", "🎀": "ribbon bow pink", "🏆": "trophy win first", "🥇": "1st place medal gold", "🏅": "sports medal win", "⭐": "star yellow shine", "🌟": "glowing star shine", "✨": "sparkles magic shine", "💫": "dizzy shooting star", "🔥": "fire hot lit flame", "💥": "collision explosion boom", "💯": "hundred percent perfect", "🤩": "star struck eyes", "🥂": "clinking glasses cheers", "🍾": "champagne bottle pop", "🎆": "fireworks celebrate night", "🎇": "sparkler firework celebrate", "🪅": "pinata party celebrate", "🎯": "bullseye target hit",
  "💡": "light bulb idea smart", "📌": "pushpin location pin", "📍": "round pushpin location", "🔔": "bell notification alarm", "🔕": "bell with slash silent", "📢": "loudspeaker announce", "📣": "megaphone cheer announce", "💬": "speech balloon chat", "💭": "thought balloon think", "🗯️": "anger right balloon mad", "✅": "check mark button yes", "❌": "cross mark no wrong", "❓": "question mark ask", "❗": "exclamation mark alert", "💤": "zzz sleep tired", "💢": "anger symbol mad", "💦": "sweat drops water", "💨": "dashing away wind speed", "🕐": "one oclock time clock", "⏰": "alarm clock time", "📅": "calendar date", "📆": "tear-off calendar date", "🔒": "locked lock secure", "🔓": "unlocked lock open", "🔑": "key lock secure"
};

type CategoryKey = keyof typeof EMOJI_CATEGORIES;

export const ReactionPicker = React.memo(({ isOpen, onClose, onSelect, recentReactions = [], position = "top", participantColorSeed, participantGradientPreference, className, size = "default" }: ReactionPickerProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("smileys");
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

  const quickReactions = recentReactions.length >= 6 ? recentReactions.slice(0, 6) : DEFAULT_QUICK_REACTIONS;
  const categories = Object.entries(EMOJI_CATEGORIES) as [CategoryKey, (typeof EMOJI_CATEGORIES)[CategoryKey]][];

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

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />

      {/* Picker Panel */}
      <div
        className={cn(
          "absolute z-50 rounded-2xl shadow-2xl flex flex-col overflow-hidden",
          size === "compact" ? "w-[260px]" : "w-[340px]",
          "bg-popover shadow-2xl",
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
        <div className={cn("flex items-center justify-between border-b border-border/50", size === "compact" ? "px-2 py-1.5" : "px-3 py-2")}>
          <div className="flex items-center justify-between w-full">
            {quickReactions.map((emoji, index) => (
              <button
                key={`quick-${emoji}-${index}`}
                onClick={() => handleSelect(emoji)}
                className={cn(
                  "flex items-center justify-center rounded-xl transition-all duration-150",
                  size === "compact" ? "w-8 h-8 text-xl" : "w-10 h-10 text-2xl",
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
        <div className={cn("flex items-center gap-2 border-b border-border/50 bg-accent/30 focus-within:bg-accent/40 transition-colors", size === "compact" ? "px-2 py-1.5" : "px-3 py-2")}>
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
        <div className={cn("flex", size === "compact" ? "h-48" : "h-64")}>
           {/* Left Rail - Only show when not searching */}
            {!isSearching && (
              <div className={cn("flex flex-col items-center py-2 gap-1 border-r border-border/50 bg-accent/30 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]", size === "compact" ? "w-10" : "w-12")}>
                {categories.map(([key, category]) => (
                  <button
                    key={key}
                    onClick={() => {
                      void trigger("selection");
                      setActiveCategory(key);
                    }}
                    className={cn(
                      "rounded-xl flex items-center justify-center transition-all",
                      size === "compact" ? "w-8 h-8 text-base" : "w-9 h-9 text-lg",
                      activeCategory === key 
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
            )}
           
           {/* Emoji Grid */}
            <div className={cn("flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent", size === "compact" ? "p-2" : "p-3")}>
             {isSearching && currentEmojis.length === 0 ? (
               <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                 No emojis found
               </div>
             ) : (
                <div className={cn("grid gap-1", isSearching ? (size === "compact" ? "grid-cols-6" : "grid-cols-7") : (size === "compact" ? "grid-cols-5" : "grid-cols-6"))}>
                 {currentEmojis.map((emoji, index) => (
                   <button
                     key={`${emoji}-${index}`}
                     onClick={() => handleSelect(emoji)}
                     className={cn(
                        size === "compact" ? "w-8 h-8 text-lg" : "w-10 h-10 text-xl",
                        "flex items-center justify-center rounded-lg transition-all duration-150",
                       "hover:bg-primary/20 hover:scale-110 active:scale-95",
                       !prefersReducedMotion && "hover:animate-pulse"
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
      </div>
    </>
  );
});

ReactionPicker.displayName = "ReactionPicker";
