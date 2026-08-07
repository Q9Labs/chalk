import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import type { ChalkReaction, ChalkReactionEvent } from "../collaboration/types";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { V1Capability, V1ControlState, V1EpisodeSnapshot, V1Participant } from "../sync";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "../whiteboard/types";
import { makeParticipantsController, ParticipantsControllerService } from "./participants-controller";
import { makeReactionsController, ReactionsControllerService } from "./reactions-controller";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import { SpaceStore } from "./store";
import { makeWhiteboardController, WhiteboardControllerService } from "./whiteboard-controller";

export const START = Date.parse("2026-08-04T05:00:00.000Z");
const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

export async function disposeControllerRuntimes(): Promise<void> {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
}

export class ControllerHarness {
  readonly store = new SpaceStore();
  readonly sync: FakeSync;
  readonly connection: ConnectionLifecycleCapability;
  #listeners = new Set<(ports: ConnectionPorts | null) => void>();
  #ports: ConnectionPorts | null = null;

  constructor(initial = snapshot()) {
    this.sync = new FakeSync(initial);
    const runCommand: ConnectionLifecycleCapability["runCommand"] = (operation) => Effect.suspend(() => (this.#ports ? operation(this.#ports) : Effect.die(new TypeError("Connection is not live"))));
    this.connection = {
      getSyncToken: () => Effect.succeed("access-token"),
      createId: () => "test-id",
      runCommand,
      subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => {
        this.#listeners.add(listener);
        listener(this.#ports);
        return () => {
          this.#listeners.delete(listener);
        };
      },
    } as unknown as ConnectionLifecycleCapability;
  }

  participants(diagnostics?: EpisodeDiagnosticRuntime) {
    const runtime = ManagedRuntime.make(Layer.effect(ParticipantsControllerService, makeParticipantsController(this.connection, this.store, diagnostics)) as Layer.Layer<ParticipantsControllerService, never>);
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<never, never>);
    return { runtime, controller: runtime.runSync(Effect.service(ParticipantsControllerService)) };
  }

  reactions(diagnostics?: EpisodeDiagnosticRuntime) {
    const runtime = ManagedRuntime.make(Layer.effect(ReactionsControllerService, makeReactionsController(this.connection, this.store, diagnostics)).pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 hour" }))) as Layer.Layer<ReactionsControllerService, never>);
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<never, never>);
    return { runtime, controller: runtime.runSync(Effect.service(ReactionsControllerService)) };
  }

  whiteboard(factory: (input: { readonly token: () => Promise<string>; readonly onSummary: (summary: ChalkWhiteboardSummary) => void }) => ChalkWhiteboardV1Transport | null) {
    const runtime = ManagedRuntime.make(Layer.effect(WhiteboardControllerService, makeWhiteboardController(this.connection, this.store, factory)) as Layer.Layer<WhiteboardControllerService, never>);
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<never, never>);
    return { runtime, controller: runtime.runSync(Effect.service(WhiteboardControllerService)) };
  }

  connect(): void {
    this.#ports = { sync: this.sync as unknown as ConnectionPorts["sync"], media: {} as ConnectionPorts["media"] };
    for (const listener of this.#listeners) listener(this.#ports);
  }

  disconnect(): void {
    this.#ports = null;
    for (const listener of this.#listeners) listener(null);
  }
}

class FakeSync {
  #listeners = new Set<(snapshot: V1EpisodeSnapshot) => void>();
  #collaborationListeners = new Set<(event: { readonly type: "reaction"; readonly reaction: ChalkReactionEvent }) => void>();
  collaborationCapabilities: Readonly<Record<string, readonly ("sendReaction" | "sendChat")[]>> = {};
  snapshot: V1EpisodeSnapshot;
  assignRole = vi.fn(async () => commandResult());
  muteParticipant = vi.fn(async () => commandResult());
  stopParticipantCamera = vi.fn(async () => commandResult());
  stopParticipantScreenShare = vi.fn(async () => commandResult());
  requestUnmute = vi.fn(async () => ({ type: "directed_request_result" as const, request_id: "request-1", result: "delivered" as const }));
  requestStartCamera = vi.fn(async () => ({ type: "directed_request_result" as const, request_id: "request-2", result: "delivered" as const }));
  removeParticipant = vi.fn(async () => commandResult());
  admit = vi.fn(async () => commandResult());
  deny = vi.fn(async () => commandResult());
  setHandRaised = vi.fn(async () => commandResult());
  setDisplayName = vi.fn(async () => commandResult());
  sendReaction = vi.fn(async (value: ChalkReaction) => reaction("reaction-1", value, 5_000));

  constructor(snapshotValue: V1EpisodeSnapshot) {
    this.snapshot = snapshotValue;
  }

  getSnapshot = (): V1EpisodeSnapshot => this.snapshot;
  getParticipantCollaborationCapabilities = () => this.collaborationCapabilities;
  subscribe = (listener: (snapshot: V1EpisodeSnapshot) => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  subscribeCollaboration = (listener: (event: { readonly type: "reaction"; readonly reaction: ChalkReactionEvent }) => void) => {
    this.#collaborationListeners.add(listener);
    return () => this.#collaborationListeners.delete(listener);
  };
  emit = (): void => {
    for (const listener of this.#listeners) listener(this.snapshot);
  };
  emitReaction(value: ChalkReactionEvent): void {
    for (const listener of this.#collaborationListeners) listener({ type: "reaction", reaction: value });
  }
}

export function snapshot(input: { readonly media?: V1EpisodeSnapshot["media"] } = {}): V1EpisodeSnapshot {
  const participants = [participant("participant-1", "Ada", "owner", ["publishAudio"]), participant("participant-2", "Grace", "observer", ["subscribe"])];
  const control: V1ControlState = {
    revision: 1,
    stateSchemaVersion: 1,
    stateDigest: "a".repeat(64),
    status: "active",
    admissionPolicy: "knock",
    deadlineAtMs: Date.parse("2026-08-04T06:00:00.000Z"),
    deadlineGeneration: 1,
    roleCapabilities: { owner: ["publishAudio"], observer: ["subscribe"] },
    recording: null,
    participants,
    admissionRequests: [{ admissionRequestId: "admission-1", participantId: "pending-1", displayName: "Pending", initialRole: "observer", eligibleRoles: ["observer"], expiresAtMs: Date.parse("2026-08-04T06:00:00.000Z") }],
  };
  return {
    connection: { phase: "live" },
    participantId: "participant-1",
    participantGeneration: 1,
    control,
    optimisticControl: null,
    media: input.media ?? null,
    presence: null,
    mediaPlane: { local: [], remote: [] },
    localMedia: { microphone: "unknown", camera: "unknown", screen: "unknown" },
    pendingCommandCount: 0,
  };
}

function participant(participantId: string, displayName: string, role: string, capabilities: readonly V1Capability[]): V1Participant {
  return { participantId, displayName, handRaised: false, admissionRevision: 1, role, eligibleRoles: [role], capabilities };
}

export function reaction(eventId: string, value: ChalkReaction, expiresInMs: number): ChalkReactionEvent {
  return { eventId, participantId: "participant-1", displayName: "Ada", reaction: value, occurredAt: new Date(START).toISOString(), expiresAt: new Date(START + expiresInMs).toISOString() };
}

function commandResult() {
  return { type: "ack" as const, command_id: "command-1", delivery: "original" as const, outcome: "committed" as const, event_id: "event-1", revision: 1, state_digest: "a".repeat(64) };
}

export function whiteboardTransport(): ChalkWhiteboardV1Transport {
  return {
    startSceneSubscription: vi.fn(async () => undefined),
    stopSceneSubscription: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    submitUpdate: vi.fn(),
    sendCursor: vi.fn(),
    requestSnapshot: vi.fn(),
    clear: vi.fn(),
    setDrawPermission: vi.fn(),
    files: { initiateUpload: vi.fn(), finalizeUpload: vi.fn(), getDownloadUrl: vi.fn() },
  };
}
