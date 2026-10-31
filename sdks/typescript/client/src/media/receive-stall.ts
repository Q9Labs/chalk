import type { MediaPublication } from "./plane";
import type { CloudflareSFURemoteTrack } from "./types";

export const RECEIVE_STALL_WINDOW_MS = 7000;
export const RECEIVE_STARTUP_GRACE_MS = 20_000;
// A listener must hear an enabled microphone within seconds, so audio gets its own windows.
// Opus DTX sends a packet about every 400 ms while silent, so 1.5 s is still several packet intervals.
export const AUDIO_STALL_WINDOW_MS = 1500;
export const AUDIO_STARTUP_GRACE_MS = 3000;
// Nothing desired is flowing for this long: the receive session itself is suspect, not one publisher.
export const RECEIVE_ESCALATION_MS = 8000;
// With one desired publisher, "nothing flows" cannot tell a dead publisher from a dead receive session, so wait longer.
export const RECEIVE_SOLO_ESCALATION_MS = 30_000;
export const RECEIVE_REBUILD_COOLDOWN_MS = 15_000;
// Rebuilding the receive session republishes every local track, so back off while nothing flows.
const MAX_REBUILD_COOLDOWN_MS = 120_000;
const MAX_SAMPLE_GAP_MS = 3000;

export type ReceivePacketSample = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly packets: number;
  readonly audio?: boolean;
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

  flowing(publicationId: string): boolean {
    return this.#progress.get(publicationId)?.flowing === true;
  }

  #observeTrack(now: number, sample: ReceivePacketSample): "stalled" | "advanced" | "resumed" | null {
    const previous = this.#progress.get(sample.publicationId);
    const sameTrack = previous?.trackId === sample.trackId;
    if (sameTrack && previous.packets === sample.packets) {
      const window = previous.flowing ? stallWindow(sample) : startupGrace(sample);
      return now - previous.advancedAt >= window ? "stalled" : null;
    }
    return this.#advanceTrack(now, sample, previous);
  }

  #advanceTrack(now: number, { publicationId, trackId, packets, audio }: ReceivePacketSample, previous: ReceiveProgress | undefined): "advanced" | "resumed" | null {
    const window = stallWindow({ audio });
    const advanced = previous?.trackId === trackId && packets > previous.packets;
    const flowingSince = advanced && now - previous.advancedAt < window ? previous.flowingSince : now;
    this.#progress.set(publicationId, { trackId, packets, advancedAt: now, flowing: advanced, flowingSince });
    if (!advanced) return null;
    return now - flowingSince >= window ? "resumed" : "advanced";
  }
}

function stallWindow({ audio }: { readonly audio?: boolean }): number {
  return audio ? AUDIO_STALL_WINDOW_MS : RECEIVE_STALL_WINDOW_MS;
}
function startupGrace({ audio }: { readonly audio?: boolean }): number {
  return audio ? AUDIO_STARTUP_GRACE_MS : RECEIVE_STARTUP_GRACE_MS;
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

/**
 * Owns eligibility, pending stalls and the budget across replacement peers.
 * Rebuild budgets belong to a remote participant's source, not to one publication id:
 * a rebuild republishes every local track, and the peers' replacement publications must not renew them.
 */
export class ReceiveStallRecovery {
  readonly #detector = new ReceiveStallDetector();
  readonly #attempts = new Map<string, number>();
  readonly #sources = new Map<string, string>();
  readonly #repulled = new Set<string>();
  // Re-pulled but not yet restored. Retired receivers vanish from stats, so this cannot depend on detector samples.
  readonly #awaiting = new Set<string>();
  readonly #identities = new Map<string, CloudflareSFURemoteTrack>();
  // Audio publications are healed forever: no repull or rebuild budget applies to them.
  readonly #unhealthySince = new Map<string, number>();
  #audio = new Set<string>();
  #lastRebuildAt = Number.NEGATIVE_INFINITY;
  #rebuildStreak = 0;
  #now = 0;
  #expected = new Set<string>();
  #screens = new Set<string>();
  #stalled = new Set<string>();
  #active: readonly string[] = [];
  #observations: readonly ReceiveStallObservation[] = Object.freeze([]);

  get observations(): readonly ReceiveStallObservation[] {
    return this.#observations;
  }

  /** `subscribable` leaves out publications this client would never pull, such as an abandoned participant's. */
  expect(publications: readonly MediaPublication[], participantId: string, subscribable: (publication: MediaPublication) => boolean = () => true): void {
    const enabled = publications.filter((publication) => publication.participantId !== participantId && publication.enabled && subscribable(publication));
    this.#expected = new Set(enabled.flatMap((publication) => (publication.publicationId ? [publication.publicationId] : [])));
    this.#screens = new Set(enabled.filter((publication) => publication.source === "screen").map((publication) => publication.participantId));
    this.#audio = new Set(enabled.filter((publication) => publication.source === "microphone" || publication.source === "screen_audio").flatMap((publication) => (publication.publicationId ? [publication.publicationId] : [])));
    for (const id of this.#unhealthySince.keys()) if (!this.#audio.has(id)) this.#unhealthySince.delete(id);
    this.#pruneWithdrawn(publications);
    this.#pruneAttempts(publications);
    for (const publication of this.#identities.values()) {
      if (this.#isExpected(publication)) continue;
      this.#detector.forget(publication.publicationId);
      this.#stalled.delete(publication.publicationId);
      this.#awaiting.delete(publication.publicationId);
    }
    this.#active = [...this.#identities.values()].filter((publication) => this.#isExpected(publication)).map((publication) => publication.publicationId);
  }

  suspend(): void {
    this.#expected.clear();
    this.#screens.clear();
    this.#audio.clear();
    this.#unhealthySince.clear();
    this.clear();
  }

  /** Nothing is desired, so the reconcile tick has nothing to read stats for. */
  hasExpectations(): boolean {
    return this.#expected.size > 0 || this.#audio.size > 0 || this.#screens.size > 0;
  }

  hasUnhealthyAudio(tracks: Iterable<CloudflareSFURemoteTrack>): boolean {
    return this.missingAudio(tracks).length > 0 || [...this.#audio].some((id) => this.#stalled.has(id));
  }

  isAudio(publicationId: string): boolean {
    return this.#audio.has(publicationId);
  }

  /** Enabled audio publications that no live receiver currently carries. */
  missingAudio(tracks: Iterable<CloudflareSFURemoteTrack>): readonly string[] {
    const pulled = new Set([...tracks].map((track) => track.publicationId));
    return [...this.#audio].filter((id) => !pulled.has(id));
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

  #pruneAttempts(publications: readonly MediaPublication[]): void {
    const advertised = new Set(publications.flatMap((publication) => (publication.source === "screen" ? [sourceKey(publication), sourceKey({ ...publication, source: "screen_audio" })] : [sourceKey(publication)])));
    for (const key of this.#attempts.keys()) if (!advertised.has(key)) this.#attempts.delete(key);
  }

  isStalled(publicationId: string): boolean {
    return this.#stalled.has(publicationId);
  }

  canRepull(id: string): boolean {
    return this.#stalled.has(id) && (this.#audio.has(id) || !this.#repulled.has(id));
  }

  reserveRepull(id: string): boolean {
    if (!this.canRepull(id)) return false;
    this.#repulled.add(id);
    this.#awaiting.add(id);
    return true;
  }

  restarted(id: string): void {
    this.#detector.forget(id);
    this.#stalled.delete(id);
    this.#awaiting.delete(id);
  }

  canRebuild(id?: string): boolean {
    return this.#active.some((active) => (id === undefined || id === active) && !this.#audio.has(active) && this.#stalled.has(active) && this.#rebuildsLeft(active));
  }

  reserveRebuild(): boolean {
    if (!this.canRebuild()) return false;
    for (const id of this.#active) {
      const source = this.#sources.get(id);
      if (source !== undefined && this.canRebuild(id)) this.#attempts.set(source, (this.#attempts.get(source) ?? 0) + 1);
    }
    return true;
  }

  #rebuildsLeft(id: string): boolean {
    const source = this.#sources.get(id);
    return source !== undefined && (this.#attempts.get(source) ?? 0) < MAX_RECEIVE_REBUILDS;
  }

  /** The media connection was replaced: its receivers are gone, so nothing is awaiting a restore. */
  replaced(): void {
    this.#awaiting.clear();
    this.#unhealthySince.clear();
    this.#lastRebuildAt = this.#now;
    this.#rebuildStreak++;
    this.clear();
  }

  clear(): void {
    this.#detector.clear();
    this.#stalled.clear();
    this.#active = [];
  }

  /** A null report means the receive connection is not carrying media: no packet can be observed. */
  sample(now: number, connection: RTCPeerConnection, report: RTCStatsReport | null, tracks: Iterable<CloudflareSFURemoteTrack>): ReceiveSampleResult {
    this.#now = now;
    const active = [...tracks].filter((publication) => this.#isExpected(publication));
    for (const publication of active) this.#rememberIdentity(publication);
    this.#active = active.map((publication) => publication.publicationId);
    const samples = report ? active.flatMap((publication) => receivePacketSample(connection, report, publication, this.#audio.has(publication.publicationId)) ?? []) : [];
    const { stalled, advanced, resumed } = this.#detector.sample(now, samples);
    for (const id of resumed) {
      const source = this.#sources.get(id);
      if (source !== undefined) this.#attempts.delete(source);
      this.#repulled.delete(id);
      this.#awaiting.delete(id);
    }
    const newlyStalled = stalled.filter((id) => !this.#stalled.has(id));
    const unrestored = this.#active.filter((id) => this.#awaiting.has(id) && !stalled.includes(id));
    this.#stalled = new Set([...stalled, ...unrestored]);
    if (newlyStalled.length) this.#record(now);
    return { stalled: [...stalled, ...unrestored], advanced, newlyStalled, escalate: this.#observeAudioHealth(now, report !== null, new Set(samples.map((sample) => sample.publicationId))) };
  }

  // Escalate only when nothing desired flows: if any publisher is heard, audio or video, the receive session
  // works and a re-pull of the broken one is the whole repair.
  #observeAudioHealth(now: number, connected: boolean, sampled: ReadonlySet<string>): boolean {
    const pulled = new Set(this.#active);
    const sessionCarriesMedia = connected && this.#active.some((id) => !this.#audio.has(id) && this.#detector.flowing(id));
    for (const id of this.#audio) {
      // A fresh pull is unhealthy until packets actually advance, so repeated re-pulls cannot reset the clock.
      // Audio whose packet cadence is unknown has no samples, so it can neither stall nor count as broken.
      const flowing = this.#detector.flowing(id) || !sampled.has(id);
      const healthy = connected && pulled.has(id) && flowing && !this.#stalled.has(id);
      if (healthy) this.#unhealthySince.delete(id);
      else if (!this.#unhealthySince.has(id)) this.#unhealthySince.set(id, now);
    }
    if (this.#audio.size > this.#unhealthySince.size) this.#rebuildStreak = 0;
    if (this.#audio.size === 0 || this.#unhealthySince.size < this.#audio.size || sessionCarriesMedia) return false;
    const cooldown = Math.min(RECEIVE_REBUILD_COOLDOWN_MS * 2 ** Math.max(this.#rebuildStreak - 1, 0), MAX_REBUILD_COOLDOWN_MS);
    const patience = connected && this.#audio.size < 2 ? RECEIVE_SOLO_ESCALATION_MS : RECEIVE_ESCALATION_MS;
    return now - Math.min(...this.#unhealthySince.values()) >= patience && now - this.#lastRebuildAt >= cooldown;
  }

  #isExpected(publication: CloudflareSFURemoteTrack): boolean {
    return publication.source === "screen_audio" ? this.#screens.has(publication.participantId) : this.#expected.has(publication.publicationId);
  }

  #rememberIdentity(publication: CloudflareSFURemoteTrack): void {
    const key = sourceKey(publication);
    const previous = this.#identities.get(key);
    if (previous && previous.publicationId !== publication.publicationId) this.#forget(previous.publicationId);
    this.#identities.set(key, publication);
    this.#sources.set(publication.publicationId, key);
  }

  #forget(id: string): void {
    this.#detector.forget(id);
    this.#stalled.delete(id);
    this.#awaiting.delete(id);
    this.#repulled.delete(id);
    this.#sources.delete(id);
  }

  #record(now: number): void {
    const observation = Object.freeze({ event: "receive_stalled" as const, scope: this.#active.every((id) => this.#stalled.has(id)) ? ("all" as const) : ("partial" as const), observedAtMs: now, expectedTracks: this.#active.length, stalledTracks: this.#stalled.size });
    this.#observations = Object.freeze([...this.#observations.slice(-(MAX_RECEIVE_OBSERVATIONS - 1)), observation]);
  }
}

function sourceKey({ participantId, source }: { readonly participantId: string; readonly source: string }): string {
  return `${participantId}\0${source}`;
}

export type ReceiveSampleResult = {
  readonly stalled: readonly string[];
  readonly advanced: readonly string[];
  readonly newlyStalled: readonly string[];
  readonly escalate: boolean;
};

function receivePacketSample(connection: RTCPeerConnection, report: RTCStatsReport, publication: CloudflareSFURemoteTrack, audio: boolean): ReceivePacketSample | undefined {
  const rows = [...report.values()].filter((row) => row.type === "inbound-rtp" && row.trackIdentifier === publication.track.id);
  if (rows.some((row) => !Number.isSafeInteger(row.packetsReceived) || row.packetsReceived < 0)) return;
  if (publication.track.kind === "audio" && !audioPacketCadenceKnown(connection, report, publication.track, rows)) return;
  return { publicationId: publication.publicationId, trackId: publication.track.id, packets: rows.reduce((sum, row) => sum + row.packetsReceived, 0), audio };
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
