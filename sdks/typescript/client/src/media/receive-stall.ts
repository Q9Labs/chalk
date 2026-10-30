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

/** Only consecutive, timely observations of expected media establish a stall. */
export class ReceiveStallDetector {
  readonly #progress = new Map<string, { trackId: string; packets: number; advancedAt: number; flowing: boolean }>();
  #sampledAt: number | undefined;

  forget(publicationId: string): void {
    this.#progress.delete(publicationId);
  }

  clear(): void {
    this.#progress.clear();
    this.#sampledAt = undefined;
  }

  sample(now: number, tracks: readonly ReceivePacketSample[]): { readonly stalled: readonly string[]; readonly advanced: readonly string[] } {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.clear();
    this.#sampledAt = now;
    const observed = new Set(tracks.map((track) => track.publicationId));
    for (const id of this.#progress.keys()) if (!observed.has(id)) this.#progress.delete(id);
    const observations = tracks.map((track) => ({ id: track.publicationId, outcome: this.#observeTrack(now, track) }));
    return {
      stalled: observations.filter((track) => track.outcome === "stalled").map((track) => track.id),
      advanced: observations.filter((track) => track.outcome === "advanced").map((track) => track.id),
    };
  }

  #observeTrack(now: number, { publicationId, trackId, packets }: ReceivePacketSample): "stalled" | "advanced" | null {
    const previous = this.#progress.get(publicationId);
    const sameTrack = previous?.trackId === trackId;
    if (sameTrack && previous.packets === packets) {
      const window = previous.flowing ? RECEIVE_STALL_WINDOW_MS : RECEIVE_STARTUP_GRACE_MS;
      return now - previous.advancedAt >= window ? "stalled" : null;
    }
    this.#progress.set(publicationId, { trackId, packets, advancedAt: now, flowing: sameTrack && packets > previous.packets });
    return sameTrack && packets > previous.packets ? "advanced" : null;
  }
}

/** Keeps pending recovery valid only while current, expected RTP remains stalled. */
export class ReceiveStallRecovery {
  readonly #detector = new ReceiveStallDetector();
  #expected = new Set<string>();
  #stalled = new Set<string>();

  expect(publications: readonly MediaPublication[], participantId: string): void {
    const expected = new Set(publications.flatMap((publication) => (publication.participantId !== participantId && publication.enabled && publication.publicationId ? [publication.publicationId] : [])));
    for (const id of this.#expected) {
      if (expected.has(id)) continue;
      this.#detector.forget(id);
      this.#stalled.delete(id);
    }
    this.#expected = expected;
  }

  isStalled(publicationId: string): boolean {
    return this.#stalled.has(publicationId);
  }

  clear(): void {
    this.#detector.clear();
    this.#stalled.clear();
  }

  sample(now: number, connection: RTCPeerConnection, report: RTCStatsReport, tracks: Iterable<CloudflareSFURemoteTrack>): { readonly stalled: readonly string[]; readonly advanced: readonly string[]; readonly newlyStalled: readonly string[] } {
    const samples = [...tracks].filter((publication) => this.#expected.has(publication.publicationId)).flatMap((publication) => receivePacketSample(connection, report, publication) ?? []);
    const { stalled, advanced } = this.#detector.sample(now, samples);
    const newlyStalled = stalled.filter((id) => !this.#stalled.has(id));
    // Progress, an ineligible publication or a throttled sample invalidates a
    // pending stall, including while publication discovery is still in flight.
    this.#stalled = new Set(stalled);
    return { stalled, advanced, newlyStalled };
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
