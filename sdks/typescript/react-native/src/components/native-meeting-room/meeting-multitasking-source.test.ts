import { describe, expect, it } from "vitest";
import { resolveNativeMeetingMultitaskingSource } from "./meeting-multitasking-source";

function createTrack(id: string): MediaStreamTrack {
  return {
    id,
    kind: "video",
    readyState: "live",
  } as MediaStreamTrack;
}

describe("resolveNativeMeetingMultitaskingSource", () => {
  it("prefers the active screen share when one is visible", () => {
    const result = resolveNativeMeetingMultitaskingSource({
      activeSpeaker: null,
      allParticipants: [],
      derived: {
        allParticipants: [],
        gridPages: [],
        primaryContent: "screen-share",
        isStageMode: true,
        isSplit: false,
        showScreenShare: true,
        isCompactViewport: true,
        screenSharer: { id: "screen", displayName: "Presenter" } as never,
        screenShareTrack: createTrack("screen-track"),
        isLocalScreenShare: false,
      },
      localParticipant: null,
      selfName: "Host",
    });

    expect(result.participantName).toBe("Presenter");
    expect(result.track?.id).toBe("screen-track");
  });

  it("falls back to the active speaker video before the local participant", () => {
    const localParticipant = {
      id: "local",
      displayName: "Host",
      videoTrack: createTrack("local-track"),
    } as never;
    const activeSpeaker = {
      id: "remote",
      displayName: "Guest",
      videoTrack: createTrack("remote-track"),
    } as never;

    const result = resolveNativeMeetingMultitaskingSource({
      activeSpeaker,
      allParticipants: [localParticipant, activeSpeaker],
      derived: {
        allParticipants: [localParticipant, activeSpeaker],
        gridPages: [[localParticipant, activeSpeaker]],
        primaryContent: "grid",
        isStageMode: false,
        isSplit: false,
        showScreenShare: false,
        isCompactViewport: true,
        screenSharer: null,
        screenShareTrack: null,
        isLocalScreenShare: false,
      },
      localParticipant,
      selfName: "Host",
    });

    expect(result.participantName).toBe("Guest");
    expect(result.track?.id).toBe("remote-track");
  });

  it("returns a placeholder source when no live video is available", () => {
    const result = resolveNativeMeetingMultitaskingSource({
      activeSpeaker: null,
      allParticipants: [],
      derived: {
        allParticipants: [],
        gridPages: [],
        primaryContent: "grid",
        isStageMode: false,
        isSplit: false,
        showScreenShare: false,
        isCompactViewport: true,
        screenSharer: null,
        screenShareTrack: null,
        isLocalScreenShare: false,
      },
      localParticipant: null,
      selfName: "Host",
    });

    expect(result.participantName).toBe("Host");
    expect(result.track).toBeNull();
  });
});
