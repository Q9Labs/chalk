import type { ChalkReaction } from "@q9labsai/chalk-client";

import type { UseInteractionsReturn } from "../../hooks/useInteractions";
import type { NativeReaction } from "../../ui/native-types";
import type { ConferenceViewActionRunner } from "./types";

export interface ConferenceViewInteractions {
  readonly handRaised: boolean;
  readonly raisedHandCount: number;
  readonly activeReactions: NativeReaction[];
  readonly toggleHand: () => void;
  readonly sendReaction: (reaction: ChalkReaction) => void;
}

interface UseConferenceViewInteractionsOptions {
  readonly interactions: Pick<UseInteractionsReturn, "isHandRaised" | "raisedHandCount" | "activeReactions" | "toggleHand" | "sendReaction">;
  readonly run: ConferenceViewActionRunner;
}

export function useConferenceViewInteractions({ interactions, run }: UseConferenceViewInteractionsOptions): ConferenceViewInteractions {
  return {
    handRaised: interactions.isHandRaised,
    raisedHandCount: interactions.raisedHandCount,
    activeReactions: interactions.activeReactions.slice(-3),
    toggleHand: () => void run(interactions.toggleHand),
    sendReaction: (reaction: ChalkReaction) => void run(() => interactions.sendReaction(reaction)),
  };
}
