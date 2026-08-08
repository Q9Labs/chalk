import type { ActiveReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useReactions } from "../../bindings/hooks";

export interface ReactionsOverlayProps {
  readonly maxVisible?: number;
  readonly className?: string;
}

interface ReactionsOverlaySurfaceProps extends ReactionsOverlayProps {
  readonly reactions: readonly ActiveReaction[];
}

function ReactionsOverlaySurface({ reactions, maxVisible = 6, className }: ReactionsOverlaySurfaceProps): React.JSX.Element {
  return (
    <div className={`pointer-events-none absolute inset-0 z-30 overflow-hidden ${className ?? ""}`} aria-live="polite" aria-atomic="false">
      {reactions.slice(-maxVisible).map((reaction, index) => (
        <div key={reaction.eventId} className="absolute bottom-28 rounded-full bg-[var(--chalk-surface)] px-3 py-2 text-2xl shadow-xl" style={{ left: `${18 + index * 12}%` }}>
          <span aria-hidden="true">{reaction.reaction}</span>
          <span className="sr-only">
            {reaction.displayName} reacted {reaction.reaction}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const reactions = useReactions();
  return <ReactionsOverlaySurface {...props} reactions={reactions.active} />;
}
