/**
 * ReactionBubbles - Floating reaction display
 */

import { ReactionBubble } from "@q9labs/chalk-react";
import { useEffect } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("ReactionBubbles");

interface ActiveReaction {
  id: string;
  emoji: string;
  participantName: string;
}

interface ReactionBubblesProps {
  reactions: readonly ActiveReaction[];
}

export function ReactionBubbles({ reactions }: ReactionBubblesProps) {
  useEffect(() => {
    if (reactions.length > 0) {
      log.debug("Active Reactions", {
        count: reactions.length,
        reactions: reactions.map((r) => `${r.emoji}(${r.participantName})`),
      });
    }
  }, [reactions]);

  if (reactions.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-32 right-8 flex flex-col-reverse gap-2 pointer-events-none z-50">
      {reactions.map((reaction) => (
        <ReactionBubble key={reaction.id} emoji={reaction.emoji} className="relative bottom-auto right-auto" />
      ))}
    </div>
  );
}
