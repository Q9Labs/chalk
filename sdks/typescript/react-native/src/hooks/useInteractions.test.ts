import type { NativeSpaceSnapshot, SpaceClientStore } from "../client-compat";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  snapshot: null as NativeSpaceSnapshot | null,
  store: null as SpaceClientStore | null,
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));

vi.mock("../context/chalk-provider", () => ({
  useChalkSession: () => {
    if (!state.store) throw new Error("useChalkSession must be used within ChalkProvider");
    return state.store;
  },
}));

vi.mock("./useChalkSnapshot", () => ({
  useChalkSnapshot: () => {
    if (!state.snapshot) throw new Error("useChalkSession must be used within ChalkProvider");
    return state.snapshot;
  },
}));

describe("useInteractions canonical room actions", () => {
  beforeEach(() => {
    state.snapshot = null;
    state.store = null;
  });

  it("projects raised hands and delegates toggles to the canonical store", async () => {
    const setHandRaised = vi.fn(async () => undefined);
    state.store = { setHandRaised } as unknown as SpaceClientStore;
    state.snapshot = snapshot({
      localParticipantId: "participant-1",
      participants: [
        { participantId: "participant-1", handRaised: true },
        { participantId: "participant-2", handRaised: true },
      ],
    });
    const { useInteractions } = await import("./useInteractions");

    const interactions = useInteractions();
    expect(interactions).toMatchObject({
      isHandRaised: true,
      raisedHands: ["participant-1", "participant-2"],
      raisedHandCount: 2,
    });
    await interactions.toggleHand();
    expect(setHandRaised).toHaveBeenCalledWith(false);
  });

  it("fails closed when no canonical store is available", async () => {
    const { useInteractions } = await import("./useInteractions");
    expect(() => useInteractions()).toThrow("within ChalkProvider");
  });
});

function snapshot(input: { localParticipantId: string; participants: { participantId: string; handRaised: boolean }[] }): NativeSpaceSnapshot {
  return {
    subject: {
      episodeId: "episode-1",
      participantId: input.localParticipantId,
      participantGeneration: 1,
    },
    participants: input.participants.map((participant) => ({
      ...participant,
      displayName: participant.participantId,
      role: "participant",
      eligibleRoles: ["participant"],
      capabilities: [],
      media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    })),
    actions: { phase: "healthy", version: 1, capabilities: ["setHandRaised"], error: null },
    reactions: [],
    incomingMediaRequests: [],
    chat: { messages: [], readReceipts: [], pagination: { hasMore: false, loading: false }, pendingMessages: [] },
  } as unknown as NativeSpaceSnapshot;
}
