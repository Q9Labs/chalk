import React from "react";
import { ClassicReactionBubble } from "./ClassicReactionBubble";

export interface ReactionBubbleProps {
  emoji: string;
  participantName?: string;
  onComplete?: () => void;
  duration?: number;
  /** Disable timers and motion for deterministic presentation frames. */
  animated?: boolean;
  /** Stable reaction identity for deterministic Chalk chrome across projection seeks. */
  seed?: number | string;
  className?: string;
}

export const ReactionBubble = React.memo((props: ReactionBubbleProps) => {
  return <ClassicReactionBubble {...props} />;
});

ReactionBubble.displayName = "ReactionBubble";
