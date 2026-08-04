// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "./context";
import { useChalkSession } from "./hooks";
import { createSpaceClientStore, createSpaceSnapshot } from "./space-client.test.helpers";

const snapshot = createSpaceSnapshot();

const createSession = () => createSpaceClientStore(snapshot);

describe("ChalkProvider", () => {
  it("provides the exact session store instance to descendants", () => {
    const session = createSession();
    const wrapper = ({ children }: PropsWithChildren) => <ChalkProvider session={session}>{children}</ChalkProvider>;
    const { result } = renderHook(() => useChalkSession(), { wrapper });

    expect(result.current).toBe(session);
  });

  it("adapts a canonical client once across rerenders without subscribing during render", () => {
    const { client, subscribe } = createCanonicalClient();
    const wrapper = ({ children }: PropsWithChildren) => <ChalkProvider session={client}>{children}</ChalkProvider>;
    const { result, rerender } = renderHook(() => useChalkSession(), { wrapper });
    const adapter = result.current;

    rerender();

    expect(result.current).toBe(adapter);
    expect(result.current).not.toBe(client);
    expect(result.current.getSnapshot()).toMatchObject({ connectionStatus: "idle", self: null });
    expect(subscribe).not.toHaveBeenCalled();
  });
});

function createCanonicalClient(): { readonly client: SpaceClient; readonly subscribe: ReturnType<typeof vi.fn> } {
  const subscribe = vi.fn<SpaceClient["subscribe"]>(() => () => undefined);
  const snapshot: SpaceSnapshot = {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities: [], handRaised: false, can: () => false },
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
    chat: {
      status: "idle",
      messages: [],
      pendingSends: [],
      readReceipts: [],
      unreadCount: 0,
      pagination: { cursor: null, hasOlder: false, historyTruncated: false },
      lastError: null,
    },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  };
  const client = {
    media: {},
    chat: { files: { upload: unavailable, url: () => "" } },
    whiteboard: { transport: () => null },
    join: async () => undefined,
    leave: async () => undefined,
    subscribe,
    getSnapshot: () => snapshot,
    dispose: () => undefined,
  } as unknown as SpaceClient;

  return { client, subscribe };
}

async function unavailable(): Promise<never> {
  throw new Error("This command is not configured for the test");
}
