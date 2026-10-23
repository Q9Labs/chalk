import { expect, vi } from "vitest";
import type { V1DirectedRequest } from "../../../client/src/sync/v1-types";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";
import { control } from "../../../client/src/space-client/terminal.test.helpers";
import { createSpaceClientForPlatform } from "../../../client/src/space-client/space-client";

/** Real public SDK, with only the transport and browser capture ports replaced. */
export async function liveMediaClient() {
  const platform = createCoreTestPlatform();
  let receive = (_request: V1DirectedRequest): void => {
    throw new Error("Request listener is not bound");
  };
  const capture = vi.fn(async (constraints?: MediaStreamConstraints) => stream(track(constraints?.video ? "video" : "audio")));
  const display = vi.fn(async () => stream(track("video")));
  const enable = vi.fn(async () => ({ operationId: "target", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const }));
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    {
      ...platform,
      dependencies: {
        ...platform.dependencies,
        mediaDevices: { getUserMedia: capture, getDisplayMedia: display },
        createSyncClient: () => ({
          ...platform.sync,
          setMicrophoneEnabled: enable,
          setCameraEnabled: enable,
          setScreenShareEnabled: enable,
          onDirectedRequest: (listener) => {
            receive = listener;
            return () => undefined;
          },
        }),
      },
    },
  );
  const actions = { microphone: vi.spyOn(client.media, "setMicrophoneEnabled"), camera: vi.spyOn(client.media, "setCameraEnabled"), screen: vi.spyOn(client.media, "setScreenShareEnabled"), request: vi.spyOn(client.media, "acceptRequest") };
  await client.join({ microphone: false, camera: false });
  platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, participants: control.participants.map((person) => ({ ...person, capabilities: ["publishAudio", "publishVideo", "publishScreen"] })) } });
  await vi.waitFor(() => expect(client.getSnapshot().participants.roster).toHaveLength(1));
  return {
    client,
    actions,
    capture,
    display,
    enable,
    health: async (recovering: boolean) => {
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live", health: recovering ? "recovering" : "degraded", noticeUnresponsive: recovering } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe(recovering ? "reconnecting" : "live"));
    },
    request: (kind: "unmute" | "start_camera") => receive({ type: "directed_request", request_id: "request", name: kind === "unmute" ? "request_unmute" : "request_start_camera", actor_participant_id: "participant-1", expires_at_ms: Date.now() + 60_000 }),
  };
}
function track(kind: string): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: "track-1",
    kind,
    label: "",
    muted: false,
    readyState: "live" as const,
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: () => track(kind),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: () => undefined,
  });
}
function stream(value: MediaStreamTrack): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "stream-1",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => stream(value),
    getTracks: () => [value],
    getAudioTracks: () => (value.kind === "audio" ? [value] : []),
    getVideoTracks: () => (value.kind === "video" ? [value] : []),
    getTrackById: (id: string) => (id === value.id ? value : null),
  });
}
