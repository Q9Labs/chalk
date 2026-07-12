import type { ActiveReaction, InteractionState, ReactionEmoji } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useManagerState } from "./external-store";

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
  const state = useManagerState<InteractionState>(interactions);

  const raiseHand = useCallback(() => interactions.raiseHand(), [interactions]);
  const lowerHand = useCallback(() => interactions.lowerHand(), [interactions]);
  const toggleHand = useCallback(() => interactions.toggleHand(), [interactions]);
  const sendReaction = useCallback((emoji: ReactionEmoji) => interactions.sendReaction(emoji), [interactions]);

  return useMemo(
    () => ({
      isHandRaised: state.isHandRaised,
      raisedHands: state.raisedHands,
      raisedHandCount: state.raisedHandCount,
      activeReactions: state.activeReactions,
      raiseHand,
      lowerHand,
      toggleHand,
      sendReaction,
    }),
    [state, raiseHand, lowerHand, toggleHand, sendReaction],
  );
}
