import React, { useCallback, useEffect, useRef } from "react";

import { useHaptics } from "../../internal/useHaptics";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";

export interface ReactionTrayProps {
  readonly reactions: readonly string[];
  readonly onSelect: (emoji: string) => void;
  readonly onClose: () => void;
  readonly position?: "top" | "bottom";
  readonly className?: string;
}

/**
 * One row of large emoji buttons that pops up over the control bar. Arrow keys move between
 * emojis, Home/End jump, Escape and clicking outside close. Focus lands on the first emoji.
 */
export function ReactionTray({ reactions, onSelect, onClose, position = "top", className }: ReactionTrayProps): React.JSX.Element {
  const skin = useSkin();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector("button")?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelect = useCallback(
    (emoji: string) => {
      void trigger("success");
      onSelect(emoji);
    },
    [onSelect, trigger],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = listRef.current ? [...listRef.current.querySelectorAll("button")] : [];
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step === 0 ? -1 : (index + step + buttons.length) % buttons.length;
    if (target < 0) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  const buttons = reactions.map((emoji) => (
    <button
      key={emoji}
      type="button"
      onClick={() => handleSelect(emoji)}
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center rounded-full text-[26px] leading-none transition-transform duration-150 ease-out focus-visible:outline-none active:scale-95",
        skin === "classic" ? "hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]" : "hover:bg-[var(--chalk-app-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]",
        !prefersReducedMotion && "hover:-translate-y-1 hover:scale-125 focus-visible:-translate-y-1 focus-visible:scale-125",
      )}
      aria-label={`React with ${emoji}`}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  ));

  const trayClassName = cn("absolute left-1/2 z-50 -translate-x-1/2", position === "top" ? "bottom-full mb-3" : "top-full mt-3", !prefersReducedMotion && "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200", className);

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden="true" />
      {skin === "classic" ? (
        <div
          ref={listRef}
          className={cn(trayClassName, "flex items-center gap-0.5 rounded-full bg-[var(--chalk-app-panel)] p-1.5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-control)] ring-1 ring-[var(--chalk-app-line)]")}
          role="toolbar"
          aria-label="Reactions"
          onKeyDown={handleKeyDown}
        >
          {buttons}
        </div>
      ) : (
        <ChalkPanel ref={listRef} filled className={cn(trayClassName, "rounded-full")} contentClassName="flex items-center gap-0.5 p-1.5" role="toolbar" aria-label="Reactions" onKeyDown={handleKeyDown} seed="reaction-tray">
          {buttons}
        </ChalkPanel>
      )}
    </>
  );
}
