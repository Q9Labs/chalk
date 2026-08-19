// @vitest-environment happy-dom

import type { Capability, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "./context";
import { useCan, useChat, useConnection, useMedia, useParticipants, useReactions, useSelf, useSpaceClient, useWhiteboard } from "./hooks";

type TestClient = SpaceClient & {
  readonly setSnapshot: (snapshot: SpaceSnapshot) => void;
};

describe("React snapshot hooks", () => {
  it("requires a ChalkProvider for useSpaceClient", () => {
    expect(() => renderHook(() => useSpaceClient())).toThrowError("Chalk hooks must be used within a ChalkProvider.");
  });

  it("selects each snapshot slice and responds to store updates", () => {
    const client = createTestClient();
    const wrapper = ({ children }: PropsWithChildren) => createElement(ChalkProvider, { client }, children);
    const { result } = renderHook(
      () => ({
        client: useSpaceClient(),
        connection: useConnection(),
        self: useSelf(),
        participants: useParticipants(),
        media: useMedia(),
        chat: useChat(),
        reactions: useReactions(),
        whiteboard: useWhiteboard(),
        canSendChat: useCan("sendChat"),
      }),
      { wrapper },
    );

    expect(result.current.client).toBe(client);
    expect(result.current.connection.status).toBe("idle");
    expect(result.current.self.displayName).toBe("Ada");
    expect(result.current.participants.roster).toEqual([]);
    expect(result.current.media.local.camera.state).toBe("disabled");
    expect(result.current.chat.messages).toEqual([]);
    expect(result.current.reactions.active).toEqual([]);
    expect(result.current.whiteboard.engine.status).toBe("unsubscribed");
    expect(result.current.canSendChat).toBe(true);

    act(() => {
      client.setSnapshot({
        ...client.getSnapshot(),
        connection: { ...client.getSnapshot().connection, status: "live" },
        self: { ...client.getSnapshot().self, capabilities: [], can: () => false },
      });
    });

    expect(result.current.connection.status).toBe("live");
    expect(result.current.canSendChat).toBe(false);
  });
});

function createTestClient(initialSnapshot = createSnapshot()): TestClient {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const unavailable = vi.fn(async () => undefined);
  const client = {
    media: {
      setMicrophoneEnabled: unavailable,
      setCameraEnabled: unavailable,
      setScreenShareEnabled: unavailable,
      selectMicrophone: unavailable,
      selectCamera: unavailable,
      selectSpeaker: unavailable,
      acceptRequest: unavailable,
      declineRequest: unavailable,
    },
    chat: {
      files: { upload: unavailable, url: () => "" },
      send: unavailable,
      loadOlder: unavailable,
      markRead: unavailable,
    },
    participants: {
      assignRole: unavailable,
      mute: unavailable,
      stopVideo: unavailable,
      stopScreenShare: unavailable,
      requestMedia: unavailable,
      remove: unavailable,
      admit: unavailable,
      deny: unavailable,
      raiseHand: unavailable,
      lowerHand: unavailable,
      renameSelf: unavailable,
    },
    reactions: { send: unavailable },
    whiteboard: { transport: () => null },
    join: unavailable,
    leave: unavailable,
    dispose: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: unavailable,
    extendEpisode: unavailable,
    on: () => () => undefined,
  } as unknown as SpaceClient;

  return Object.assign(client, {
    setSnapshot: (nextSnapshot: SpaceSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  });
}

function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: "participant-1", displayName: "Ada", role: "collaborator", capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
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
