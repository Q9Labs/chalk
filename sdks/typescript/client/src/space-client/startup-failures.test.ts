import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1SyncClient, InMemoryV1PendingTargetStore } from "../sync";
import type { SpaceClientOptions } from "./types";
import { createSpaceClient, SpaceClientError } from "./index";
import { createSpaceClientForPlatform } from "./space-client";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { computeV1StateDigest } from "../sync/v1-reducer";
import type { V1ControlState } from "../sync/v1-types";
import type { ClientFailure } from "./types";
import type { ConnectionDiagnostic } from "../connection/diagnostics";

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
function makeClient(getAccess: SpaceClientOptions["getAccess"], syncStartupTimeoutMs: number | null = 25, logger?: SpaceClientOptions["logger"], onConnectionDiagnostic?: (event: ConnectionDiagnostic) => void) {
  return createSpaceClientForPlatform(
    { space: "test", getAccess, logger },
    {
      ...(syncStartupTimeoutMs === null ? {} : { syncStartupTimeoutMs }),
      onConnectionDiagnostic,
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
  it("joins after a stalled upgrade and a slow replacement without a manual retry", async () => {
    const sockets = await liveBrowser(false, { stallFirstUpgrade: true, upgradeDelayMs: 8000 });
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    const client = makeClient(async () => accessGrant(), null, undefined, diagnostic);
    const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10000);
      expect(client.getSnapshot().connection.status).toBe("joining");
      await vi.advanceTimersByTimeAsync(8500);
      await expect(joining).resolves.toBeUndefined();
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "sync_dial_timeout" }));
    } finally {
      client.dispose();
      await joining;
    }
  });

  it("still fails within the default budget when every upgrade stalls", async () => {
    browser();
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        send() {}
        close() {}
      },
    );
    vi.useFakeTimers();
    const client = makeClient(async () => accessGrant(), null);
    const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(client.getSnapshot().connection.status).toBe("joining");
      await vi.advanceTimersByTimeAsync(2);
      expect(await joining).toMatchObject({ code: "connection.sync_start_failed", sync: { stage: "upgrade", opened: false } });
      expect(client.getSnapshot().connection.status).toBe("failed");
    } finally {
      client.dispose();
      await joining;
    }
  });

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
              throw new TypeError("wss://user:secret@sync.test/?token=secret");
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
      expect(JSON.stringify(rejection)).not.toContain("secret");
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
    // Keep retry jitter away from the deadline: its snapshot precedes async cleanup.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const debug = vi.fn();
    const client = makeClient(async () => accessGrant(), 10_000, { debug });
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      vi.useFakeTimers();
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(attempts).toBeGreaterThan(1);
      expect(send).not.toHaveBeenCalled();
      const failure = { code: "connection.sync_start_failed", recoverable: true, sync: { stage: "upgrade", opened: false, closeCode: 1006, closeReason: null, durationMs: expect.any(Number), attempt: expect.any(Number), attempts } };
      expect(await rejection).toMatchObject(failure);
      expect(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: failure });
      expect(client.getSnapshot().connection.lastError?.sync?.attempt).toBeGreaterThanOrEqual(attempts - 1);
      expect(client.getSnapshot().connection.lastError?.sync?.attempt).toBeLessThanOrEqual(attempts);
      expect(errors).toMatchObject([failure]);
      expect(debug).toHaveBeenCalledWith("SpaceClient connection event", expect.objectContaining({ sync: expect.objectContaining(failure.sync) }));
    } finally {
      client.dispose();
      await vi.advanceTimersByTimeAsync(1);
      random.mockRestore();
    }
  });

  it("retains the closed attempt while its replacement is still pending at the deadline", async () => {
    browser();
    let attempts = 0;
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          if (++attempts === 1) queueMicrotask(() => this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })));
        }
        send() {}
        close() {}
      },
    );
    vi.useFakeTimers();
    const client = makeClient(async () => accessGrant(), 1_000);
    try {
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1_001);
      expect(attempts).toBe(2);
      expect(await rejection).toMatchObject({ code: "connection.sync_start_failed", sync: { opened: false, closeCode: 1006, attempt: 1, attempts: 2 } });
    } finally {
      client.dispose();
    }
  });

  it("reports hello when a retry opens after an earlier failed upgrade", async () => {
    browser();
    let attempts = 0;
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          const attempt = ++attempts;
          queueMicrotask(() => {
            if (attempt === 1) this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
            else this.dispatchEvent(new Event("open"));
          });
        }
        send() {}
        close() {}
      },
    );
    vi.useFakeTimers();
    const client = makeClient(async () => accessGrant(), 10_000);
    try {
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(attempts).toBeGreaterThan(1);
      expect(await rejection).toMatchObject({ code: "connection.sync_hello_timeout", sync: { stage: "hello", opened: true, closeCode: null } });
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])("reports the pending phase at the deadline (open=%s)", async (opened) => {
    browser();
    if (!opened)
      vi.stubGlobal(
        "WebSocket",
        class extends EventTarget {
          send() {}
          close() {}
        },
      );
    const debug = vi.fn();
    const client = makeClient(async () => accessGrant(), 25, { debug });
    try {
      const rejection = await client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      const code = opened ? "connection.sync_hello_timeout" : "connection.sync_start_failed";
      expect(rejection).toMatchObject({ code, sync: { stage: opened ? "hello" : "upgrade", opened, closeCode: null, closeReason: null, durationMs: expect.any(Number) } });
      expect(debug).toHaveBeenCalledWith("SpaceClient connection event", expect.objectContaining({ event: "connection_failed", sync: expect.objectContaining({ opened }) }));
    } finally {
      client.dispose();
    }
  });

  it("attributes a silent retry deadline to the current attempt and retains the earlier close in telemetry", async () => {
    browser();
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          if (++attempts === 1)
            queueMicrotask(() => {
              this.dispatchEvent(new Event("open"));
              setTimeout(() => this.dispatchEvent(Object.assign(new Event("close"), { code: 1012, reason: "server draining" })), 1);
            });
        }
        send() {}
        close() {}
      },
    );
    const debug = vi.fn();
    const client = makeClient(async () => accessGrant(), 1000, { debug });
    try {
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1001);
      expect(attempts).toBe(2);
      const failure = await rejection;
      const expected = { code: "connection.sync_start_failed", sync: { stage: "upgrade", opened: false, closeCode: null, closeReason: null, durationMs: expect.any(Number) } };
      expect(failure).toMatchObject(expected);
      expect(client.getSnapshot().connection.lastError).toMatchObject(expected);
      expect(client.getSnapshot().connection.lastError?.sync?.durationMs).toBeGreaterThan(1);
      expect(debug).toHaveBeenCalledWith("SpaceClient connection event", expect.objectContaining({ event: "sync_connect_failed", sync: expect.objectContaining({ stage: "hello", opened: true, closeCode: 1012, closeReason: "server draining", durationMs: 1 }) }));
      expect(debug).toHaveBeenCalledWith("SpaceClient connection event", expect.objectContaining({ event: "connection_failed", sync: expect.objectContaining({ stage: "upgrade", opened: false, closeCode: null }) }));
    } finally {
      client.dispose();
    }
  });

  it("keeps observer mutations out of retained evidence and the public join failure", async () => {
    browser();
    vi.useFakeTimers();
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          queueMicrotask(() => {
            this.dispatchEvent(new Event("open"));
            setTimeout(() => this.dispatchEvent(Object.assign(new Event("close"), { code: 1012, reason: "server draining" })), 1);
          });
        }
        send() {}
        close() {}
      },
    );
    let retained: ConnectionDiagnostic | undefined;
    const client = makeClient(
      async () => accessGrant(),
      100,
      undefined,
      (event) => {
        if (event.event === "sync_connect_failed" && event.sync) {
          retained = event;
          Reflect.set(event.sync, "closeCode", 4999);
          Reflect.set(event.sync, "closeReason", "observer injected");
        }
      },
    );
    try {
      const rejection = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(retained).toBeDefined());
      await vi.advanceTimersByTimeAsync(101);
      const expected = { code: "connection.sync_hello_timeout", sync: { stage: "hello", opened: true, closeCode: 1012, closeReason: "server draining" } };
      expect(await rejection).toMatchObject(expected);
      expect(client.getSnapshot().connection.lastError).toMatchObject(expected);
      expect(retained?.sync).toMatchObject(expected.sync);
    } finally {
      client.dispose();
    }
  });

  it.each(["join rejection", "lastError", "diagnostic event"])("isolates retained Sync evidence from mutations through the public %s", async (target) => {
    browser();
    let diagnostic: ConnectionDiagnostic | undefined;
    const client = makeClient(
      async () => accessGrant(),
      25,
      undefined,
      (event) => {
        if (event.event === "connection_failed") diagnostic = event;
      },
    );
    try {
      const failure = await client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      if (!(failure instanceof SpaceClientError) || !failure.sync) throw new Error("Expected a Sync startup failure");
      const sync = target === "join rejection" ? failure.sync : target === "lastError" ? client.getSnapshot().connection.lastError?.sync : diagnostic?.sync;
      if (!sync) throw new Error("Expected Sync details in the public failure");
      const expected = { ...sync };
      expect(expected).toMatchObject({ stage: "hello", opened: true, closeCode: null, closeReason: null });
      Reflect.set(sync, "stage", "upgrade");
      Reflect.set(sync, "opened", false);
      Reflect.set(sync, "closeCode", 4999);
      Reflect.set(sync, "closeReason", "consumer injected");
      Reflect.set(sync, "durationMs", 0);
      expect(client.getSnapshot().connection.lastError?.sync).toEqual(expected);
      expect(failure.sync).toEqual(expected);
      expect(diagnostic?.sync).toEqual(expected);
      expect(Object.isFrozen(sync)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it.each(["hello timeout", "wss://user:secret@sync.test/?token=secret"])("retains an opened socket close safely: %s", async (reason) => {
    browser();
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        constructor() {
          super();
          queueMicrotask(() => {
            this.dispatchEvent(new Event("open"));
            setTimeout(() => this.dispatchEvent(Object.assign(new Event("close"), { code: 1008, reason })), 1);
          });
        }
        send() {}
        close() {}
      },
    );
    const client = makeClient(async () => accessGrant());
    try {
      const failure = await client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: "connection.sync_hello_timeout", sync: { stage: "hello", opened: true, closeCode: 1008, closeReason: reason === "hello timeout" ? reason : "redacted", durationMs: expect.any(Number) } });
      expect(JSON.stringify(failure)).not.toContain("secret");
      expect(client.getSnapshot().connection.lastError).toMatchObject({ sync: { stage: "hello", closeCode: 1008 } });
    } finally {
      client.dispose();
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
function accessGrant(participantGeneration = 1, id = participantId) {
  const token = (audience: string) => `${btoa('{"alg":"EdDSA"}')}.${btoa(JSON.stringify({ aud: audience, sub: id }))}.fixture`;
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  return {
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: id, participant_generation: participantGeneration },
    sync: { token: token("chalk-sync"), expires_at: expiresAt },
    media: { token: token("chalk-media"), expires_at: expiresAt, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:stun.cloudflare.com:3478" } },
  };
}
async function liveBrowser(invalidRecoverySnapshot = false, network: { readonly stallFirstUpgrade?: boolean; readonly upgradeDelayMs?: number; readonly entryConfirmation?: boolean; readonly participantGeneration?: () => number; readonly participantId?: string } = {}) {
  browser();
  const joinedParticipantId = network.participantId ?? participantId;
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
    participants: [{ participantId: joinedParticipantId, displayName: "Test", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: [], capabilities: [] }],
    admissionRequests: [],
  };
  const digest = await computeV1StateDigest(control);
  const head = { revision: 1, state_schema_version: 1, state_digest: digest };
  const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
  const sockets: ProtocolSocket[] = [];
  class ProtocolSocket extends EventTarget {
    readonly sent: string[] = [];
    readonly helloSubjects: string[] = [];
    enteredAcks = 0;
    closed = false;
    constructor() {
      super();
      sockets.push(this);
      if (network.stallFirstUpgrade && sockets.length === 1) return;
      const open = () => this.dispatchEvent(new Event("open"));
      if (network.upgradeDelayMs) setTimeout(open, network.upgradeDelayMs);
      else queueMicrotask(open);
    }
    close() {
      this.closed = true;
    }
    send(data?: string) {
      if (!data) return;
      const { type, token } = JSON.parse(data);
      this.sent.push(type);
      if (type === "entered") {
        this.enteredAcks++;
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "entered_ack" }) }));
      }
      if (type !== "hello") return;
      this.helloSubjects.push(JSON.parse(atob(token.split(".")[1])).sub);
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "welcome",
            protocol: 1,
            participant_id: joinedParticipantId,
            participant_generation: network.participantGeneration?.() ?? 1,
            ...(network.entryConfirmation ? { entry_confirmation: true, entry_generation: 1 } : {}),
            recovery_id: recoveryId,
            head,
            mode: "snapshot",
            snapshot: {
              control_revision: 1,
              state_schema_version: 1,
              state_digest: invalidRecoverySnapshot && sockets.length > 1 ? "f".repeat(64) : digest,
              status: "active",
              admission_policy: "open",
              deadline_at_ms: control.deadlineAtMs,
              deadline_generation: 1,
              role_capabilities: { owner: [] },
              recording: null,
              participants: [{ participant_id: joinedParticipantId, display_name: "Test", hand_raised: false, admission_revision: 1, role: "owner", capabilities: [] }],
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
  it("keeps recovering media when Sync has already reconnected", async () => {
    vi.useFakeTimers();
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    try {
      const joining = client.join({ microphone: false, camera: false });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await joining;
      const live = platform.sync.getSnapshot();
      platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "recovering" } });
      platform.emitSync({ ...live, connection: { phase: "connecting" } });
      await vi.advanceTimersByTimeAsync(500);
      platform.emitSync(live);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(client.getSnapshot().connection.status).toBe("reconnecting");
      expect(client.getSnapshot().connection.lastError?.code).not.toBe("connection.sync_recovery_exhausted");
      platform.media.emit({ ...platform.media.getSnapshot(), connection: { phase: "live" } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.getSnapshot().connection.status).toBe("live");
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });

  it.each(["hidden", "suspended"] as const)("does not terminate Sync recovery for time spent %s", async (interruption) => {
    vi.useFakeTimers();
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, platform);
    try {
      const joining = client.join({ microphone: false, camera: false });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await joining;
      const live = platform.sync.getSnapshot();
      platform.emitSync({ ...live, connection: { phase: "connecting" } });
      await vi.advanceTimersByTimeAsync(500);
      if (interruption === "hidden") {
        vi.stubGlobal("document", { visibilityState: "hidden" });
        await vi.advanceTimersByTimeAsync(30_000);
      } else {
        vi.setSystemTime(Date.now() + 30_000);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(client.getSnapshot().connection.status).toBe("reconnecting");
      expect(client.getSnapshot().connection.lastError).toBeNull();
      vi.stubGlobal("document", { visibilityState: "visible" });
      platform.emitSync(live);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.getSnapshot().connection.status).toBe("live");
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });

  it("rejects an expired participant refresh identity swap, then explicitly rejoins and confirms the replacement", async () => {
    const requests: string[] = [];
    const sockets = await liveBrowser(false, { entryConfirmation: true });
    const replacementId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c99";
    let expired = false;
    const client = makeClient(async ({ reason }) => {
      requests.push(reason);
      return accessGrant(1, expired ? replacementId : participantId);
    });
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      expired = true;
      vi.setSystemTime(Date.now() + 300001);
      sockets[0]?.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
      await vi.advanceTimersByTimeAsync(300);
      expect(requests).toContain("retry");
      expect(sockets[1]?.closed).toBe(true);
      expect(sockets[1]?.sent).not.toContain("hello");
      expect(client.getSnapshot().self.participantId).not.toBe(replacementId);
      await vi.advanceTimersByTimeAsync(11000);
      expect(client.getSnapshot().connection).toMatchObject({ status: "reconnecting", lastError: { code: "connection.sync_recovery_exhausted" } });
      const replacementSockets = await liveBrowser(false, { entryConfirmation: true, participantId: replacementId });
      const retry = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(1);
      expect(await retry).toBeUndefined();
      expect(requests.at(-1)).toBe("join");
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(client.getSnapshot().self.participantId).toBe(replacementId);
      expect(replacementSockets[0]?.helloSubjects).toEqual([replacementId]);
      expect(replacementSockets[0]?.enteredAcks).toBe(1);
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });

  it("starts a clean admission and confirms entry when joining again after offline recovery exhausts", async () => {
    const requests: string[] = [];
    const sockets = await liveBrowser(false, { entryConfirmation: true, participantGeneration: () => requests.length });
    const client = makeClient(async ({ reason }) => {
      requests.push(reason);
      return accessGrant(requests.length);
    });
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      window.dispatchEvent(new Event("offline"));
      await vi.advanceTimersByTimeAsync(11000);
      expect(client.getSnapshot().connection).toMatchObject({ status: "reconnecting", lastError: { code: "connection.sync_recovery_exhausted" } });
      const retry = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(1);
      expect(await retry).toBeUndefined();
      expect(requests).toEqual(["join", "join"]);
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.closed).toBe(true);
      expect(sockets[1]?.closed).toBe(false);
      expect(sockets[1]?.sent).toContain("hello");
      expect(sockets[1]?.sent).toContain("entered");
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });

  it("surfaces snapshot failure through the public client without starting another recovery", async () => {
    const sockets = await liveBrowser(true);
    const client = makeClient(async () => accessGrant());
    const errors: ClientFailure[] = [];
    client.on("error", ({ error }) => errors.push(error));
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      sockets[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "event",
            stream: "control",
            name: "hand_raised",
            event_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24",
            base_revision: 1,
            revision: 2,
            schema_version: 1,
            resulting_state_digest: "f".repeat(64),
            payload: { participant_id: participantId },
            command_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25",
          }),
        }),
      );
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(client.getSnapshot().connection).toMatchObject({ status: "failed", lastError: { code: "connection.state_digest_recovery_failed", recoverable: false } }));
      expect(errors).toEqual([expect.objectContaining({ code: "connection.state_digest_recovery_failed", recoverable: false })]);
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection.status).toBe("failed");
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });

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
    const errors: ClientFailure[] = [];
    const diagnostics: ConnectionDiagnostic[] = [];
    const warn = vi.fn();
    const client = makeClient(
      async () => accessGrant(),
      25,
      { warn },
      (event) => diagnostics.push(event),
    );
    client.on("error", ({ error }) => errors.push(error));
    try {
      await client.join({ microphone: false, camera: false });
      vi.useFakeTimers();
      if (stage === "sync") {
        vi.stubGlobal("WebSocket", SilentSocket);
        sockets[0]?.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
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
      const exhausted = diagnostics.filter((event) => event.event === "recovery_exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]?.recovery).toMatchObject({ reference: code, attempts: expect.any(Number), transport: { socketAttempts: expect.any(Number), socketCloses: expect.any(Array) }, visibilityState: null });
      expect(warn).toHaveBeenCalledWith("SpaceClient connection event", expect.objectContaining({ event: "recovery_exhausted", recovery: exhausted[0]?.recovery }));
      if (stage === "sync") {
        expect(exhausted[0]?.recovery?.attempts).toBeGreaterThan(0);
        expect(exhausted[0]?.recovery?.transport?.socketCloses).toContainEqual({ code: 1006, wasClean: false });
        expect(client.getSnapshot().connection.status).toBe("failed");
        expect(client.getSnapshot().participants.roster).toEqual([]);
        expect(client.getSnapshot().media.remote).toEqual([]);
        const dialCount = sockets.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(dialCount);
        vi.useRealTimers();
        await liveBrowser();
        await client.join({ microphone: false, camera: false });
        expect(client.getSnapshot().connection.status).toBe("live");
        expect(client.getSnapshot().participants.roster).not.toHaveLength(0);
        expect(client.getSnapshot().connection.lastError).toBeNull();
      } else {
        expect(client.getSnapshot().connection.status).toBe("reconnecting");
      }
    } finally {
      client.dispose();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    }
  });
});
