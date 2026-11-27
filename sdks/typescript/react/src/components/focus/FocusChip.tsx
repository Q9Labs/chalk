import React, { useRef, useState } from "react";
import type { TileFocus } from "../participant-grid/ParticipantGrid";
import { FOCUS_COPY } from "./focus-copy";

function awayLabel(focus: TileFocus, elapsedSeconds: number): string | null {
  if (focus.steppedAway) return `${FOCUS_COPY.steppedAway} · ${FOCUS_COPY.reasons[focus.steppedAway]}`;
  if (focus.allowed && focus.appState !== "active") return FOCUS_COPY.allowed;
  if (focus.appState === "background") return `${FOCUS_COPY.notFocused} ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  if (focus.appState === "inactive") return focus.windowed ? FOCUS_COPY.splitView : FOCUS_COPY.otherWindow;
  return null;
}

/** The tile chip that tells the other participants when this person is away from the window. */
export function FocusChip({ focus }: { readonly focus?: TileFocus }) {
  const [now, setNow] = useState(() => Date.now());
  const state = focus?.appState;
  const sinceRef = useRef(Date.now());
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Tick the not-focused clock each second while the state is background; clear the interval when it changes.
  React.useEffect(() => {
    sinceRef.current = Date.now();
    if (state !== "background") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state]);
  if (!focus) return null;
  const label = awayLabel(focus, Math.max(0, Math.floor((now - sinceRef.current) / 1000)));
  if (!label) return null;
  return (
    <span role="status" data-part="tile-focus" className="pointer-events-none absolute left-2 top-2 z-30 whitespace-nowrap rounded-(--corner-md) bg-[var(--chalk-overlay)] px-2 py-1 text-xs font-medium text-[var(--chalk-overlay-warning)]">
      {label}
    </span>
  );
}
