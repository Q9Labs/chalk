// The in-place ICE restart: on an SFU that supports it, a failed path first restarts
// ICE on the same session before the whole connection is replaced. The controller owns
// the restart record — running, succeeded or failed — and the budget that bounds the
// attempt; the SDP work runs through the coordinator's serialized lane.
import type { TransportDiagnostic } from "../transport-diagnostics";
import { connectionIsLive, observeConnectionState, withDeadline } from "./peer-connection";
import { waitFor } from "./tracks";
import { ICE_RESTART_BUDGET_MS, ICE_RESTART_FAILURE } from "./sfu-limits";
import { SFUError } from "./types";
import type { SFUFailureCode, SFUSessionDescription, SFUSnapshot, SFUTrackRequest, SFUTracksResponse } from "./types";

export type IceRestart = { readonly connection: RTCPeerConnection; readonly connectionEpoch: number; state: "running" | "succeeded" | "failed" };
export type ConnectionObservation = ReturnType<typeof observeConnectionState>;
export type IceRestartOwner = { readonly generation: number; readonly connectionId: string };
type TransportOffer = "ice_restart" | "receive_transport";

/** What the controller needs from the coordinator. */
export interface IceRestartControllerOps {
  readonly restartsInPlace: () => boolean;
  readonly needsReceiveTransport: (generation: number) => boolean;
  readonly markNegotiated: (generation: number) => void;
  readonly currentFailure: () => SFUSnapshot["failure"];
  readonly generation: () => number;
  readonly connectionEpoch: () => number;
  readonly connection: () => RTCPeerConnection;
  readonly bootstrapConnectionId: () => string;
  readonly stopped: () => boolean;
  readonly serializeSDP: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly createLocalOffer: (connection: RTCPeerConnection, origin: TransportOffer) => Promise<SFUSessionDescription>;
  readonly addTracks: (input: { readonly connectionId: string; readonly sessionDescription: SFUSessionDescription; readonly tracks: readonly SFUTrackRequest[] }, owner: IceRestartOwner) => Promise<SFUTracksResponse>;
  readonly applyProviderDescription: (response: SFUTracksResponse, connection: RTCPeerConnection, owner: IceRestartOwner) => Promise<void>;
  readonly rollbackLocalOffer: (connection: RTCPeerConnection) => Promise<void>;
  readonly reportHealth: (event: TransportDiagnostic) => void;
  readonly setFailure: (error: unknown, fallback: SFUFailureCode) => void;
}

export class IceRestartController {
  readonly #ops: IceRestartControllerOps;
  // The current connection's in-place ICE restart. One that failed leaves only session replacement.
  #restart: IceRestart | null = null;

  constructor(ops: IceRestartControllerOps) {
    this.#ops = ops;
  }

  async establishReceiveTransport(generation: number): Promise<void> {
    if (!this.#ops.needsReceiveTransport(generation)) return;
    await this.#ops.serializeSDP(async () => {
      const connection = this.#ops.connection();
      const owner = { generation, connectionId: this.#ops.bootstrapConnectionId() };
      const current = () => connection === this.#ops.connection() && generation === this.#ops.generation() && !this.#ops.stopped();
      if (!current()) throw staleConnection();
      // A pull can negotiate while startup is waiting its turn in the SDP queue.
      if (!this.#ops.needsReceiveTransport(generation)) return;
      // Establish ICE and DTLS without opening a device or publishing a track.
      connection.addTransceiver("audio", { direction: "recvonly" });
      await this.#exchangeOffer(connection, owner, "receive_transport", current);
      if (!current()) throw staleConnection();
      this.#ops.markNegotiated(generation);
    });
  }

  of(connection: RTCPeerConnection, connectionEpoch: number): IceRestart | null {
    const restart = this.#restart;
    return restart && restart.connection === connection && restart.connectionEpoch === connectionEpoch ? restart : null;
  }
  // On an SFU that restarts ICE in place, a failed path first restarts ICE on the same session.
  // While that runs the phase stays recovering. Once it fails, every state, live included, reports
  // the failure until replacement: the attempt dropped an answer the SFU may have applied, so the
  // session's ICE credentials can no longer be trusted.
  observe(connection: RTCPeerConnection, connectionEpoch: number, observation: ConnectionObservation): ConnectionObservation {
    if (observation?.phase === "failed") this.begin(connection, this.#ops.generation(), connectionEpoch);
    const restart = this.of(connection, connectionEpoch);
    if (!restart) return observation;
    if (restart.state === "failed") return { phase: "failed", failure: this.#ops.currentFailure() ?? ICE_RESTART_FAILURE };
    if (connectionIsLive(connection)) {
      // A path that reconnects on its own settles the restart, so its budget cannot fail it later.
      if (restart.state === "running") restart.state = "succeeded";
      return observation;
    }
    return restart.state === "running" ? { phase: "recovering", failure: null } : observation;
  }
  begin(connection: RTCPeerConnection, generation: number, connectionEpoch: number): void {
    const previous = this.of(connection, connectionEpoch);
    if (!this.#ops.restartsInPlace() || (previous && previous.state !== "succeeded")) return;
    const restart: IceRestart = { connection, connectionEpoch, state: "running" };
    this.#restart = restart;
    const current = () => this.#restart === restart && connection === this.#ops.connection() && connectionEpoch === this.#ops.connectionEpoch() && generation === this.#ops.generation() && !this.#ops.stopped();
    // Once the budget fails the attempt, every later step drops its result. A path that recovered on
    // its own still applies an answer the SFU sent, so both sides keep the same ICE credentials.
    const pending = () => current() && restart.state !== "failed";
    const startedAt = Date.now();
    this.#ops.reportHealth({ event: "recovery_attempt", mechanism: "ice_restart" });
    void this.#restartWithinBudget(connection, generation, pending).then(
      () => {
        restart.state = "succeeded";
        this.#ops.reportHealth({ event: "recovery_succeeded", mechanism: "ice_restart", outage_ms: Date.now() - startedAt });
      },
      (error: unknown) => {
        if (restart.state !== "running") return;
        restart.state = "failed";
        this.#ops.reportHealth({ event: "recovery_attempt", mechanism: "ice_restart", outcome: "failed" });
        if (current()) this.#ops.setFailure(error, "ice_connection_failed");
      },
    );
  }
  async #restartWithinBudget(connection: RTCPeerConnection, generation: number, current: () => boolean): Promise<void> {
    await withDeadline(this.#restartIce(connection, generation, current), ICE_RESTART_BUDGET_MS, () => new SFUError("The ICE restart did not reconnect in time", "ice_connection_failed"));
  }
  // The restart offer keeps every media section, so the SFU keeps the session's publications and subscriptions.
  async #restartIce(connection: RTCPeerConnection, generation: number, current: () => boolean): Promise<void> {
    const connectionId = this.#ops.bootstrapConnectionId();
    await this.#ops.serializeSDP(async () => {
      if (!current()) throw staleConnection();
      // The path reconnected while earlier SDP work held the queue, so it needs no new credentials.
      if (connectionIsLive(connection)) return;
      await this.#exchangeOffer(connection, { generation, connectionId }, "ice_restart", current);
    });
    await waitFor(
      () => {
        if (!current()) throw staleConnection();
        return connectionIsLive(connection);
      },
      ICE_RESTART_BUDGET_MS,
      "The ICE restart did not reconnect in time",
      "ice_connection_failed",
    );
  }
  async #exchangeOffer(connection: RTCPeerConnection, owner: IceRestartOwner, origin: TransportOffer, current: () => boolean): Promise<void> {
    try {
      const sessionDescription = await this.#ops.createLocalOffer(connection, origin);
      if (!current()) throw staleConnection();
      const response = await this.#ops.addTracks({ connectionId: owner.connectionId, sessionDescription, tracks: [] }, owner);
      if (!current()) throw staleConnection();
      await this.#ops.applyProviderDescription(response, connection, owner);
    } catch (error) {
      await this.#ops.rollbackLocalOffer(connection);
      throw error;
    }
  }
}

function staleConnection(): SFUError {
  return new SFUError("Stale media connection", "stale_generation");
}
