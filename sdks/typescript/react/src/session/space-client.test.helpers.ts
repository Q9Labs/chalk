import type { SpaceClientStore, SpaceSnapshotView } from "../client-compat";

export function createSpaceSnapshot(overrides: Partial<SpaceSnapshotView> = {}): SpaceSnapshotView {
  return {
    connectionStatus: "idle",
    self: null,
    participants: [],
    admissionRequests: [],
    localMedia: {
      microphone: { source: "microphone", state: "unavailable", track: null },
      camera: { source: "camera", state: "unavailable", track: null },
      screen: { source: "screen", state: "unavailable", track: null },
    },
    remoteMedia: [],
    failure: null,
    capabilities: [],
    participantMediaById: {},
    reactions: [],
    chat: {
      status: "idle",
      messages: [],
      pendingSends: [],
      pagination: { cursor: null, hasOlder: false, historyTruncated: false },
      unreadCount: 0,
      readReceipts: [],
      lastError: null,
    },
    incomingMediaRequests: [],
    ...overrides,
  };
}

export function createSpaceClientStore(snapshot: SpaceSnapshotView, overrides: Partial<SpaceClientStore> = {}): SpaceClientStore {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    join: unavailable,
    leave: unavailable,
    setMicrophoneEnabled: unavailable,
    setCameraEnabled: unavailable,
    startScreenShare: unavailable,
    stopScreenShare: unavailable,
    setHandRaised: unavailable,
    setDisplayName: unavailable,
    assignParticipantRole: unavailable,
    assignOwner: unavailable,
    admitParticipant: unavailable,
    denyAdmission: unavailable,
    muteParticipant: unavailable,
    stopParticipantCamera: unavailable,
    stopParticipantScreenShare: unavailable,
    removeParticipant: unavailable,
    endEpisode: unavailable,
    sendReaction: unavailable,
    sendChatMessage: unavailable,
    retryChatMessage: unavailable,
    loadOlderChatMessages: unavailable,
    markChatRead: unavailable,
    requestUnmute: unavailable,
    requestStartCamera: unavailable,
    acceptMediaRequest: unavailable,
    declineMediaRequest: unavailable,
    files: { upload: unavailable, url: unavailable },
    whiteboard: null,
    ...overrides,
  };
}

function unavailable(): never {
  throw new Error("This command is not configured for the test");
}
