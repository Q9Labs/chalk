import type { ActiveReaction, ReactionEmoji } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useChalkSessionStore } from "../context/chalk-native-provider";
import { createNativeRoomActionCommands, projectNativeRoomActions } from "../room-actions/native-room-actions";
import { useOptionalChalkSnapshot } from "./useChalkRoomActions";

export interface UseInteractionsReturn {
  isHandRaised: boolean;
  raisedHands: readonly string[];
  raisedHandCount: number;
  activeReactions: readonly ActiveReaction[];
  reactionEnabled: boolean;
  raiseHand: () => Promise<void>;
  lowerHand: () => Promise<void>;
  toggleHand: () => Promise<void>;
  sendReaction: (emoji: ReactionEmoji) => Promise<void>;
}

export function useInteractions(): UseInteractionsReturn {
  const store = useChalkSessionStore();
  const snapshot = useOptionalChalkSnapshot();
  const projection = useMemo(() => projectNativeRoomActions(snapshot), [snapshot]);
  const commands = useMemo(() => (store ? createNativeRoomActionCommands(store) : null), [store]);
  const raisedHands = useMemo(() => snapshot?.participants.filter((participant) => participant.handRaised).map((participant) => participant.participantSessionId) ?? [], [snapshot]);
  const localParticipantId = snapshot?.subject?.participantSessionId ?? null;
  const isHandRaised = localParticipantId ? raisedHands.includes(localParticipantId) : false;

  const setHandRaised = useCallback(
    async (raised: boolean) => {
      if (!store) throw new Error("ChalkNativeProvider requires sessionStore for hand raise.");
      await store.setHandRaised(raised);
    },
    [store],
  );
  const raiseHand = useCallback(() => setHandRaised(true), [setHandRaised]);
  const lowerHand = useCallback(() => setHandRaised(false), [setHandRaised]);
  const toggleHand = useCallback(() => setHandRaised(!isHandRaised), [isHandRaised, setHandRaised]);
  const sendReaction = useCallback(
    async (emoji: ReactionEmoji) => {
      if (!commands) throw new Error("ChalkNativeProvider requires sessionStore for room reactions.");
      await commands.sendReaction(emoji);
    },
    [commands],
  );

  return useMemo(
    () => ({
      isHandRaised,
      raisedHands,
      raisedHandCount: raisedHands.length,
      activeReactions: projection.reactions,
      reactionEnabled: projection.reactionEnabled,
      raiseHand,
      lowerHand,
      toggleHand,
      sendReaction,
    }),
    [isHandRaised, raisedHands, projection, raiseHand, lowerHand, toggleHand, sendReaction],
  );
}
