import { setImmediate } from "node:timers/promises";
import { expect } from "vitest";
import type { SnapshotSchema } from "../../src/generated/sync";
import { V1SyncClient } from "../../src/sync/v1-client";
import { computeV1StateDigest } from "../../src/sync/v1-reducer";
import type { SyncSocket, SyncWebSocketFactory } from "../../src/sync/types";
import type { V1ControlState } from "../../src/sync/v1-types";
import { ManualClock } from "./manual-clock";
type Snapshot = typeof SnapshotSchema.Type;
export const ownerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
export const peerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
export const recoveryId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const projectionId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24";
export const commandIds = Array.from({ length: 20 }, (_, index) => `018f2f65-2a77-7a44-8e9a-${(0x5b0b6f8d4d00 + index).toString(16)}`);
type ClientOptions = Partial<ConstructorParameters<typeof V1SyncClient>[0]>;
export function syncClient(options: ClientOptions = {}): V1SyncClient {
  return new V1SyncClient({ url: "ws://sync.test/v1/sync", token: async () => "token", webSocket: { connect: () => new TestSocket() }, ...options });
}
export function recordingClient(options: ClientOptions = {}) {
  const clock = new ManualClock();
  const sockets: TestSocket[] = [];
  const client = syncClient({ clock, webSocket: collectSockets(sockets), ...options });
  return { client, clock, sockets };
}
function collectSockets(sockets: TestSocket[]): SyncWebSocketFactory {
  return {
    connect: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
  };
}
export async function recoverSocket(
  client: V1SyncClient,
  socket: TestSocket,
  state: V1ControlState,
  snapshot: Snapshot,
  mode: "snapshot" | "up_to_date",
  entryConfirmation = true,
  entryGeneration?: number,
  mediaOffReason = false,
  connectionQuality = false,
  screenAnnotation: boolean | "burn-in" = false,
): Promise<void> {
  const recoveryAcks = () => socket.frames().filter((frame) => frame.type === "recovery_ack").length;
  const acksBefore = recoveryAcks();
  socket.receive({
    type: "welcome",
    protocol: 1,
    participant_id: ownerId,
    participant_generation: 1,
    recovery_id: recoveryId,
    head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest },
    mode,
    ...(mode === "snapshot" ? { snapshot } : {}),
    ...(entryConfirmation ? { entry_confirmation: true } : {}),
    ...(entryGeneration === undefined ? {} : { entry_generation: entryGeneration }),
    ...(mediaOffReason ? { media_off_reason: true } : {}),
    ...(connectionQuality ? { connection_quality: true } : {}),
    ...(screenAnnotation ? { screen_annotation: true } : {}),
    ...(screenAnnotation === "burn-in" ? { screen_annotation_burn_in: true } : {}),
  });
  socket.receive({ type: "projection_snapshot", stream: "media", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "projection_snapshot", stream: "presence", projection_id: projectionId, sequence: 0, items: [] });
  socket.receive({ type: "recovery_complete", recovery_id: recoveryId, head: { revision: state.revision, state_schema_version: state.stateSchemaVersion, state_digest: state.stateDigest } });
  for (let attempt = 0; attempt < 50 && client.getSnapshot().connection.phase !== "live"; attempt += 1) await settle();
  expect(client.getSnapshot().connection.phase).toBe("live");
  // Sync reserves a recovery acknowledgement only for snapshots and closes the socket on an unexpected one.
  expect(recoveryAcks() - acksBefore).toBe(mode === "snapshot" ? 1 : 0);
}
function baseState(): V1ControlState {
  return {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "0".repeat(64),
    status: "active",
    admissionPolicy: "open",
    deadlineAtMs: 99999,
    deadlineGeneration: 1,
    roleCapabilities: { owner: ["publishAudio", "subscribe", "endEpisode"], collaborator: ["publishAudio"], observer: ["subscribe"] },
    recording: null,
    participants: [{ participantId: ownerId, displayName: "Owner", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: ["owner"], capabilities: ["publishAudio", "subscribe", "endEpisode"] }],
    admissionRequests: [],
  };
}
export function stateWithPeer(role: "collaborator" | "observer"): V1ControlState {
  const state = baseState();
  return {
    ...state,
    participants: [
      ...state.participants,
      {
        participantId: peerId,
        displayName: "Peer",
        handRaised: false,
        admissionRevision: 2,
        role,
        eligibleRoles: [role],
        capabilities: [...(state.roleCapabilities[role] ?? [])],
      },
    ],
  };
}
export async function wireSnapshot(initial: V1ControlState): Promise<Snapshot> {
  const state = { ...initial, stateDigest: await computeV1StateDigest(initial) };
  return {
    control_revision: state.revision,
    state_schema_version: state.stateSchemaVersion,
    state_digest: state.stateDigest,
    status: state.status,
    admission_policy: state.admissionPolicy,
    deadline_at_ms: state.deadlineAtMs,
    deadline_generation: state.deadlineGeneration,
    role_capabilities: state.roleCapabilities,
    recording: null,
    participants: state.participants.map((participant) => ({
      participant_id: participant.participantId,
      display_name: participant.displayName,
      hand_raised: participant.handRaised,
      admission_revision: participant.admissionRevision,
      role: participant.role,
      capabilities: participant.capabilities,
    })),
    admission_requests: state.admissionRequests.map((request) => ({ admission_request_id: request.admissionRequestId, participant_id: request.participantId, display_name: request.displayName, role: request.initialRole, expires_at_ms: request.expiresAtMs })),
  };
}
class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;
  readonly closeCalls: {
    readonly code: number;
    readonly reason: string | undefined;
  }[] = [];
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }
  error(): void {
    this.onerror?.();
  }
  open(): void {
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}
export async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await setImmediate();
}
