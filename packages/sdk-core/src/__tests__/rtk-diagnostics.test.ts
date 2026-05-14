import { describe, expect, it } from "vitest";
import { getRealtimeKitDiagnosticsSnapshot } from "../debug/rtk-diagnostics.ts";

describe("getRealtimeKitDiagnosticsSnapshot", () => {
  it("captures safe public RTK room, self, transport, and media state", () => {
    const snapshot = getRealtimeKitDiagnosticsSnapshot({
      self: {
        id: "self-1",
        audioEnabled: true,
        videoEnabled: false,
        audioTrack: {
          kind: "audio",
          enabled: true,
          muted: false,
          readyState: "live",
        },
      },
      room: {
        joined: false,
        iceConnectionState: "failed",
      },
      participants: {
        joined: new Map([["participant-1", {}]]),
      },
      transport: {
        connectionState: "failed",
        iceConnectionState: "failed",
        _privatePeerConnection: {
          iceConnectionState: "connected",
        },
      },
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.self?.audioEnabled).toBe(true);
    expect(snapshot.self?.audioTrack).toEqual({
      kind: "audio",
      enabled: true,
      muted: false,
      readyState: "live",
    });
    expect(snapshot.room?.iceConnectionState).toBe("failed");
    expect(snapshot.participants?.joinedSize).toBe(1);
    expect(snapshot.transport?.connectionState).toBe("failed");
    expect(snapshot.publicStateFields).toContainEqual({
      path: "rtk.transport.iceConnectionState",
      value: "failed",
    });
    expect(snapshot.publicStateFields.some((field) => field.path.includes("_privatePeerConnection"))).toBe(false);
  });

  it("returns an explicit unavailable snapshot without an active RTK client", () => {
    expect(getRealtimeKitDiagnosticsSnapshot(null)).toMatchObject({
      available: false,
      self: null,
      room: null,
      transport: null,
    });
  });
});
