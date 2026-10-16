import { describe, expect, it, vi } from "vitest";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
const mocks = vi.hoisted(() => ({ platform: vi.fn(), whiteboard: vi.fn() }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: vi.fn(), mediaDevices: {} }));
vi.mock("@q9labsai/chalk-client/effect", () => ({ createSpaceClientForPlatform: mocks.platform }));
vi.mock("@q9labsai/chalk-client", async (original) => ({ ...(await original<typeof import("@q9labsai/chalk-client")>()), createChalkWhiteboardV1Client: mocks.whiteboard }));
import { createNativeSpaceClient } from "./create-native-space-client";
describe("native whiteboard watchdog adapter", () => {
  it("passes the shared core's replacement recorder without a journey option", () => {
    createNativeSpaceClient({
      space: "test",
      getAccess: async () => {
        throw new Error("unused");
      },
    });
    const platform: SpaceClientPlatform | undefined = mocks.platform.mock.calls[0]?.[1];
    const onWatchdogReplacement = vi.fn();
    platform?.dependencies?.createWhiteboardClient?.({ token: async () => "unused", onSummary: vi.fn(), onWatchdogReplacement });
    expect(mocks.whiteboard).toHaveBeenCalledOnce();
    expect(mocks.whiteboard.mock.calls[0]?.[0].onWatchdogReplacement).toBe(onWatchdogReplacement);
  });
});
