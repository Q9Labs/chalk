import { afterEach, expect, it, vi } from "vitest";
import type { AccessGrant } from "@q9labsai/chalk-client";
import { opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";

const peerConnection = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: peerConnection, mediaDevices: {} }));
import { createNativeSpaceClient } from "./create-native-space-client";

const dialed: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  peerConnection.mockReset();
  dialed.length = 0;
});

function stubNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 500 })),
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        dialed.push(url);
      }
    },
  );
}

it("reaches Sync on the nightly host when the app talks to the nightly API", async () => {
  stubNetwork();
  // Media starts alongside Sync, so a peer connection that exists but cannot negotiate still lets Sync dial.
  peerConnection.mockImplementation(function () {
    return { close: vi.fn(), getSenders: () => [], getTransceivers: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
  const client = createNativeSpaceClient({ space: "space-1", baseUrl: "https://nightly-api.chalkmeet.com", getAccess: async () => opaqueAccessGrant("nightly"), microphone: false, camera: false });
  try {
    void client.join().catch(() => undefined);
    await vi.waitFor(() => expect(dialed.length).toBeGreaterThan(0));
    expect(new Set(dialed.map((url) => new URL(url).origin + new URL(url).pathname))).toEqual(new Set(["wss://nightly-sync.chalkmeet.com/v1/sync"]));
  } finally {
    client.dispose();
  }
});

it("builds the media peer connection from the ICE servers an own SFU grant names, not Cloudflare's STUN server", async () => {
  stubNetwork();
  // The test stops at peer construction: it checks the configuration, not that negotiation succeeds.
  peerConnection.mockImplementation(() => {
    throw new Error("stop after the configuration");
  });
  const iceServers = [{ urls: ["stun:sfu.test:3478"] }, { urls: ["turns:sfu.test:443?transport=tcp"], username: "user", credential: "secret" }];
  const client = createNativeSpaceClient({ space: "space-1", getAccess: async () => ownSFUGrant(iceServers), baseUrl: "https://api.chalk.test", microphone: false, camera: false });
  try {
    await client.join().catch(() => undefined);
    await vi.waitFor(() => expect(peerConnection).toHaveBeenCalled());
    expect(peerConnection).toHaveBeenCalledWith(expect.objectContaining({ iceServers }));
  } finally {
    client.dispose();
  }
});

function ownSFUGrant(iceServers: readonly unknown[]): AccessGrant {
  const grant = opaqueAccessGrant("own-sfu");
  const capabilities = { serverLayerAdaptation: true, subscriptionState: true, iceRestart: true };
  return { ...grant, media: { ...grant.media, provider: "chalk_sfu", client_payload: { connectionId: "connection-1", episodeRef: "episode-ref", iceServers, capabilities } } } as unknown as AccessGrant;
}
