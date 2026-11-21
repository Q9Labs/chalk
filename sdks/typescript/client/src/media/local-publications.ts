// The local side of the session: which tracks are prepared, which publications the SFU
// confirmed, which are parked or being retired, and the one retirement pass that runs at
// a time. The publication lifecycle is pending → confirmed → held → retiring → retired;
// the ledger owns the transitions and the queries the coordinator asks of them.
import type { LocalPublicationRetirementCause, MediaPublicationSource } from "./plane";
import { isGonePublicationFailure } from "./failure-policy";
import { bundleTagOf, connectionIsClosed, safeStopTrack } from "./peer-connection";

export type LocalTrackState = {
  readonly source: MediaPublicationSource;
  readonly track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver | null;
  providerPublicationId: string | null;
  desiredEnabled: boolean;
  enabled: boolean;
  endedListener: (() => void) | null;
  clearing: Promise<void> | null;
};
export type LocalPublicationHandle = { readonly publicationId: string; readonly mid: string };
export type OwnedLocalPublication = {
  state: LocalTrackState;
  transceiver: RTCRtpTransceiver;
  readonly trackName: string;
  readonly connection: RTCPeerConnection;
  readonly connectionId: string;
  detachedAt: number | null;
  lifecycle: { kind: "pending" } | { kind: "confirmed"; handle: LocalPublicationHandle } | { kind: "held"; handle: LocalPublicationHandle } | { kind: "retiring"; handle: LocalPublicationHandle | null; detached: boolean; cause: LocalPublicationRetirementCause } | { kind: "retired" };
};
export type RetiringPublication = Extract<OwnedLocalPublication["lifecycle"], { kind: "retiring" }>;

/** What the ledger needs from the coordinator: the serialized SDP lane and the per-publication close. */
export interface LocalPublicationLedgerOps {
  readonly serialize: <T>(operation: () => Promise<T>, retirement?: boolean) => Promise<T>;
  readonly closePublication: (publication: OwnedLocalPublication) => Promise<void>;
  readonly stopped: () => boolean;
  readonly drained: () => void;
}

export class LocalPublicationLedger {
  readonly #ops: LocalPublicationLedgerOps;
  readonly tracks = new Map<MediaPublicationSource, LocalTrackState>();
  readonly owned = new Set<OwnedLocalPublication>();
  readonly paused = new Map<MediaPublicationSource, LocalPublicationRetirementCause>();
  // A resume still in flight must reach the SFU before the close, or the close would be answered by the resume.
  readonly resumesInFlight = new WeakMap<OwnedLocalPublication, Promise<unknown>>();
  // The steps of a parked microphone's unmute that run before Sync answers (resume, park again), in order. It never rejects.
  // Only the microphone goes ahead, so the maps below never hold another source.
  readonly headStarts = new Map<MediaPublicationSource, Promise<void>>();
  // A head start the caller has cancelled, by operation: a step still queued must not start, and one under way must stop short of the request.
  readonly headStartCancelled = new Map<string, { cancelled: boolean }>();
  // The publication the microphone's head start tried to resume, set before the request goes out, until the enable has used it.
  // A lost response leaves the node's state unknown, so an attempt counts as a resume.
  readonly resumedAhead = new Map<MediaPublicationSource, OwnedLocalPublication>();
  retiredConnection: RTCPeerConnection | null = null;
  retiredCause: LocalPublicationRetirementCause = "forced_pause";
  retirement: Promise<void> = Promise.resolve();

  constructor(ops: LocalPublicationLedgerOps) {
    this.#ops = ops;
  }

  confirmedByHandle(publicationId: string): OwnedLocalPublication | undefined {
    for (const publication of this.owned) {
      if (publication.lifecycle.kind === "confirmed" && publication.lifecycle.handle.publicationId === publicationId && publication.state.providerPublicationId === publicationId) return publication;
    }
    return undefined;
  }
  reusable(source: MediaPublicationSource, connection: RTCPeerConnection): OwnedLocalPublication | undefined {
    for (const publication of this.owned) {
      if (publication.state.source === source && publication.connection === connection && (publication.lifecycle.kind === "confirmed" || publication.lifecycle.kind === "held")) return publication;
    }
    return undefined;
  }
  ownsSource(sources: readonly MediaPublicationSource[]): boolean {
    for (const publication of this.owned) if (sources.includes(publication.state.source)) return true;
    return false;
  }
  confirmedWithTransceiver(transceiver: RTCRtpTransceiver): OwnedLocalPublication | undefined {
    for (const publication of this.owned) {
      if (publication.transceiver === transceiver && publication.lifecycle.kind === "confirmed") return publication;
    }
    return undefined;
  }
  held(source: MediaPublicationSource, connection: RTCPeerConnection): { readonly publication: OwnedLocalPublication; readonly handle: LocalPublicationHandle } | undefined {
    for (const publication of this.owned) {
      const { lifecycle } = publication;
      if (lifecycle.kind === "held" && publication.state.source === source && publication.connection === connection) return { publication, handle: lifecycle.handle };
    }
    return undefined;
  }
  resumedAheadOf(state: LocalTrackState, connection: RTCPeerConnection): { readonly publication: OwnedLocalPublication; readonly handle: LocalPublicationHandle } | undefined {
    const publication = this.resumedAhead.get(state.source);
    if (publication?.state !== state || publication.connection !== connection || publication.lifecycle.kind !== "confirmed") return undefined;
    return { publication, handle: publication.lifecycle.handle };
  }
  adoptParked(state: LocalTrackState, connection: RTCPeerConnection): void {
    const parked = this.held(state.source, connection) ?? this.resumedAheadOf(state, connection);
    if (!parked || state.transceiver) return;
    state.transceiver = parked.publication.transceiver;
    state.providerPublicationId = parked.handle.publicationId;
  }
  hasRetiring(source: MediaPublicationSource): boolean {
    for (const publication of this.owned) {
      if (publication.state.source === source && publication.lifecycle.kind === "retiring" && publication.lifecycle.handle !== null) return true;
    }
    return false;
  }
  retiring(sources?: readonly MediaPublicationSource[]): OwnedLocalPublication[] {
    return [...this.owned].filter((item) => item.lifecycle.kind === "retiring" && item.lifecycle.handle && (!sources || sources.includes(item.state.source)));
  }
  markRetiring(publication: OwnedLocalPublication, cause: LocalPublicationRetirementCause = "publish_failure"): void {
    const phase = publication.lifecycle;
    // A parked publication is already what a user pause wants.
    if (phase.kind === "held" && cause === "user_pause") return;
    if (phase.kind === "pending" || phase.kind === "confirmed" || phase.kind === "held") {
      publication.lifecycle = { kind: "retiring", handle: phase.kind === "pending" ? null : phase.handle, detached: false, cause };
    }
  }
  markGroupRetiring(sources: readonly MediaPublicationSource[], cause: LocalPublicationRetirementCause): void {
    for (const publication of this.owned) {
      if (!sources.includes(publication.state.source)) continue;
      this.markRetiring(publication, cause);
    }
  }
  markAllRetiring(): void {
    for (const publication of this.owned) this.markRetiring(publication);
  }
  retireGone(publication: OwnedLocalPublication, error: unknown): boolean {
    if (!isGonePublicationFailure(error)) return false;
    publication.lifecycle = { kind: "retired" };
    this.owned.delete(publication);
    return true;
  }
  carriesBundle(publication: OwnedLocalPublication): boolean {
    const bundleTag = bundleTagOf(publication.connection);
    return !bundleTag || (publication.transceiver.mid !== null && publication.transceiver.mid === bundleTag);
  }
  // A section that carries the BUNDLE tag is never stopped while its connection lives: Chrome cannot offer once every section is
  // stopped (a screen share alone is that section) and the SFU expires the session when the tag goes.
  keepBundle(publication: OwnedLocalPublication, closed: boolean): boolean {
    return !closed && publication.lifecycle.kind === "retiring" && this.carriesBundle(publication);
  }
  // Real SFU probe (2026-10-30): closing BUNDLE MID 0 caused 410
  // session_error; closing MID 1 kept MID 0 and the session working.
  // Follow the negotiated BUNDLE tag, since the first sender can be video.
  // Missing bundle information retains the conservative rebuild behavior.
  markBundledRetiring(publication: OwnedLocalPublication): void {
    if (this.carriesBundle(publication)) {
      if (this.retiredConnection === publication.connection) return;
      this.retiredConnection = publication.connection;
      if (publication.lifecycle.kind === "retiring") this.retiredCause = publication.lifecycle.cause;
    }
  }
  canHoldOnUserPause(publication: OwnedLocalPublication, phase: RetiringPublication, options: { readonly muteInPlace: boolean; readonly updatesInPlace: boolean; readonly connection: RTCPeerConnection; readonly connectionId: string }): boolean {
    const { source } = publication.state;
    return phase.cause === "user_pause" && (source === "microphone" || source === "camera") && options.muteInPlace && options.updatesInPlace && publication.connection === options.connection && publication.connectionId === options.connectionId && !connectionIsClosed(publication.connection);
  }
  fence(): void {
    for (const publication of this.owned) publication.lifecycle = { kind: "retired" };
    this.owned.clear();
  }
  clearState(state: LocalTrackState): void {
    state.transceiver = null;
    state.providerPublicationId = null;
    state.enabled = false;
    state.track.enabled = false;
  }
  markDetached(transceiver: RTCRtpTransceiver): void {
    for (const publication of this.owned) {
      if (publication.transceiver === transceiver && publication.lifecycle.kind === "confirmed") publication.detachedAt ??= Date.now();
    }
  }
  clearDetached(transceiver: RTCRtpTransceiver): void {
    for (const publication of this.owned) if (publication.transceiver === transceiver) publication.detachedAt = null;
  }
  removeTrack(state: LocalTrackState, onError: (error: unknown) => void, stopTrack = true): void {
    if (state.endedListener) state.track.removeEventListener("ended", state.endedListener);
    if (stopTrack) safeStopTrack(state.track, onError);
    state.enabled = false;
    state.desiredEnabled = false;
    state.transceiver = null;
    state.providerPublicationId = null;
    state.endedListener = null;
  }
  enqueueHeadStart<T>(source: MediaPublicationSource, step: () => Promise<T>): Promise<T> {
    const run = (this.headStarts.get(source) ?? Promise.resolve()).then(step);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.headStarts.set(source, settled);
    void settled.then(() => {
      if (this.headStarts.get(source) === settled) this.headStarts.delete(source);
    });
    return run;
  }
  retireOwned(reportFailure: (error: unknown) => void, sources?: readonly MediaPublicationSource[]): Promise<void> {
    const publications = this.retiring(sources);
    const retirement = this.#runRetirement(publications, reportFailure);
    // Observe shutdown and intent callers even when they do not await cleanup.
    void retirement.catch(() => {});
    return (this.retirement = retirement);
  }
  /** A close the SFU answers with 404 or 410 found the publication already gone, which is what retiring it wanted. */
  async #runRetirement(publications: readonly OwnedLocalPublication[], reportFailure: (error: unknown) => void): Promise<void> {
    const errors: unknown[] = [];
    for (const publication of publications) {
      try {
        await this.#ops.serialize(() => this.#ops.closePublication(publication), true);
      } catch (error) {
        if (this.retireGone(publication, error)) continue;
        errors.push(error);
        if (!this.#ops.stopped()) reportFailure(error);
      }
    }
    if (this.#ops.stopped() && this.owned.size === 0) this.#ops.drained();
    if (errors.length) throw new AggregateError(errors, "Media retirement failed");
  }
}
