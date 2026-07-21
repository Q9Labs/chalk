import { describe, expect, it, vi } from "vitest";

import { CloudflareSFUClient } from "./client";
import type { CloudflareSFUSignalingTransport } from "./types";

describe("CloudflareSFUClient options", () => {
  it("rejects incomplete bootstrap and participant identity before creating WebRTC resources", () => {
    const transport = inertTransport();

    expect(() => new CloudflareSFUClient({ bootstrap: { connectionId: "", stunServer: "stun:test" }, participantSessionId: "participant-1", transport })).toThrowError(expect.objectContaining({ code: "invalid_bootstrap" }));
    expect(() => new CloudflareSFUClient({ bootstrap: { connectionId: "connection-1", stunServer: "stun:test" }, participantSessionId: " ", transport })).toThrowError(expect.objectContaining({ code: "invalid_bootstrap" }));
  });
});

function inertTransport(): CloudflareSFUSignalingTransport {
  return {
    addTracks: vi.fn(),
    closeTracks: vi.fn(),
    renegotiate: vi.fn(),
    listPublications: vi.fn(),
  };
}
