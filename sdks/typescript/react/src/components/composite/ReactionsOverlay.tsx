import type { ActiveReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useReactions } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { ReactionBubble } from "../atomic";
import { ChalkPanel } from "../chalk-ui";

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
        <ChalkPanel key={reaction.eventId} tone="accent" className={cn("pointer-events-none absolute bottom-28 p-1 text-2xl shadow-xl")} style={{ left: `${18 + index * 12}%` }} seed={`reaction-${reaction.eventId}`}>
          <ReactionBubble emoji={reaction.reaction} participantName={reaction.displayName} />
          <span className="sr-only">
            {reaction.displayName} reacted {reaction.reaction}
          </span>
        </ChalkPanel>
      ))}
    </div>
  );
}

export function ReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const reactions = useReactions();
  return <ReactionsOverlaySurface {...props} reactions={reactions.active} />;
}
