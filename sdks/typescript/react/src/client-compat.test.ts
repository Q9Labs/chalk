import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";

import { SpaceClientAdapter } from "./client-compat";

describe("SpaceClientAdapter", () => {
  it("preserves the core file URL and rejects a retry without a pending message", async () => {
    const adapter = new SpaceClientAdapter(createSpaceClient());
    const attachment = { attachmentId: "attachment-1", fileName: "notes.txt", mimeType: "text/plain" as const, byteLength: 12 };

    expect(adapter.getSnapshot()).toMatchObject({ connectionStatus: "live", self: { participantId: "participant-1" } });
    expect(adapter.files.url(attachment)).toBe("/files/attachment-1");
    await expect(adapter.retryChatMessage("missing")).rejects.toThrow("no longer available");
  });

  it("keeps the projected snapshot stable until the client publishes a new source snapshot", () => {
    let sourceSnapshot = createSpaceSnapshot();
    const client = { ...createSpaceClient(), getSnapshot: () => sourceSnapshot };
    const adapter = new SpaceClientAdapter(client);

    const firstProjection = adapter.getSnapshot();

    expect(adapter.getSnapshot()).toBe(firstProjection);

    sourceSnapshot = {
      ...sourceSnapshot,
      connection: { ...sourceSnapshot.connection, status: "reconnecting" },
    };

    expect(adapter.getSnapshot()).toMatchObject({ connectionStatus: "reconnecting" });
    expect(adapter.getSnapshot()).not.toBe(firstProjection);
  });
});

function createSpaceClient(): SpaceClient {
  const snapshot = createSpaceSnapshot();

  return {
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
      files: { upload: unavailable, url: (attachment) => `/files/${attachment.attachmentId}` },
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
    dispose: () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    endEpisode: unavailable,
    extendEpisode: unavailable,
    on: () => () => undefined,
  };
}

function createSpaceSnapshot(): SpaceSnapshot {
  return {
    connection: { status: "live", episode: { id: "episode-1", startedAt: null, deadline: null }, lastError: null },
    self: { participantId: "participant-1", displayName: "Ada", role: "collaborator", capabilities: ["sendChat"], handRaised: false, can: () => false },
    participants: {
      roster: [
        {
          participantId: "participant-1",
          displayName: "Ada",
          role: "collaborator",
          eligibleRoles: ["collaborator"],
          capabilities: ["sendChat"],
          handRaised: false,
          media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
        },
      ],
      admissionQueue: [],
    },
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
      status: "ready",
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
}

async function unavailable(): Promise<never> {
  throw new Error("This command is not configured for the test");
}
