import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { SpaceClientAdapter } from "./client-compat";

describe("React Native client compatibility", () => {
  it("adapts snapshots lazily and releases the canonical client exactly once", () => {
    const dispose = vi.fn();
    const subscribe = vi.fn(() => () => undefined);
    let snapshot = sourceSnapshot();
    const client = {
      chat: { files: { upload: unavailable, url: () => "" } },
      dispose,
      getSnapshot: () => snapshot,
      subscribe,
      whiteboard: { transport: () => null },
    } as unknown as SpaceClient;
    const adapter = new SpaceClientAdapter(client);

    expect(subscribe).not.toHaveBeenCalled();
    const firstProjection = adapter.getSnapshot();
    expect(adapter.getSnapshot()).toBe(firstProjection);

    snapshot = { ...snapshot, connection: { ...snapshot.connection, status: "reconnecting" } };
    expect(adapter.getSnapshot()).toMatchObject({ state: "reconnecting" });
    expect(adapter.getSnapshot()).not.toBe(firstProjection);

    adapter.dispose();
    adapter.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });
});

function sourceSnapshot(): SpaceSnapshot {
  return {
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
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  };
}

async function unavailable(): Promise<never> {
  throw new Error("This command is not configured for the test");
}
