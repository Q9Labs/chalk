import type { ActiveReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useReactions } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { ReactionBubble } from "../atomic";
import { useSkin } from "../skin-context";
import { ClassicReactionsOverlay } from "./ClassicReactionsOverlay";
import { reactionFloatStyle, reactionPresentationStyle } from "./reaction-float";

export interface ReactionsOverlayProps {
  readonly maxVisible?: number;
  readonly className?: string;
}

interface ReactionsOverlaySurfaceProps extends ReactionsOverlayProps {
  readonly reactions: readonly ActiveReaction[];
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

function ChalkReactionsOverlaySurface({ reactions, maxVisible = 6, className }: ReactionsOverlaySurfaceProps): React.JSX.Element {
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-30 overflow-hidden", className)} aria-live="polite" aria-atomic="false">
      {reactions.slice(-maxVisible).map((reaction) => (
        <div key={reaction.eventId} className="absolute bottom-24" style={reactionFloatStyle(reaction.eventId)}>
          <ReactionBubble emoji={reaction.reaction} participantName={reaction.displayName} seed={reaction.eventId} />
          <span className="sr-only">
            {reaction.displayName} reacted {reaction.reaction}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChalkReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const reactions = useReactions();
  return <ChalkReactionsOverlaySurface {...props} reactions={reactions.active} />;
}

export function ReactionsOverlay(props: ReactionsOverlayProps): React.JSX.Element {
  const skin = useSkin();
  return skin === "classic" ? <ClassicReactionsOverlay {...props} /> : <ChalkReactionsOverlay {...props} />;
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
