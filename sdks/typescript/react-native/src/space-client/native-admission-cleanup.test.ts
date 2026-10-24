import { afterEach, expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";

vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCPeerConnection: vi.fn(() => {
    throw new Error("native media unavailable");
  }),
  mediaDevices: {},
}));
import { createNativeSpaceClient } from "./create-native-space-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("cancels the pending admission once when native startup fails after admission", async () => {
  const grant = opaqueAccessGrant("native-cleanup");
  const cancels: { readonly url: string; readonly method: string | undefined; readonly authorization: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/cancel-join")) throw new Error(`unexpected request ${url}`);
      cancels.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("Authorization") });
      return new Response(JSON.stringify({ cancelled: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
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
    },
  );
  const client = createNativeSpaceClient({ space: "space-1", getAccess: async () => grant, baseUrl: "https://api.chalk.test", microphone: false, camera: false });
  try {
    await expect(client.join()).rejects.toThrow();
    await vi.waitFor(() => expect(cancels).toHaveLength(1));
    expect(cancels).toEqual([
      {
        url: "https://api.chalk.test/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/cancel-join",
        method: "POST",
        authorization: `Bearer ${grant.media.token}`,
      },
    ]);
  } finally {
    client.dispose();
  }
});
