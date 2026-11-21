import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1SyncClient, InMemoryV1PendingTargetStore } from "../sync";
import type { SpaceClientOptions } from "./types";
import { createSpaceClientForPlatform } from "./space-client";
import { computeV1StateDigest } from "../sync/v1-reducer";
import type { V1ControlState } from "../sync/v1-types";
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
  vi.stubGlobal("fetch", async () => Response.json({ incarnation: 1, sequence: 0, publications: [] }));
  vi.stubGlobal("navigator", { mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getUserMedia: async () => ({ getTracks: () => [] }), enumerateDevices: async () => [] } });
}
function makeClient(getAccess: SpaceClientOptions["getAccess"], onConnectionDiagnostic?: (event: ConnectionDiagnostic) => void) {
  return createSpaceClientForPlatform(
    { space: "test", baseUrl: "http://localhost:8080", getAccess },
    {
      onConnectionDiagnostic,
      dependencies: {
        createSyncClient: (input) => trackSync(createV1SyncClient({ url: "ws://sync.test/v1/sync", token: input.token, mediaPlane: input.media, pendingStore: new InMemoryV1PendingTargetStore() })),
      },
    },
  );
}
// client.dispose() only detaches the observers; the Sync client it joined with keeps its heartbeat and reconnect timers. A
// later test's fake clock would then run the earlier test's timers and dial the later test's socket stub.
const startedSync: Array<{ stop(): void }> = [];
function trackSync<T extends { stop(): void }>(sync: T): T {
  startedSync.push(sync);
  return sync;
}
afterEach(() => {
  for (const sync of startedSync.splice(0)) sync.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public client startup failure contract", () => {
  it("starts a fresh join after unconfirmed Leave while the old join is blocked in Sync persistence", async () => {
    await liveBrowser();
    let release: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new InMemoryV1PendingTargetStore();
    const writing = Promise.withResolvers<void>();
    vi.spyOn(store, "put").mockImplementation(async () => {
      writing.resolve();
      await persistence;
    });
    const getAccess = async () => accessGrant();
    const client = createSpaceClientForPlatform(
      { space: "test", baseUrl: "http://localhost:8080", getAccess },
      {
        dependencies: {
          cancelPendingAdmission: async () => false,
          createSyncClient: (input) => {
            const sync = trackSync(createV1SyncClient({ url: "ws://sync.test/v1/sync", token: input.token, mediaPlane: input.media, pendingStore: store }));
            vi.spyOn(sync, "leave").mockRejectedValue(new Error("lost Leave acknowledgement"));
            return sync;
          },
        },
      },
    );
    const first = client.join({ microphone: false, camera: false, displayName: "First" }).catch((cause: unknown) => cause);
    let second: Promise<unknown> | undefined;
    try {
      await writing.promise;
      expect(client.getSnapshot().connection.status).toBe("live");
      await expect(client.leave()).rejects.toMatchObject({ code: "connection.leave_unconfirmed" });
      expect(client.getSnapshot().connection.status).toBe("left");
      second = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
      expect(await second).toBeUndefined();
      expect(client.getSnapshot().connection.status).toBe("live");
    } finally {
      client.dispose();
      release();
      await first;
      await second;
    }
  });

  it("joins after a stalled upgrade and a slow replacement without a manual retry", async () => {
    const sockets = await liveBrowser(false, { stallFirstUpgrade: true, upgradeDelayMs: 8000 });
    vi.useFakeTimers();
    const diagnostics: ConnectionDiagnostic[] = [];
    const client = makeClient(
      async () => accessGrant(),
      (event) => diagnostics.push(event),
    );
    const joining = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10000);
      expect(client.getSnapshot().connection.status).toBe("joining");
      await vi.advanceTimersByTimeAsync(8500);
      await expect(joining).resolves.toBeUndefined();
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection.status).toBe("live");
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: "sync_dial_timeout" }));
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
    const client = makeClient(async () => accessGrant());
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
