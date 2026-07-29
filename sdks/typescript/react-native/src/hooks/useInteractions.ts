import type { ActiveReaction, InteractionState, ReactionEmoji } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useChalkSessionStore, useSession } from "../context/chalk-native-provider";
import { createNativeRoomActionCommands, projectNativeRoomActions } from "../room-actions/native-room-actions";
import { useManagerState } from "./external-store";
import { useOptionalChalkSnapshot } from "./useChalkRoomActions";

export interface UseInteractionsReturn {
  isHandRaised: boolean;
  raisedHands: readonly string[];
  raisedHandCount: number;
  activeReactions: readonly ActiveReaction[];
  reactionEnabled: boolean;
  raiseHand: () => void;
  lowerHand: () => void;
  toggleHand: () => void;
  sendReaction: (emoji: ReactionEmoji) => Promise<void>;
}

export function useInteractions(): UseInteractionsReturn {
  const session = useSession();
  const { interactions } = session;
  const state = useManagerState<InteractionState>(interactions);
  const store = useChalkSessionStore();
  const snapshot = useOptionalChalkSnapshot();
  const projection = useMemo(() => projectNativeRoomActions(snapshot), [snapshot]);
  const commands = useMemo(() => (store ? createNativeRoomActionCommands(store) : null), [store]);

  const raiseHand = useCallback(() => interactions.raiseHand(), [interactions]);
  const lowerHand = useCallback(() => interactions.lowerHand(), [interactions]);
  const toggleHand = useCallback(() => interactions.toggleHand(), [interactions]);
  const sendReaction = useCallback(
    async (emoji: ReactionEmoji) => {
      if (!commands) throw new Error("ChalkNativeProvider requires sessionStore for room reactions.");
      await commands.sendReaction(emoji);
    },
    [commands],
  );

  return useMemo(
    () => ({
      isHandRaised: state.isHandRaised,
      raisedHands: state.raisedHands,
      raisedHandCount: state.raisedHandCount,
      activeReactions: projection.reactions,
      reactionEnabled: projection.reactionEnabled,
      raiseHand,
      lowerHand,
      toggleHand,
      sendReaction,
    }),
    [state, projection, raiseHand, lowerHand, toggleHand, sendReaction],
  );
}
