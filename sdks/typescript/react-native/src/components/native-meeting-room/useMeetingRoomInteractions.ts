import type { ChalkReaction } from "@q9labsai/chalk-client";

import type { UseInteractionsReturn } from "../../hooks/useInteractions";
import type { NativeReaction } from "../../ui/native-types";
import type { MeetingRoomActionRunner } from "./types";

export interface MeetingRoomInteractions {
  readonly handRaised: boolean;
  readonly raisedHandCount: number;
  readonly activeReactions: NativeReaction[];
  readonly toggleHand: () => void;
  readonly sendReaction: (reaction: ChalkReaction) => void;
}

interface UseMeetingRoomInteractionsOptions {
  readonly interactions: Pick<UseInteractionsReturn, "isHandRaised" | "raisedHandCount" | "activeReactions" | "toggleHand" | "sendReaction">;
  readonly run: MeetingRoomActionRunner;
}

export function useMeetingRoomInteractions({ interactions, run }: UseMeetingRoomInteractionsOptions): MeetingRoomInteractions {
  return {
    handRaised: interactions.isHandRaised,
    raisedHandCount: interactions.raisedHandCount,
    activeReactions: interactions.activeReactions.slice(-3),
    toggleHand: () => void run(interactions.toggleHand),
    sendReaction: (reaction: ChalkReaction) => void run(() => interactions.sendReaction(reaction)),
  };
}
