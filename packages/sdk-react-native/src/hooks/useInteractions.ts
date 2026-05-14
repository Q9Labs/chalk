import type { ActiveReaction, InteractionState, ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseInteractionsReturn {
  isHandRaised: boolean;
  raisedHands: readonly string[];
  raisedHandCount: number;
  activeReactions: readonly ActiveReaction[];
  raiseHand: () => void;
  lowerHand: () => void;
  toggleHand: () => void;
  sendReaction: (emoji: ReactionEmoji) => void;
}

export function useInteractions(): UseInteractionsReturn {
  const session = useSession();
  const { interactions } = session;
  const [state, setState] = useState<InteractionState>(() => interactions.getState());

  useEffect(() => interactions.subscribe(setState), [interactions]);

  const raiseHand = useCallback(() => interactions.raiseHand(), [interactions]);
  const lowerHand = useCallback(() => interactions.lowerHand(), [interactions]);
  const toggleHand = useCallback(() => interactions.toggleHand(), [interactions]);
  const sendReaction = useCallback((emoji: ReactionEmoji) => interactions.sendReaction(emoji), [interactions]);

  return useMemo(
    () => ({
      isHandRaised: state.isHandRaised,
      raisedHands: state.raisedHands,
      raisedHandCount: interactions.raisedHandCount,
      activeReactions: state.activeReactions,
      raiseHand,
      lowerHand,
      toggleHand,
      sendReaction,
    }),
    [state, interactions, raiseHand, lowerHand, toggleHand, sendReaction],
  );
}
