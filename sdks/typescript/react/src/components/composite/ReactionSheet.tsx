import { useState } from "react";
import { ChalkSheet } from "../chalk-ui";
import { ShellIcon } from "../control-bar/ShellIcon";
import { useHaptics } from "../../internal/useHaptics";
import type { ReactionTrayProps } from "./ReactionTray";

/** Long enough for the pressed state to show before the sheet slides away. */
const CLOSE_DELAY_MS = 120;
const FIRST_ROW = 6;

/** The reactions tray on a phone: a bottom sheet with no scrim, so the emoji floating up over the tiles stay bright. */
export function ReactionSheet({ open, isHandRaised, onToggleHandRaise, reactions, onSelect, onClose }: Pick<ReactionTrayProps, "isHandRaised" | "onToggleHandRaise" | "reactions" | "onSelect" | "onClose"> & { readonly open: boolean }) {
  const [more, setMore] = useState(false);
  const { trigger } = useHaptics();
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
      <div className="chalk-sheet-emoji" data-expanded={more || undefined} role="toolbar" aria-label="Reactions">
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
