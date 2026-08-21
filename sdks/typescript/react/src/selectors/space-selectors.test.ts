import type { LocalMedia, Participant, RemoteMedia } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";

import { toActiveScreenShare, toAudioParticipants, toListParticipants, toParticipantNames, toVideoParticipants } from "./space-selectors";

const localMedia: Readonly<Record<"microphone" | "camera" | "screen", LocalMedia>> = {
  microphone: { source: "microphone", state: "enabled", track: null },
  camera: { source: "camera", state: "disabled", track: null },
  screen: { source: "screen", state: "disabled", track: null },
};

const participant = (overrides: Partial<Participant> = {}): Participant => ({
  participantId: "remote",
  displayName: "Grace",
  handRaised: false,
  role: "participant",
  eligibleRoles: ["participant"],
  capabilities: [],
  media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
  presence: { state: "connected", speaking: false, activeSpeaker: false },
  ...overrides,
});

const media = (source: RemoteMedia["source"], track: MediaStreamTrack, participantId = "remote"): RemoteMedia => ({
  participantId,
  source,
  publicationId: `${participantId}-${source}`,
  track,
});

describe("space space selectors", () => {
  it("gives the synced local participant name precedence over the fallback display name", () => {
    const participants = [participant({ participantId: "local", displayName: "Synced Ada" })];

    expect(toVideoParticipants(participants, [], "local", "Fallback Ada", localMedia)[0]?.displayName).toBe("Synced Ada");
    expect(toParticipantNames(participants, "local", "Fallback Ada")).toEqual({ local: "Synced Ada" });
  });

  it("maps remote camera and screen-share tracks independently", () => {
    const cameraTrack = { kind: "video" } as MediaStreamTrack;
    const screenTrack = { kind: "video" } as MediaStreamTrack;

    expect(toVideoParticipants([participant()], [media("camera", cameraTrack), media("screen", screenTrack)], "local", "Ada", localMedia)).toEqual([
      expect.objectContaining({ id: "local" }),
      expect.objectContaining({ id: "remote", isVideoEnabled: true, isScreenSharing: true, videoTrack: cameraTrack, screenShareTrack: screenTrack }),
    ]);
  });

  it("does not treat a screen share alone as an enabled camera", () => {
    const screenTrack = { kind: "video" } as MediaStreamTrack;

    expect(toVideoParticipants([participant()], [media("screen", screenTrack)], "local", "Ada", localMedia)[1]).toEqual(expect.objectContaining({ id: "remote", isVideoEnabled: false, isScreenSharing: true, screenShareTrack: screenTrack }));
  });

  it("projects sync presence onto speaking flags", () => {
    const participants = [participant({ participantId: "local", presence: { state: "connected", speaking: true, activeSpeaker: false } }), participant({ participantId: "remote", presence: { state: "connected", speaking: true, activeSpeaker: true } })];

    expect(toVideoParticipants(participants, [], "local", "Ada", localMedia)).toEqual([expect.objectContaining({ id: "local", isSpeaking: true, isActiveSpeaker: false }), expect.objectContaining({ id: "remote", isSpeaking: true, isActiveSpeaker: true })]);
  });

  it("selects the first real screen-share track for presentation mode", () => {
    const localTrack = { kind: "video" } as MediaStreamTrack;
    const remoteTrack = { kind: "video" } as MediaStreamTrack;
    const tiles = [
      { id: "local", displayName: "Ada", isLocal: true, isScreenSharing: true, screenShareTrack: localTrack },
      { id: "remote", displayName: "Grace", isScreenSharing: true, screenShareTrack: remoteTrack },
    ];

    expect(toActiveScreenShare(tiles)).toEqual(tiles[0]);
    expect(toActiveScreenShare([{ id: "local", displayName: "Ada" }])).toBeUndefined();
  });

  it("groups microphone and screen-share audio tracks by participant", () => {
    const microphoneTrack = { kind: "audio" } as MediaStreamTrack;
    const screenTrack = { kind: "audio" } as MediaStreamTrack;

    expect(toAudioParticipants([media("microphone", microphoneTrack), media("screen", screenTrack)])).toEqual([{ id: "remote", audioTrack: microphoneTrack, screenShareAudioTrack: screenTrack }]);
  });

  it("uses known media states and falls back for unknown participant media", () => {
    const tiles = [
      { id: "active", displayName: "Active", isMuted: true, isVideoEnabled: false },
      { id: "inactive", displayName: "Inactive", isMuted: false, isVideoEnabled: true },
      { id: "unknown", displayName: "Unknown", isMuted: true, isVideoEnabled: false },
    ];
    const participantMedia: Readonly<Record<string, Participant["media"]>> = {
      active: { microphone: "active", camera: "active", screenShare: "unknown" },
      inactive: { microphone: "inactive", camera: "inactive", screenShare: "unknown" },
      unknown: { microphone: "unknown", camera: "unknown", screenShare: "unknown" },
    };

    expect(toListParticipants(tiles, participantMedia)).toEqual([
      expect.objectContaining({ id: "active", isMuted: false, isVideoEnabled: true }),
      expect.objectContaining({ id: "inactive", isMuted: true, isVideoEnabled: false }),
      expect.objectContaining({ id: "unknown", isMuted: true, isVideoEnabled: false }),
    ]);
  });
});
