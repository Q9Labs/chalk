import { describe, expect, it, vi } from "vitest";

import { isRealtimeKitModule, listen, projectDevice, projectParticipant, socketConnectionState } from "./realtimekit-ports";

describe("RealtimeKit ports", () => {
  it("subscribes and unsubscribes with the same event handler", () => {
    const source = { on: vi.fn(), off: vi.fn() };
    const handler = vi.fn();

    const unsubscribe = listen(source, "participantJoined", handler);
    unsubscribe();

    expect(source.on).toHaveBeenCalledWith("participantJoined", handler);
    expect(source.off).toHaveBeenCalledWith("participantJoined", handler);
  });

  it("normalizes participants and native media devices", () => {
    expect(
      projectParticipant({
        id: "participant-1",
        name: " ",
        isHost: true,
        audioEnabled: 1 as unknown as boolean,
        on: vi.fn(),
        off: vi.fn(),
      }),
    ).toMatchObject({
      id: "participant-1",
      displayName: "Guest",
      role: "host",
      audioEnabled: true,
      videoEnabled: false,
    });
    expect(projectDevice({ deviceId: "camera-1", kind: "videoinput", label: "" })).toEqual({
      id: "camera-1",
      label: "camera-1",
      kind: "camera",
    });
    expect(projectDevice({ deviceId: "speaker-1", kind: "audiooutput", label: "Speaker" }).kind).toBe("speaker");
  });

  it("validates module and socket-state boundaries", () => {
    expect(isRealtimeKitModule({ init: vi.fn() })).toBe(true);
    expect(isRealtimeKitModule({ init: "not-a-function" })).toBe(false);
    expect(socketConnectionState({ state: "reconnecting" })).toBe("reconnecting");
    expect(socketConnectionState(null)).toBeNull();
  });
});
