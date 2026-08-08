import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { vi } from "vitest";

import { createSnapshot } from "./preview-client";

export { createSnapshot };

export type TestClient = SpaceClient & { readonly setSnapshot: (snapshot: SpaceSnapshot) => void };

export function createTestClient(initialSnapshot = createSnapshot()): TestClient {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const unavailable = () => vi.fn(async () => undefined);
  const client = {
    media: { setMicrophoneEnabled: unavailable(), setCameraEnabled: unavailable(), setScreenShareEnabled: unavailable(), selectMicrophone: unavailable(), selectCamera: unavailable(), selectSpeaker: unavailable(), acceptRequest: unavailable(), declineRequest: unavailable() },
    chat: { files: { upload: unavailable(), url: () => "" }, send: unavailable(), loadOlder: unavailable(), markRead: unavailable() },
    participants: {
      assignRole: unavailable(),
      mute: unavailable(),
      stopVideo: unavailable(),
      stopScreenShare: unavailable(),
      requestMedia: unavailable(),
      remove: unavailable(),
      admit: unavailable(),
      deny: unavailable(),
      raiseHand: unavailable(),
      lowerHand: unavailable(),
      renameSelf: unavailable(),
    },
    reactions: { send: unavailable() },
    whiteboard: { transport: () => null },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: unavailable(),
    extendEpisode: unavailable(),
    on: () => () => undefined,
  } as unknown as SpaceClient;

  return Object.assign(client, {
    setSnapshot: (nextSnapshot: SpaceSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  });
}
