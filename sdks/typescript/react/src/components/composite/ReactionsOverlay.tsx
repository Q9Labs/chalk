import type React from "react";
import { cn } from "../../utils/cn";
import { ReactionBubble } from "../atomic";
import { ClassicReactionsOverlay } from "./ClassicReactionsOverlay";
import { reactionPresentationStyle } from "./reaction-float";

export interface ReactionsOverlayProps {
  readonly maxVisible?: number;
  readonly className?: string;
}

export interface ReactionsOverlayPresentationReaction {
  readonly id: string;
  readonly displayName: string;
  readonly value: string;
  readonly occurredAtMs: number;
  readonly expiresAtMs: number;
}

export interface ReactionsOverlayPresentationProps extends ReactionsOverlayProps {
  readonly reactions: readonly ReactionsOverlayPresentationReaction[];
  readonly elapsedMs: number;
}

export function ReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  return <ClassicReactionsOverlay {...props} />;
}

/** Recording-relative reaction rendering that does not depend on mount time. */
export function ReactionsOverlayPresentation({ reactions, elapsedMs, maxVisible = 6, className }: ReactionsOverlayPresentationProps): React.JSX.Element {
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-30 overflow-hidden", className)} aria-live="off">
      {reactions.slice(-maxVisible).map((reaction) => {
        const duration = Math.max(1, reaction.expiresAtMs - reaction.occurredAtMs);
        const progress = (elapsedMs - reaction.occurredAtMs) / duration;
        return (
          <div key={reaction.id} className="absolute" style={reactionPresentationStyle(reaction.id, progress)}>
            <ReactionBubble emoji={reaction.value} participantName={reaction.displayName} duration={duration} animated={false} seed={reaction.id} />
          </div>
        );
      })}
    </div>
  );
}
