import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

  useLayoutEffect(() => {
    returnFocus.current = document.activeElement;
    const tray = listRef.current;
    const frame = tray?.closest<HTMLElement>("[data-part='call-frame']");
    const notices = frame?.querySelector<HTMLElement>("[data-part='toast-stack']");
    const anchor = tray?.closest("[data-part='call-frame']")?.querySelector("[data-part='dock'] button[aria-label='Reactions']") ?? returnFocus.current;
    const place = () => {
      if (!tray || !(anchor instanceof HTMLElement) || !(tray.offsetParent instanceof HTMLElement)) return;
      const trigger = anchor.getBoundingClientRect();
      const parent = tray.offsetParent.getBoundingClientRect();
      const width = tray.offsetWidth;
      const height = tray.offsetHeight;
      tray.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, trigger.x + trigger.width / 2 - width / 2)) - parent.x}px`;
      const top = Math.max(8, Math.min(window.innerHeight - height - 8, position === "top" ? trigger.y - height - 10 : trigger.bottom + 10));
      tray.style.top = `${top - parent.y}px`;
      if (notices?.offsetParent instanceof HTMLElement) {
        // Use the CSS baseline so board-tool clearance remains in effect.
        const baseline = notices.offsetParent.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(notices).bottom);
        frame?.style.setProperty("--chalk-reaction-toast-lift", `${Math.max(0, baseline - top + 12)}px`);
      }
    };
    place();
    const resize = new ResizeObserver(place);
    if (tray) resize.observe(tray);
    window.addEventListener("resize", place);
    listRef.current?.querySelector("button")?.focus();
    return () => {
      window.removeEventListener("resize", place);
      resize.disconnect();
      frame?.style.removeProperty("--chalk-reaction-toast-lift");
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
    };
  }, [position]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Close the mounted reaction tray on Escape; remove the document listener on cleanup.
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

  const trayClassName = cn("absolute z-50", !prefersReducedMotion && "chalk-shell-reactions-enter", className);

  return (
    <>
      <ShellStyles />
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden="true" />
      {
        <div ref={listRef} className={cn(trayClassName, "chalk-shell-reactions", more && "chalk-shell-reactions-expanded")} role="toolbar" aria-label="Reactions" onKeyDown={handleKeyDown}>
          {onToggleHandRaise ? (
            <button type="button" className="chalk-shell-raise" aria-pressed={isHandRaised} onClick={onToggleHandRaise}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
                <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
              </svg>
              Raise hand
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
