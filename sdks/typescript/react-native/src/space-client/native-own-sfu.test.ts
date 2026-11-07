import { afterEach, expect, it, vi } from "vitest";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { parseParsedAccessGrant } from "../../../client/src/access/grant";
import { opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => ({ subscribe: vi.fn(), getSnapshot: vi.fn() })),
  peerConnection: vi.fn(),
}));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: mocks.peerConnection, mediaDevices: {} }));
vi.mock("@q9labsai/chalk-client/effect", async (importActual) => ({ ...(await importActual<typeof import("@q9labsai/chalk-client/effect")>()), createSpaceClientForPlatform: mocks.platform }));
import { createNativeSpaceClient } from "./create-native-space-client";

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.platform.mockClear();
  mocks.peerConnection.mockReset();
});

it("reaches Sync on the nightly host when the app talks to the nightly API", () => {
  createNativeSpaceClient({ space: "test", baseUrl: "https://nightly-api.chalkmeet.com", getAccess: async () => Promise.reject(new Error("unused")) });

  expect(mocks.platform.mock.calls[0]?.[1].syncUrl).toBe("wss://nightly-sync.chalkmeet.com/v1/sync");
});

it("builds the native peer connection from an own SFU grant, which names no Cloudflare STUN server", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 500 })),
  );
  createNativeSpaceClient({
    space: "test",
    getAccess: async () => {
      throw new Error("unused");
    },
  });
  const platform: SpaceClientPlatform | undefined = mocks.platform.mock.calls[0]?.[1];
  const createMediaClient = platform?.dependencies?.createMediaClient;
  if (!createMediaClient) throw new Error("Native platform has no media client factory");
  const ownSFU = ownSFUGrant();
  const iceServers = [{ urls: ["stun:sfu.test:3478"] }, { urls: ["turns:sfu.test:443?transport=tcp"], username: "user", credential: "secret" }];
  const access = parseParsedAccessGrant({ ...ownSFU, media: { ...ownSFU.media, provider: "chalk_sfu", client_payload: { connectionId: "connection-1", episodeRef: "episode-ref", iceServers, capabilities: { serverLayerAdaptation: true, subscriptionState: true, iceRestart: true } } } });
  mocks.peerConnection.mockImplementation(function () {
    throw new Error("stop after the configuration");
  });

  expect(() => createMediaClient({ access, credential: async () => "media-token", onFailure: () => undefined, onScreenEnded: () => undefined })).toThrow("stop after the configuration");

  expect(mocks.peerConnection).toHaveBeenCalledWith(expect.objectContaining({ iceServers }));
});

function ownSFUGrant() {
  const grant: unknown = opaqueAccessGrant("own-sfu");
  if (typeof grant !== "object" || grant === null || !("media" in grant) || typeof grant.media !== "object" || grant.media === null) throw new Error("Unexpected grant fixture");
  return { ...grant, media: grant.media };
}
