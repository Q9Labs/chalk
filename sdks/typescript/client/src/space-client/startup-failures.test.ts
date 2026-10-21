import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1SyncClient, InMemoryV1PendingTargetStore } from "../sync";
import type { SpaceClientOptions } from "./types";
import { createSpaceClient } from "./index";
import { createSpaceClientForPlatform } from "./space-client";
import { computeV1StateDigest } from "../sync/v1-reducer";
import type { V1ControlState } from "../sync/v1-types";
import type { ClientFailure } from "./types";

// Only browser/network boundaries are replaced. The access manager, Sync,
// SFU, lifecycle, store, and Promise facade are the production implementations.
class PeerConnection extends EventTarget {
  static instances: PeerConnection[] = [];
  constructor() {
    super();
    PeerConnection.instances.push(this);
  }
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  close() {
    this.connectionState = "closed";
  }
  getSenders() {
    return [];
  }
  getTransceivers() {
    return [];
  }
}
class SilentSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send() {}
  close() {}
}
function browser() {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.stubGlobal("WebSocket", SilentSocket);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }), enumerateDevices: async () => [] } });
}
function makeClient(getAccess: SpaceClientOptions["getAccess"], syncStartupTimeoutMs = 25) {
  return createSpaceClientForPlatform(
    { space: "test", getAccess },
    {
      syncStartupTimeoutMs,
      dependencies: {
        createSyncClient: (input) => createV1SyncClient({ url: "ws://sync.test/v1/sync", token: input.token, mediaPlane: input.media, pendingStore: new InMemoryV1PendingTargetStore() }),
      },
    },
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public client startup failure contract", () => {
  it.each([
    {
      stage: "rejected token",
      setup: () => {},
      getAccess: async () => {
        return new Response(null, { status: 401 });
      },
      code: "access.invalid",
      recoverable: false,
    },
    {
      stage: "unavailable access",
      setup: () => {},
      getAccess: async () => {
        throw new TypeError("Failed to fetch");
      },
      code: "access.unavailable",
      recoverable: true,
    },
    {
      stage: "Sync connect",
      setup: () =>
        vi.stubGlobal(
          "WebSocket",
          class {
            constructor() {
              throw new TypeError("Blocked Sync");
            }
          },
        ),
      getAccess: async () => accessGrant(),
      code: "connection.sync_start_failed",
      recoverable: true,
    },
    { stage: "Sync hello deadline", setup: () => {}, getAccess: async () => accessGrant(), code: "connection.sync_hello_timeout", recoverable: true },
    {
      stage: "SFU/ICE startup",
      setup: () =>
        vi.stubGlobal(
          "RTCPeerConnection",
          class {
            constructor() {
              throw new Error("ICE unavailable");
            }
          },
        ),
      getAccess: async () => accessGrant(),
      code: "connection.media_start_failed",
      recoverable: true,
    },
    { stage: "unsupported browser", setup: () => vi.stubGlobal("navigator", {}), getAccess: async () => accessGrant(), code: "environment.unsupported", recoverable: false },
  ])("preserves $stage in snapshot, error event, and join rejection", async ({ setup, getAccess, code, recoverable }) => {
    browser();
    setup();
    const client = makeClient(getAccess);
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      const rejection = await client.join().catch((cause: unknown) => cause);
      expect.soft(rejection).toMatchObject({ code, recoverable });
      expect.soft(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: { code, recoverable } });
      expect.soft(errors).toEqual([expect.objectContaining({ code, recoverable })]);
    } finally {
      client.dispose();
    }
  });

  it("classifies the retained empty-reason pre-handshake failures at the startup deadline", async () => {
    browser();
    // Sanitized from retained not-joined-edge.jpg and its expanded console text:
    // each WebSocket attempt errors/closes with an empty reason, no open event,
    // handshake response, or HTTP status, until the startup deadline. Origin
    // telemetry records no handshakes. This does not identify the network cause.
    let attempts = 0;
    const send = vi.fn();
    class PreHandshakeFailureSocket extends EventTarget {
      constructor() {
        super();
        attempts += 1;
        queueMicrotask(() => {
          this.dispatchEvent(new Event("error"));
          this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "", wasClean: false }));
        });
      }
      send = send;
      close() {}
    }
    vi.stubGlobal("WebSocket", PreHandshakeFailureSocket);
    const client = makeClient(async () => accessGrant(), 10_000);
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      vi.useFakeTimers();
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(attempts).toBeGreaterThan(1);
      expect(send).not.toHaveBeenCalled();
      const failure = { code: "connection.sync_hello_timeout", recoverable: true };
      expect(await rejection).toMatchObject(failure);
      expect(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: failure });
      expect(errors).toEqual([expect.objectContaining(failure)]);
    } finally {
      client.dispose();
      await vi.advanceTimersByTimeAsync(1);
    }
  });

  it("exposes the same failure through the default exported client", async () => {
    browser();
    const client = createSpaceClient({
      space: "test",
      getAccess: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    try {
      await expect(client.join()).rejects.toMatchObject({ code: "access.unavailable", recoverable: true });
      expect(client.getSnapshot().connection.lastError?.code).toBe("access.unavailable");
    } finally {
      client.dispose();
    }
  });
});

const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
function accessGrant() {
  const token = (audience: string) => `${btoa('{"alg":"EdDSA"}')}.${btoa(JSON.stringify({ aud: audience }))}.fixture`;
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  return {
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: participantId, participant_generation: 1 },
    sync: { token: token("chalk-sync"), expires_at: expiresAt },
    media: { token: token("chalk-media"), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" } },
  };
}
async function liveBrowser() {
  browser();
  vi.stubGlobal("fetch", async () => Response.json({ incarnation: 1, sequence: 0, publications: [] }));
  const control: V1ControlState = {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "0".repeat(64),
    status: "active",
    admissionPolicy: "open",
    deadlineAtMs: Date.now() + 300000,
    deadlineGeneration: 1,
    roleCapabilities: { owner: [] },
    recording: null,
    participants: [{ participantId, displayName: "Test", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: [], capabilities: [] }],
    admissionRequests: [],
  };
  const digest = await computeV1StateDigest(control);
  const head = { revision: 1, state_schema_version: 1, state_digest: digest };
  const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
  const sockets: EventTarget[] = [];
  class ProtocolSocket extends SilentSocket {
    constructor() {
      super();
      sockets.push(this);
    }
    override send(data?: string) {
      if (!data || JSON.parse(data).type !== "hello") return;
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "welcome",
            protocol: 1,
            participant_id: participantId,
            participant_generation: 1,
            recovery_id: recoveryId,
            head,
            mode: "snapshot",
            snapshot: {
              control_revision: 1,
              state_schema_version: 1,
              state_digest: digest,
              status: "active",
              admission_policy: "open",
              deadline_at_ms: control.deadlineAtMs,
              deadline_generation: 1,
              role_capabilities: { owner: [] },
              recording: null,
              participants: [{ participant_id: participantId, display_name: "Test", hand_raised: false, admission_revision: 1, role: "owner", capabilities: [] }],
              admission_requests: [],
            },
          }),
        }),
      );
      for (const stream of ["media", "presence"]) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "projection_snapshot", stream, projection_id: recoveryId, sequence: 0, items: [] }) }));
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "recovery_complete", recovery_id: recoveryId, head }) }));
    }
  }
  vi.stubGlobal("WebSocket", ProtocolSocket);
  return sockets;
}

describe("public client capture warnings", () => {
  it.each([
    ["NotFoundError", "media.device_not_found"],
    ["NotReadableError", "media.device_busy"],
    ["NotAllowedError", "media.permission_denied"],
  ])("keeps %s out of the failed connection screen", async (name, code) => {
    await liveBrowser();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => {
          throw new DOMException("Camera unavailable", name);
        },
        enumerateDevices: async () => [],
      },
    });
    const client = makeClient(async () => accessGrant());
    try {
      await client.join();
      expect(client.getSnapshot().connection).toMatchObject({ status: "live", lastError: { code, recoverable: true } });
      expect(client.getSnapshot().media.local.camera.track).toBeNull();
    } finally {
      client.dispose();
    }
  });
});

describe("public client exhausted recovery", () => {
  it("keeps an exhausted media confirmation recoverable without exposing target internals", async () => {
    await liveBrowser();
    const client = makeClient(async () => accessGrant());
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      const send = vi.spyOn(WebSocket.prototype, "send");
      const rejected = client.media.setMicrophoneEnabled(false).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(send.mock.calls.some(([data]) => JSON.parse(String(data)).type === "live_target")).toBe(true));
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await rejected).toMatchObject({ code: "media.timeout", recoverable: true, message: "Media did not respond in time. Try again." });
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });
  it.each(["sync", "media"] as const)("keeps the %s recovery stage", async (stage) => {
    const sockets = await liveBrowser();
    const client = makeClient(async () => accessGrant());
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      if (stage === "sync") {
        vi.stubGlobal("WebSocket", SilentSocket);
        sockets[0]?.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
      } else {
        const peer = PeerConnection.instances.at(-1)!;
        peer.connectionState = "disconnected";
        peer.iceConnectionState = "disconnected";
        peer.dispatchEvent(new Event("connectionstatechange"));
      }
      const code = `connection.${stage}_recovery_exhausted`;
      for (let second = 0; second < 15 && !errors.some((error) => error.code === code); second++) await vi.advanceTimersByTimeAsync(1000);
      expect(client.getSnapshot().connection.lastError).toMatchObject({ code, recoverable: true });
      expect(errors).toContainEqual(expect.objectContaining({ code, recoverable: true }));
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });
});
