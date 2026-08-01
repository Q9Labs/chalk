import { describe, expect, it, vi } from "vitest";

import { useConferenceViewInteractions } from "./useConferenceViewInteractions";

describe("useConferenceViewInteractions", () => {
  it("limits the visible reactions and routes hand and reaction actions", () => {
    const run = vi.fn(async (action: () => unknown | Promise<unknown>) => {
      await action();
    });
    const toggleHand = vi.fn(async () => undefined);
    const sendReaction = vi.fn(async () => undefined);
    const interactions = useConferenceViewInteractions({
      interactions: {
        isHandRaised: true,
        raisedHandCount: 4,
        activeReactions: [
          { id: "reaction-1", emoji: "👍", participantId: "participant-1", participantName: "One" },
          { id: "reaction-2", emoji: "❤️", participantId: "participant-2", participantName: "Two" },
          { id: "reaction-3", emoji: "😂", participantId: "participant-3", participantName: "Three" },
          { id: "reaction-4", emoji: "😮", participantId: "participant-4", participantName: "Four" },
        ],
        toggleHand,
        sendReaction,
      },
      run,
    });

    expect(interactions.activeReactions.map((reaction) => reaction.id)).toEqual(["reaction-2", "reaction-3", "reaction-4"]);
    expect(interactions.handRaised).toBe(true);
    interactions.toggleHand();
    interactions.sendReaction("🎉");

    expect(toggleHand).toHaveBeenCalledOnce();
    expect(sendReaction).toHaveBeenCalledWith("🎉");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
