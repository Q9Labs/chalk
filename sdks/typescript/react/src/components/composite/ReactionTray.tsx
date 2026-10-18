import React, { useCallback, useEffect, useRef, useState } from "react";

import { HandIcon } from "../../utils/icons";
import { ShellStyles } from "../control-bar/ShellStyles";
import { useHaptics } from "../../internal/useHaptics";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";

export interface ReactionTrayProps {
  readonly isHandRaised?: boolean;
  readonly onToggleHandRaise?: () => void;
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
export function ReactionTray({ isHandRaised, onToggleHandRaise, reactions, onSelect, onClose, position = "top", className }: ReactionTrayProps): React.JSX.Element {
  const [more, setMore] = useState(false);
  const returnFocus = useRef<Element | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger } = useHaptics();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    listRef.current?.querySelector("button")?.focus();
    return () => {
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
    };
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

  const buttons = (more ? reactions : reactions.slice(0, 6)).map((emoji) => (
    <button key={emoji} type="button" onClick={() => handleSelect(emoji)} className="chalk-shell-emoji" aria-label={`React with ${emoji}`}>
      <span aria-hidden="true">{emoji}</span>
    </button>
  ));

  const trayClassName = cn("absolute left-1/2 z-50 -translate-x-1/2", position === "top" ? "bottom-full mb-3" : "top-full mt-3", !prefersReducedMotion && "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200", className);

  return (
    <>
      <ShellStyles />
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden="true" />
      {
        <div ref={listRef} className={cn(trayClassName, "chalk-shell-reactions", more && "chalk-shell-reactions-expanded")} role="toolbar" aria-label="Reactions" onKeyDown={handleKeyDown}>
          {onToggleHandRaise ? (
            <button type="button" className="chalk-shell-raise" aria-pressed={isHandRaised} onClick={onToggleHandRaise}>
              <HandIcon />
              {isHandRaised ? "Lower hand" : "Raise hand"}
            </button>
          ) : null}
          {buttons}
          {!more && reactions.length > 6 ? (
            <button type="button" className="chalk-shell-emoji" aria-label="More emoji" onClick={() => setMore(true)}>
              …
            </button>
          ) : null}
        </div>
      }
    </>
  );
}
