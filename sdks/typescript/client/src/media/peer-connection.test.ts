import { describe, expect, it } from "vitest";
import { waitForConnectionLive } from "./peer-connection";
import { SFUError } from "./types";

function peerWithICEState(iceConnectionState: RTCIceConnectionState): RTCPeerConnection {
  return { connectionState: "connecting", iceConnectionState } as RTCPeerConnection;
}

describe("waitForConnectionLive", () => {
  it("keeps a timeout retryable and records the ICE state that never established", async () => {
    const error = await waitForConnectionLive(peerWithICEState("checking"), () => {}, 1, "test peer timeout").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SFUError);
    expect((error as SFUError).code).toBe("media_failed");
    expect((error as SFUError).options.iceConnectionState).toBe("checking");
  });

  it("records an established ICE state instead of blaming ICE for a whole-transport timeout", async () => {
    const error = await waitForConnectionLive(peerWithICEState("connected"), () => {}, 1, "test peer timeout").catch((cause: unknown) => cause);
    expect((error as SFUError).code).toBe("media_failed");
    expect((error as SFUError).options.iceConnectionState).toBe("connected");
  });
});
