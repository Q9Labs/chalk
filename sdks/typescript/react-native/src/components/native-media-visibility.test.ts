import type { Participant } from "../internal/core";
import { describe, expect, it } from "vitest";
import { shouldRenderNativeMediaTrack } from "./native-media-visibility";

function participant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: overrides.id ?? "participant-1",
    displayName: overrides.displayName ?? "Participant",
    role: overrides.role ?? "participant",
    isLocal: overrides.isLocal ?? false,
    videoEnabled: overrides.videoEnabled ?? false,
    audioEnabled: overrides.audioEnabled ?? true,
    isScreenSharing: overrides.isScreenSharing ?? false,
    isSpeaking: overrides.isSpeaking ?? false,
    handRaised: overrides.handRaised ?? false,
    connectionQuality: overrides.connectionQuality ?? 100,
    videoTrack: overrides.videoTrack ?? null,
    audioTrack: overrides.audioTrack ?? null,
    screenShareTrack: overrides.screenShareTrack ?? null,
    screenShareAudioTrack: overrides.screenShareAudioTrack ?? null,
    joinedAt: overrides.joinedAt ?? new Date(),
    metadata: overrides.metadata ?? {},
  };
}

function track(readyState: "live" | "ended" = "live"): MediaStreamTrack {
  return { readyState } as MediaStreamTrack;
}

describe("shouldRenderNativeMediaTrack", () => {
  it("hides video when the participant has turned their camera off even if a stale track object remains", () => {
    expect(
      shouldRenderNativeMediaTrack({
        participant: participant({
          videoEnabled: false,
          videoTrack: track(),
        }),
        track: track(),
      }),
    ).toBe(false);
  });

  it("hides video when the track has already ended", () => {
    expect(
      shouldRenderNativeMediaTrack({
        participant: participant({
          videoEnabled: true,
          videoTrack: track("ended"),
        }),
        track: track("ended"),
      }),
    ).toBe(false);
  });

  it("still renders live non-participant media such as stage screen share tracks", () => {
    expect(
      shouldRenderNativeMediaTrack({
        participant: null,
        track: track(),
      }),
    ).toBe(true);
  });

  it("renders a live screen-share track even when the sharer camera is off", () => {
    expect(
      shouldRenderNativeMediaTrack({
        participant: participant({
          videoEnabled: false,
          isScreenSharing: true,
          screenShareTrack: track(),
        }),
        track: track(),
        mediaKind: "screen-share",
      }),
    ).toBe(true);
  });
});
