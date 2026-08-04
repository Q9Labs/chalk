import type { ActiveReaction } from "../../client-compat";
import type React from "react";

export interface ReactionsOverlayProps {
  readonly reactions: readonly ActiveReaction[];
}

export function ReactionsOverlay({ reactions }: ReactionsOverlayProps): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-live="polite" aria-atomic="false">
      {reactions.map((reaction, index) => (
        <div key={reaction.eventId} className="absolute bottom-28 rounded-full bg-card/90 px-3 py-2 text-2xl shadow-xl" style={{ left: `${18 + index * 12}%` }}>
          <span aria-hidden="true">{reaction.reaction}</span>
          <span className="sr-only">
            {reaction.displayName} reacted {reaction.reaction}
          </span>
        </div>
      ))}
    </div>
  );
}
