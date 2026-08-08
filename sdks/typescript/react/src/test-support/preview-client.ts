import type { Capability, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";

export type PreviewClient = SpaceClient & { readonly setSnapshot: (snapshot: SpaceSnapshot) => void };

/**
 * Vitest-free stand-in client for URL-addressable previews and fixtures. Every
 * command resolves to undefined; state changes only through setSnapshot.
 */
export function createPreviewClient(initialSnapshot = createSnapshot()): PreviewClient {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const unavailable = () => async () => undefined;
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
    join: async () => undefined,
    leave: async () => undefined,
    dispose: () => undefined,
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

export function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  };
}
