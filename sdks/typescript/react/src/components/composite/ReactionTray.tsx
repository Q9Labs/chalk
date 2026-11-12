import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ShellIcon } from "../control-bar/ShellIcon";
import { ShellStyles } from "../control-bar/ShellStyles";
import { useHaptics } from "../../internal/useHaptics";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";

/** How each quick reaction moves on hover; any other emoji pops. */
const EMOJI_MOVE = new Map([
  ["👍", "nod"],
  ["❤️", "beat"],
  ["😂", "shake"],
  ["🎉", "wiggle"],
  ["👏", "clap"],
]);

export interface ReactionTrayProps {
  readonly isHandRaised?: boolean;
  readonly onToggleHandRaise?: () => void;
  readonly reactions: readonly string[];
  readonly onSelect: (emoji: string) => void;
  readonly onClose: () => void;
  readonly position?: "top" | "bottom";
  readonly className?: string;
  /** The emoji are disabled while the call reconnects; the hand still works. */
  readonly emojiPaused?: boolean;
}

/**
 * One row of large emoji buttons that pops up over the control bar. Arrow keys move between
 * emojis, Home/End jump, Escape and clicking outside close. Focus lands on the first emoji.
 */
export function ReactionTray({ isHandRaised, onToggleHandRaise, reactions, onSelect, onClose, position = "top", className, emojiPaused = false }: ReactionTrayProps): React.JSX.Element {
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
    const anchor = tray?.closest("[data-part='call-frame']")?.querySelector("[data-part='dock'] button[data-reactions-trigger]") ?? returnFocus.current;
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
    listRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("resize", place);
      resize.disconnect();
      frame?.style.removeProperty("--chalk-reaction-toast-lift");
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
    };
  }, [position]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Close the mounted reaction tray on Escape or on a press anywhere else (the dock, header and panels sit above the backdrop, which keeps its click so a press on the stage doesn't fall through); remove the document listeners on cleanup.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The reactions button toggles the tray itself, so a press on it is left to its own click.
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || listRef.current?.contains(target) || target.closest(".chalk-shell-reactions-button, [data-reactions-backdrop]")) return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onClose]);

  const handleSelect = useCallback(
    (emoji: string) => {
      void trigger("success");
      onSelect(emoji);
    },
    [onSelect, trigger],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = listRef.current ? [...listRef.current.querySelectorAll("button:not(:disabled)")].filter((button) => button instanceof HTMLElement) : [];
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step === 0 ? -1 : (index + step + buttons.length) % buttons.length;
    if (target < 0) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  const buttons = (more ? reactions : reactions.slice(0, 6)).map((emoji) => (
    <button key={emoji} type="button" disabled={emojiPaused} onClick={() => handleSelect(emoji)} className="chalk-shell-emoji" data-move={EMOJI_MOVE.get(emoji) ?? "pop"} aria-label={`React with ${emoji}`}>
      <span aria-hidden="true">{emoji}</span>
    </button>
  ));

  const trayClassName = cn("absolute z-50", !prefersReducedMotion && "chalk-shell-reactions-enter", className);

  return (
    <>
      <ShellStyles />
      <div className="fixed inset-0 z-20" data-reactions-backdrop onClick={onClose} aria-hidden="true" />
      {
        <div ref={listRef} className={cn(trayClassName, "chalk-shell-reactions", more && "chalk-shell-reactions-expanded")} role="toolbar" aria-label="Reactions" onKeyDown={handleKeyDown}>
          {onToggleHandRaise ? (
            <>
              <button
                type="button"
                className="chalk-shell-raise"
                aria-pressed={isHandRaised}
                onClick={() => {
                  onToggleHandRaise();
                  onClose();
                }}
              >
                <ShellIcon name="hand" size={18} />
                {isHandRaised ? "Lower hand" : "Raise hand"}
              </button>
              <span className="chalk-shell-rule" role="separator" aria-orientation="vertical" />
            </>
          ) : null}
          {buttons}
          {!more && reactions.length > 6 ? (
            <button type="button" className="chalk-shell-emoji" disabled={emojiPaused} aria-label="More emoji" onClick={() => setMore(true)}>
              …
            </button>
          ) : null}
        </div>
      }
    </>
  );
}
