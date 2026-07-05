export function useInteractions() {
  return { isHandRaised: false, raisedHands: [], raisedHandCount: 0, activeReactions: [], raiseHand: () => {}, lowerHand: () => {}, toggleHand: () => {}, sendReaction: (_emoji: string) => {} };
}
