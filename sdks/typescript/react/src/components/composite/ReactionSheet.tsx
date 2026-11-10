import { useCallback, useLayoutEffect, useState } from "react";
import { ChalkSheet } from "../chalk-ui";
import { ShellIcon } from "../control-bar/ShellIcon";
import { useHaptics } from "../../internal/useHaptics";
import type { ReactionTrayProps } from "./ReactionTray";

/** Long enough for the pressed state to show before the sheet slides away. */
const CLOSE_DELAY_MS = 120;
const FIRST_ROW = 6;
const NOTICE_GAP = 12;

const REACTION_SHEET_CSS = `.chalk-sheet-center {
  justify-content: center;
  font-weight: 600;
}
.chalk-sheet-center[aria-pressed="true"] {
  background: var(--chalk-warning);
  color: var(--chalk-accent-text);
}
.chalk-sheet-emoji {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  margin-top: var(--space-2);
  padding: var(--space-1);
  background: var(--chalk-raised);
  border-radius: var(--corner-2xl);
}
.chalk-sheet-emoji[data-expanded] {
  grid-auto-flow: row;
  grid-template-columns: repeat(7, 1fr);
}
.chalk-sheet-emoji > button {
  display: grid;
  place-items: center;
  height: 56px;
  border-radius: var(--corner-xl);
  font:
    var(--type-headline) / 1 "Apple Color Emoji",
    "Segoe UI Emoji",
    "Noto Color Emoji",
    sans-serif;
}
.chalk-sheet-emoji > button:active,
.chalk-sheet-row:active {
  background: var(--chalk-pressed);
}
.chalk-sheet[data-variant="reactions"] {
  border-top: 1px solid var(--chalk-line-strong);
  box-shadow: var(--elevation-menu);
}
[data-chalk][data-chalk-theme="light"] .chalk-sheet[data-variant="reactions"] {
  box-shadow: var(--elevation-menu-light);
}`;

/** The reactions tray on a phone: a bottom sheet with no scrim, so the emoji floating up over the tiles stay bright. */
export default function ReactionSheet({ open, isHandRaised, onToggleHandRaise, reactions, onSelect, onClose }: Pick<ReactionTrayProps, "isHandRaised" | "onToggleHandRaise" | "reactions" | "onSelect" | "onClose"> & { readonly open: boolean }) {
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const findSheet = useCallback((node: HTMLElement | null) => setSheet(node?.closest<HTMLElement>(".chalk-sheet") ?? null), []);
  const { trigger } = useHaptics();
  // Raise the call's notices above the open sheet, as the desktop tray does, so they do not cover its rows.
  useLayoutEffect(() => {
    const frame = document.querySelector<HTMLElement>("[data-part='call-frame']");
    const notices = frame?.querySelector<HTMLElement>("[data-part='toast-stack']");
    if (!open || !sheet || !frame || !notices) return;
    const lift = () => {
      if (!(notices.offsetParent instanceof HTMLElement)) return;
      const baseline = notices.offsetParent.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(notices).bottom);
      frame.style.setProperty("--chalk-reaction-toast-lift", `${Math.max(0, baseline - (window.innerHeight - sheet.offsetHeight) + NOTICE_GAP)}px`);
    };
    lift();
    const resize = new ResizeObserver(lift);
    resize.observe(sheet);
    return () => {
      resize.disconnect();
      frame.style.removeProperty("--chalk-reaction-toast-lift");
    };
  }, [open, sheet]);
  const send = (emoji: string) => {
    void trigger("success");
    onSelect(emoji);
    window.setTimeout(onClose, CLOSE_DELAY_MS);
  };
  return (
    <ChalkSheet
      variant="reactions"
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Reactions"
    >
      <style href="chalk-reaction-sheet" precedence="default">
        {REACTION_SHEET_CSS}
      </style>
      {onToggleHandRaise ? (
        <div className="chalk-sheet-group">
          <button
            type="button"
            className="chalk-sheet-row chalk-sheet-center"
            aria-pressed={isHandRaised}
            onClick={() => {
              onToggleHandRaise();
              onClose();
            }}
          >
            <ShellIcon name="hand" />
            <span>{isHandRaised ? "Lower hand" : "Raise hand"}</span>
          </button>
        </div>
      ) : null}
      <div ref={findSheet} className="chalk-sheet-emoji" data-expanded={more || undefined} role="toolbar" aria-label="Reactions">
        {(more ? reactions : reactions.slice(0, FIRST_ROW)).map((emoji) => (
          <button key={emoji} type="button" aria-label={`React with ${emoji}`} onClick={() => send(emoji)}>
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
        {!more && reactions.length > FIRST_ROW ? (
          <button type="button" aria-label="More emoji" onClick={() => setMore(true)}>
            …
          </button>
        ) : null}
      </div>
    </ChalkSheet>
  );
}
