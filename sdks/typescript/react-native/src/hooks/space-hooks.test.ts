import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as SpaceClient | null }));

vi.mock("../context/space-client-context", () => ({
  useSpaceClient: () => {
    if (!state.client) throw new Error("missing client");
    return state.client;
  },
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: <T>(callback: T) => callback,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

import { useCan, useChat, useConnection, useMedia, useParticipants, useReactions, useSelf, useWhiteboard } from "./space-hooks";

describe("SpaceSnapshot hooks", () => {
  beforeEach(() => {
    state.client = client(snapshot());
  });

  it("returns the exact stable slices from SpaceSnapshot", () => {
    const current = state.client!.getSnapshot();

    expect(useConnection()).toBe(current.connection);
    expect(useSelf()).toBe(current.self);
    expect(useParticipants()).toBe(current.participants);
    expect(useMedia()).toBe(current.media);
    expect(useChat()).toBe(current.chat);
    expect(useReactions()).toBe(current.reactions);
    expect(useWhiteboard()).toBe(current.whiteboard);
  });

  it("derives capabilities from the self slice", () => {
    expect(useCan("sendChat")).toBe(true);
    expect(useCan("endEpisode")).toBe(false);
  });
});

function client(current: SpaceSnapshot): SpaceClient {
  return {
    getSnapshot: () => current,
    subscribe: () => () => undefined,
  } as SpaceClient;
}

function snapshot(): SpaceSnapshot {
  const capabilities = ["sendChat"] as const;
  return {
    connection: { status: "live", episode: null, lastError: null },
    self: { participantId: "participant-1", displayName: "Ada", role: "collaborator", capabilities, handRaised: false, can: (capability) => capabilities.includes(capability as (typeof capabilities)[number]) },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: {
        microphone: { source: "microphone", state: "disabled", track: null },
        camera: { source: "camera", state: "disabled", track: null },
        screen: { source: "screen", state: "disabled", track: null },
      },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null } },
  };
}
