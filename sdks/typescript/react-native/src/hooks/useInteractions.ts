import type { ChalkReaction } from "@q9labsai/chalk-client";
import { useCallback, useMemo } from "react";
import { useChalkSession } from "../context/chalk-provider";
import { createNativeRoomActionCommands, projectNativeRoomActions } from "../room-actions/native-room-actions";
import type { NativeReaction } from "../ui/native-types";
import { useChalkSnapshot } from "./useChalkSnapshot";

export interface UseInteractionsReturn {
  isHandRaised: boolean;
  raisedHands: readonly string[];
  raisedHandCount: number;
  activeReactions: readonly NativeReaction[];
  reactionEnabled: boolean;
  raiseHand: () => Promise<void>;
  lowerHand: () => Promise<void>;
  toggleHand: () => Promise<void>;
  sendReaction: (emoji: ChalkReaction) => Promise<void>;
}

export function useInteractions(): UseInteractionsReturn {
  const store = useChalkSession();
  const snapshot = useChalkSnapshot();
  const projection = useMemo(() => projectNativeRoomActions(snapshot), [snapshot]);
  const commands = useMemo(() => createNativeRoomActionCommands(store), [store]);
  const raisedHands = useMemo(() => snapshot.participants.filter((participant) => participant.handRaised).map((participant) => participant.participantSessionId), [snapshot.participants]);
  const localParticipantId = snapshot.subject?.participantSessionId ?? null;
  const isHandRaised = localParticipantId ? raisedHands.includes(localParticipantId) : false;

  const setHandRaised = useCallback(
    async (raised: boolean) => {
      await store.setHandRaised(raised);
    },
    [store],
  );
  const raiseHand = useCallback(() => setHandRaised(true), [setHandRaised]);
  const lowerHand = useCallback(() => setHandRaised(false), [setHandRaised]);
  const toggleHand = useCallback(() => setHandRaised(!isHandRaised), [isHandRaised, setHandRaised]);
  const sendReaction = useCallback(
    async (emoji: ChalkReaction) => {
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
