import type { MediaPublication } from "./plane";
import type { CloudflareSFURemoteTrack } from "./types";

export const RECEIVE_STALL_WINDOW_MS = 7000;
export const RECEIVE_STARTUP_GRACE_MS = 20_000;
const MAX_SAMPLE_GAP_MS = 3000;

export type ReceivePacketSample = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly packets: number;
};

type ReceiveProgress = { trackId: string; packets: number; advancedAt: number; flowing: boolean; flowingSince: number };

/** Only consecutive, timely observations of expected media establish a stall. */
export class ReceiveStallDetector {
  readonly #progress = new Map<string, ReceiveProgress>();
  #sampledAt: number | undefined;

  forget(publicationId: string): void {
    this.#progress.delete(publicationId);
  }

  clear(): void {
    this.#progress.clear();
    this.#sampledAt = undefined;
  }

  sample(now: number, tracks: readonly ReceivePacketSample[]): { readonly stalled: readonly string[]; readonly advanced: readonly string[]; readonly resumed: readonly string[] } {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.clear();
    this.#sampledAt = now;
    const observed = new Set(tracks.map((track) => track.publicationId));
    for (const id of this.#progress.keys()) if (!observed.has(id)) this.#progress.delete(id);
    const observations = tracks.map((track) => ({ id: track.publicationId, outcome: this.#observeTrack(now, track) }));
    return {
      stalled: observations.filter((track) => track.outcome === "stalled").map((track) => track.id),
      resumed: observations.filter((track) => track.outcome === "resumed").map((track) => track.id),
      advanced: observations.filter((track) => track.outcome === "advanced" || track.outcome === "resumed").map((track) => track.id),
    };
  }

  #observeTrack(now: number, { publicationId, trackId, packets }: ReceivePacketSample): "stalled" | "advanced" | "resumed" | null {
    const previous = this.#progress.get(publicationId);
    const sameTrack = previous?.trackId === trackId;
    if (sameTrack && previous.packets === packets) {
      const window = previous.flowing ? RECEIVE_STALL_WINDOW_MS : RECEIVE_STARTUP_GRACE_MS;
      return now - previous.advancedAt >= window ? "stalled" : null;
    }
    return this.#advanceTrack(now, { publicationId, trackId, packets }, previous);
  }

  #advanceTrack(now: number, { publicationId, trackId, packets }: ReceivePacketSample, previous: ReceiveProgress | undefined): "advanced" | "resumed" | null {
    const advanced = previous?.trackId === trackId && packets > previous.packets;
    const flowingSince = advanced && now - previous.advancedAt < RECEIVE_STALL_WINDOW_MS ? previous.flowingSince : now;
    this.#progress.set(publicationId, { trackId, packets, advancedAt: now, flowing: advanced, flowingSince });
    if (!advanced) return null;
    return now - flowingSince >= RECEIVE_STALL_WINDOW_MS ? "resumed" : "advanced";
  }
}

export type ReceiveStallObservation = {
  readonly event: "receive_stalled";
  readonly scope: "partial" | "all";
  readonly observedAtMs: number;
  readonly expectedTracks: number;
  readonly stalledTracks: number;
};
const MAX_RECEIVE_REBUILDS = 2;
const MAX_RECEIVE_OBSERVATIONS = 32;

/** Owns eligibility, pending stalls and the budget across replacement peers. */
export class ReceiveStallRecovery {
  readonly #detector = new ReceiveStallDetector();
  readonly #attempts = new Map<string, number>();
  readonly #repulled = new Set<string>();
  readonly #identities = new Map<string, CloudflareSFURemoteTrack>();
  #expected = new Set<string>();
  #screens = new Set<string>();
  #stalled = new Set<string>();
  #active: readonly string[] = [];
  #observations: readonly ReceiveStallObservation[] = Object.freeze([]);

  get observations(): readonly ReceiveStallObservation[] {
    return this.#observations;
  }

  expect(publications: readonly MediaPublication[], participantId: string): void {
    const enabled = publications.filter((publication) => publication.participantId !== participantId && publication.enabled);
    this.#expected = new Set(enabled.flatMap((publication) => (publication.publicationId ? [publication.publicationId] : [])));
    this.#screens = new Set(enabled.filter((publication) => publication.source === "screen").map((publication) => publication.participantId));
    this.#pruneWithdrawn(publications);
    for (const publication of this.#identities.values()) {
      if (this.#isExpected(publication)) continue;
      this.#detector.forget(publication.publicationId);
      this.#stalled.delete(publication.publicationId);
    }
    this.#active = [...this.#identities.values()].filter((publication) => this.#isExpected(publication)).map((publication) => publication.publicationId);
  }

  suspend(): void {
    this.#expected.clear();
    this.#screens.clear();
    this.clear();
  }

  #pruneWithdrawn(publications: readonly MediaPublication[]): void {
    const advertised = new Set(publications.map((publication) => publication.publicationId));
    const screens = new Set(publications.filter((publication) => publication.source === "screen").map((publication) => publication.participantId));
    for (const [key, publication] of this.#identities) {
      if (advertised.has(publication.publicationId) || (publication.source === "screen_audio" && screens.has(publication.participantId))) continue;
      this.#forget(publication.publicationId);
      this.#identities.delete(key);
    }
  }

  isStalled(publicationId: string): boolean {
    return this.#stalled.has(publicationId);
  }

  canRepull(id: string): boolean {
    return this.#stalled.has(id) && !this.#repulled.has(id);
  }

  reserveRepull(id: string): boolean {
    if (!this.canRepull(id)) return false;
    this.#repulled.add(id);
    return true;
  }

  restarted(id: string): void {
    this.#detector.forget(id);
    this.#stalled.delete(id);
  }

  canRebuild(id?: string): boolean {
    return this.#active.some((active) => (id === undefined || id === active) && this.#stalled.has(active) && (this.#attempts.get(active) ?? 0) < MAX_RECEIVE_REBUILDS);
  }

  reserveRebuild(): boolean {
    if (!this.canRebuild()) return false;
    for (const id of this.#active) {
      if (this.canRebuild(id)) this.#attempts.set(id, (this.#attempts.get(id) ?? 0) + 1);
    }
    return true;
  }

  clear(): void {
    this.#detector.clear();
    this.#stalled.clear();
    this.#active = [];
  }

  sample(now: number, connection: RTCPeerConnection, report: RTCStatsReport, tracks: Iterable<CloudflareSFURemoteTrack>): { readonly stalled: readonly string[]; readonly advanced: readonly string[]; readonly newlyStalled: readonly string[] } {
    const active = [...tracks].filter((publication) => this.#isExpected(publication));
    for (const publication of active) this.#rememberIdentity(publication);
    this.#active = active.map((publication) => publication.publicationId);
    const samples = active.flatMap((publication) => receivePacketSample(connection, report, publication) ?? []);
    const { stalled, advanced, resumed } = this.#detector.sample(now, samples);
    for (const id of resumed) {
      this.#attempts.delete(id);
      this.#repulled.delete(id);
    }
    const newlyStalled = stalled.filter((id) => !this.#stalled.has(id));
    this.#stalled = new Set(stalled);
    if (newlyStalled.length) this.#record(now);
    return { stalled, advanced, newlyStalled };
  }

  #isExpected(publication: CloudflareSFURemoteTrack): boolean {
    return publication.source === "screen_audio" ? this.#screens.has(publication.participantId) : this.#expected.has(publication.publicationId);
  }

  #rememberIdentity(publication: CloudflareSFURemoteTrack): void {
    const key = `${publication.participantId}\0${publication.source}`;
    const previous = this.#identities.get(key);
    if (previous && previous.publicationId !== publication.publicationId) this.#forget(previous.publicationId);
    this.#identities.set(key, publication);
  }

  #forget(id: string): void {
    this.#detector.forget(id);
    this.#stalled.delete(id);
    this.#attempts.delete(id);
    this.#repulled.delete(id);
  }

  #record(now: number): void {
    const observation = Object.freeze({ event: "receive_stalled" as const, scope: this.#active.every((id) => this.#stalled.has(id)) ? ("all" as const) : ("partial" as const), observedAtMs: now, expectedTracks: this.#active.length, stalledTracks: this.#stalled.size });
    this.#observations = Object.freeze([...this.#observations.slice(-(MAX_RECEIVE_OBSERVATIONS - 1)), observation]);
  }
}

function receivePacketSample(connection: RTCPeerConnection, report: RTCStatsReport, publication: CloudflareSFURemoteTrack): ReceivePacketSample | undefined {
  const rows = [...report.values()].filter((row) => row.type === "inbound-rtp" && row.trackIdentifier === publication.track.id);
  if (rows.some((row) => !Number.isSafeInteger(row.packetsReceived) || row.packetsReceived < 0)) return;
  if (publication.track.kind === "audio" && !audioPacketCadenceKnown(connection, report, publication.track, rows)) return;
  return { publicationId: publication.publicationId, trackId: publication.track.id, packets: rows.reduce((sum, row) => sum + row.packetsReceived, 0) };
}

function audioPacketCadenceKnown(connection: RTCPeerConnection, report: RTCStatsReport, track: MediaStreamTrack, rows: readonly RTCInboundRtpStreamStats[]): boolean {
  // Before the first RTP row, negotiated receiver codecs still identify Opus.
  const negotiated = rows.length
    ? rows.map((row) => (row.codecId ? report.get(row.codecId) : undefined))
    : (connection
        .getReceivers()
        .find((receiver) => receiver.track.id === track.id)
        ?.getParameters().codecs ?? []);
  const opus = negotiated.filter((codec) => codec?.mimeType?.toLowerCase() === "audio/opus");
  // Opus DTX still sends periodic silence packets; unknown cadence is excluded.
  return opus.length > 0 && opus.every((codec) => typeof codec.sdpFmtpLine === "string");
}
