import type { ActiveReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useReactions } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { reactionFloatStyle } from "./reaction-float";
import type { ReactionsOverlayProps } from "./ReactionsOverlay";

interface ReactionsOverlaySurfaceProps extends ReactionsOverlayProps {
  readonly reactions: readonly ActiveReaction[];
}

/** Reactions rise from the lower left of the stage, sway a little, and fade out; each keeps a lane keyed on its event id. */
export function ClassicReactionsOverlaySurface({ reactions, maxVisible = 6, className }: ReactionsOverlaySurfaceProps): React.JSX.Element {
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-30 overflow-hidden", className)} aria-live="polite" aria-atomic="false">
      {reactions.slice(-maxVisible).map((reaction) => (
        <div key={reaction.eventId} className="chalk-reaction-rise absolute bottom-24 flex flex-col items-center gap-1" style={reactionFloatStyle(reaction.eventId)}>
          <span className="text-[38px] leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,0.25)]" aria-hidden="true">
            {reaction.reaction}
          </span>
          <span className="max-w-[120px] truncate rounded-full bg-[rgba(12,14,18,0.62)] px-2 py-0.5 text-[11px] font-medium text-white ring-1 ring-white/10 backdrop-blur-md" aria-hidden="true">
            {reaction.displayName}
          </span>
          <span className="sr-only">
            {reaction.displayName} reacted {reaction.reaction}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ClassicReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const reactions = useReactions();
  return <ClassicReactionsOverlaySurface {...props} reactions={reactions.active} />;
}
