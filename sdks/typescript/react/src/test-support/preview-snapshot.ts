import type { Capability, SpaceSnapshot } from "@q9labsai/chalk-client";
import { createPreviewMediaDevices } from "./preview-devices";
import { createPreviewPresentingSnapshot } from "./preview-presenting";

export function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null, episodeEnded: false, removedByHost: false, timedOut: false },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
    participants: { roster: [], admissionQueue: [], admissionPolicy: null },
    media: {
      devices: {
        ...createPreviewMediaDevices(),
      },
      selection: { microphone: "preview-microphone", camera: "preview-camera", speaker: "preview-speaker" },
      local: { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    recording: { current: null },
    offline: { pending: [], decisionNeeded: false, policy: "ask" },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null }, access: { canDraw: false, policy: null, permissions: [] } },
    presenting: createPreviewPresentingSnapshot(),
  };
}
