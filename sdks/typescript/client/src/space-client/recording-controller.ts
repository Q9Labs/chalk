import { Context, Effect, Layer } from "effect";

import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import { normalizeClientError, SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { RecordingSlice } from "./types";

type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;

export type RecordingControllerEffects = {
  readonly start: () => ClientEffect<{ readonly recordingId: string }>;
  readonly stop: () => ClientEffect<void>;
  readonly dispose: () => void;
};

export class RecordingControllerService extends Context.Service<RecordingControllerService, RecordingControllerEffects>()("@chalk/client/RecordingController") {}

export const makeRecordingController = (connection: ConnectionLifecycleCapability, store: SpaceStore, diagnostics?: EpisodeDiagnosticRuntime): Effect.Effect<RecordingControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new RecordingControllerRuntime(connection, store, diagnostics)),
    (controller) => Effect.sync(() => controller.dispose()),
  );

export const makeRecordingControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore, diagnostics?: EpisodeDiagnosticRuntime) => Layer.effect(RecordingControllerService, makeRecordingController(connection, store, diagnostics));

class RecordingControllerRuntime implements RecordingControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #diagnostics: EpisodeDiagnosticRuntime | undefined;
  readonly #subscriptions: { ports: (() => void) | null; recording: (() => void) | null } = { ports: null, recording: null };

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, diagnostics?: EpisodeDiagnosticRuntime) {
    this.#connection = connection;
    this.#store = store;
    this.#diagnostics = diagnostics;
    this.#subscriptions.ports = connection.subscribePorts((ports) => this.#bind(ports));
  }

  start = (): ClientEffect<{ readonly recordingId: string }> =>
    this.#command(
      "recording.start",
      "start_failed",
      () => this.#authorizeStart(),
      (_, { sync }) => foreign(() => sync.startRecording()).pipe(Effect.map(({ recordingId }) => Object.freeze({ recordingId }))),
    );

  stop = (): ClientEffect<void> =>
    this.#command(
      "recording.stop",
      "stop_failed",
      () => this.#authorizeStop(),
      (recordingId, { sync }) => foreign(() => sync.stopRecording(recordingId)).pipe(Effect.asVoid),
    );

  dispose(): void {
    this.#subscriptions.ports?.();
    this.#subscriptions.recording?.();
    this.#subscriptions.ports = null;
    this.#subscriptions.recording = null;
    this.#store.updateRecording(EMPTY_RECORDING);
  }

  #authorizeStart(): void {
    const snapshot = this.#store.getSnapshot();
    assertConnectedAndAllowed(snapshot);
    const current = snapshot.recording.current;
    if (current && current.status !== "stopped" && current.status !== "failed") throw invalidState("A Recording is already active");
  }

  #authorizeStop(): string {
    const snapshot = this.#store.getSnapshot();
    assertConnectedAndAllowed(snapshot);
    const current = snapshot.recording.current;
    if (!current || current.status !== "recording") throw invalidState("No active Recording can be stopped");
    return current.recordingId;
  }

  #command<Authorization, Result>(name: string, failureCode: string, authorize: () => Authorization, execute: (authorization: Authorization, ports: ConnectionPorts) => Effect.Effect<Result, unknown>): ClientEffect<Result> {
    const operation = this.#diagnostics?.startOperation(name);
    const authorized = Effect.try({ try: authorize, catch: normalizeClientError });
    return authorized.pipe(
      Effect.tap(() => Effect.sync(() => operation?.observe("observed", "authorization"))),
      Effect.flatMap((authorization) => this.#connection.runCommand((ports) => execute(authorization, ports))),
      Effect.tap(() => Effect.sync(() => operation?.observe("observed", "accepted_commit"))),
      Effect.tap(() => Effect.sync(() => operation?.succeed())),
      Effect.mapError(normalizeClientError),
      Effect.tapError(() => Effect.sync(() => operation?.fail(failureCode))),
    );
  }

  #bind(ports: ConnectionPorts | null): void {
    this.#subscriptions.recording?.();
    this.#subscriptions.recording = null;
    if (!ports) {
      this.#store.updateRecording(EMPTY_RECORDING);
      return;
    }
    this.#subscriptions.recording = ports.sync.subscribe((snapshot) => this.#observe(recordingFor(snapshot)));
  }

  #observe(next: RecordingSlice): void {
    const current = this.#store.getSnapshot().recording;
    if (sameRecording(current, next)) return;
    this.#store.updateRecording(next);
  }
}

const EMPTY_RECORDING: RecordingSlice = Object.freeze({ current: null });

function recordingFor(snapshot: ReturnType<ConnectionPorts["sync"]["getSnapshot"]>): RecordingSlice {
  const recording = (snapshot.optimisticControl ?? snapshot.control)?.recording ?? null;
  return Object.freeze({ current: recording ? Object.freeze({ ...recording }) : null });
}

function sameRecording(left: RecordingSlice, right: RecordingSlice): boolean {
  if (left.current === right.current) return true;
  if (!left.current || !right.current) return false;
  return left.current.recordingId === right.current.recordingId && left.current.status === right.current.status && left.current.failureCode === right.current.failureCode;
}

function assertConnectedAndAllowed(snapshot: ReturnType<SpaceStore["getSnapshot"]>): void {
  if (snapshot.connection.status !== "live" || !snapshot.connection.episode) throw invalidState("Recording commands require a live Episode");
  if (!snapshot.self.can("manageRecording")) throw new SpaceClientError({ code: "command.rejected", recoverable: false, message: "Recording is not allowed for this Participant" });
}

function invalidState(message: string): SpaceClientError {
  return new SpaceClientError({ code: "connection.invalid_state", recoverable: false, message });
}

function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
