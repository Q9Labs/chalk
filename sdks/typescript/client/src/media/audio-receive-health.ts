import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import type { MediaPublication } from "./plane";
import type { CloudflareSFUPublication, CloudflareSFURemoteTrack } from "./types";

type ReceiveState = NonNullable<ConnectionReportTransportEvent["receive_state"]>;
type PlayResult = NonNullable<ConnectionReportTransportEvent["play_result"]>;
type FailureKind = NonNullable<ConnectionReportTransportEvent["media_error_kind"]>;
type Counts = NonNullable<ConnectionReportTransportEvent["receive_counts"]>;
type AudioSource = "microphone" | "screen_audio";
type Observation = { element: HTMLAudioElement; result?: PlayResult; started: boolean; time?: number; playing: boolean; onPlaying(): void };
type Entry = {
  source: AudioSource;
  projectionKey: string;
  since: number;
  pull: "announced" | "pull_requested" | "pull_failed" | "pull_succeeded";
  failure?: FailureKind;
  reported: boolean;
  projectionOff: boolean;
  trackId?: string;
  bytes?: number;
};
type Snapshot = Pick<ConnectionReportTransportEvent, "receive_state" | "track_state" | "element_state" | "play_result">;

export type AudioReceiveHealthOptions = {
  now: () => number;
  setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  connection: () => RTCPeerConnection | null;
  tracks: () => Iterable<CloudflareSFURemoteTrack>;
  onEvent: (event: ConnectionReportTransportEvent) => void;
};

export class AudioReceiveHealth {
  readonly #options: AudioReceiveHealthOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #elements = new Map<MediaStreamTrack, Set<Observation>>();
  #projection: Set<string> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;
  #sampling = false;
  #samples = 0;
  #stuckEvents = 0;
  #connection: RTCPeerConnection | null = null;
  #connectionRevision = 0;

  constructor(options: AudioReceiveHealthOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#disposed || this.#timer !== undefined) return;
    this.#timer = this.#options.setInterval(() => {
      void this.sample();
    }, 5000);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) this.#options.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#entries.clear();
    for (const observations of this.#elements.values()) {
      for (const observation of observations) observation.element.removeEventListener("playing", observation.onPlaying);
    }
    this.#elements.clear();
    this.#projection = undefined;
  }

  replaced(): void {
    if (this.#disposed) return;
    this.#connectionRevision++;
    this.#resetPlayback();
    for (const entry of this.#entries.values()) {
      entry.pull = "announced";
      entry.since = this.#options.now();
      entry.failure = undefined;
      entry.reported = false;
      entry.trackId = undefined;
      entry.bytes = undefined;
    }
  }

  projection(publications: readonly MediaPublication[]): void {
    if (this.#disposed) return;
    this.#projection = new Set();
    for (const publication of publications) {
      if (!publication.enabled) continue;
      this.#projection.add(projectionKey(publication.participantId, publication.source));
    }
    for (const entry of this.#entries.values()) {
      if (!this.#enabled(entry, undefined)) entry.projectionOff = true;
    }
  }

  roster(publications: Iterable<CloudflareSFUPublication>): void {
    if (this.#disposed) return;
    const desired = new Set<string>();
    for (const publication of publications) {
      if (publication.source !== "microphone" && publication.source !== "screen_audio") continue;
      desired.add(publication.publicationId);
      if (!this.#entries.has(publication.publicationId)) {
        this.#entries.set(publication.publicationId, { source: publication.source, projectionKey: projectionKey(publication.participantId, publication.source), since: this.#options.now(), pull: "announced", reported: false, projectionOff: false });
      }
    }
    for (const id of this.#entries.keys()) {
      if (!desired.has(id)) this.#entries.delete(id);
    }
    if (this.#entries.size === 0) this.#samples = 0;
  }

  pullRequested(ids: Iterable<string>): void {
    this.#setPull(ids, "pull_requested");
  }

  pullSucceeded(ids: Iterable<string>): void {
    this.#setPull(ids, "pull_succeeded");
  }

  #setPull(ids: Iterable<string>, state: Entry["pull"], failure?: FailureKind): void {
    if (this.#disposed) return;
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      entry.pull = state;
      entry.failure = failure;
    }
  }

  pullFailed(id: string, kind: FailureKind): void {
    this.#setPull([id], "pull_failed", kind);
  }

  observeAudioElement(track: MediaStreamTrack, element: HTMLAudioElement): { played(result: unknown): void; detach(): void } {
    const observation: Observation = {
      element,
      started: false,
      playing: false,
      onPlaying: () => {
        observation.started = true;
      },
    };
    const observations = this.#elements.get(track) ?? new Set<Observation>();
    if (!this.#disposed) {
      element.addEventListener("playing", observation.onPlaying);
      observations.add(observation);
      this.#elements.set(track, observations);
    }
    return {
      played: (result) => {
        if (!this.#disposed && observations.has(observation)) {
          observation.result = playResult(result);
          if (observation.result === "ok") observation.started = true;
        }
      },
      detach: () => {
        element.removeEventListener("playing", observation.onPlaying);
        observations.delete(observation);
        if (observations.size === 0 && this.#elements.get(track) === observations) this.#elements.delete(track);
      },
    };
  }

  async sample(): Promise<void> {
    if (this.#disposed || this.#sampling || this.#entries.size === 0) return;
    this.#sampling = true;
    try {
      const connection = this.#options.connection();
      const revision = this.#connectionRevision;
      this.#resetConnection(connection);
      const stats = await readStats(connection);
      if (this.#disposed || revision !== this.#connectionRevision || connection !== this.#options.connection()) return;
      this.#recordSample(stats);
    } finally {
      this.#sampling = false;
    }
  }

  #resetConnection(connection: RTCPeerConnection | null): void {
    if (connection === this.#connection) return;
    this.#connection = connection;
    this.#resetPlayback();
    for (const entry of this.#entries.values()) {
      entry.bytes = undefined;
    }
  }

  #resetPlayback(): void {
    for (const observations of this.#elements.values()) {
      for (const observation of observations) observation.time = undefined;
    }
  }

  #recordSample(stats: RTCStatsReport | undefined): void {
    const tracks = new Map(Array.from(this.#options.tracks(), (publication) => [publication.publicationId, publication.track]));
    const inbound = audioStats(stats);
    const counts: Counts = {};
    const now = this.#options.now();
    for (const [id, entry] of this.#entries) {
      const track = tracks.get(id);
      if (!this.#enabled(entry, track)) {
        entry.projectionOff = true;
        increment(counts, "projection_off");
        continue;
      }
      if (entry.projectionOff) {
        entry.since = now;
        entry.projectionOff = false;
      }
      const snapshot = this.#snapshot(entry, track, inbound);
      const state = snapshot.receive_state ?? "announced";
      increment(counts, state);
      this.#reportStuck(entry, snapshot, now);
    }
    if (this.#entries.size > 0 && ++this.#samples % 12 === 0) {
      this.#options.onEvent({ event: "audio_receive_summary", receive_counts: counts });
    }
  }

  #enabled(entry: Entry, track: MediaStreamTrack | undefined): boolean {
    if (this.#projection === undefined) return track?.enabled !== false;
    return this.#projection.has(entry.projectionKey);
  }

  #snapshot(entry: Entry, track: MediaStreamTrack | undefined, inbound: Map<string, AudioStats>): Snapshot {
    const snapshot: Snapshot = { receive_state: entry.pull };
    if (!track) return snapshot;
    snapshot.track_state = trackState(track);
    const flowing = updateBytes(entry, track, inbound.get(track.id));
    const observation = boundElement(this.#elements.get(track), track);
    if (observation) {
      snapshot.element_state = observation.element.paused ? "paused" : "playing";
      snapshot.play_result = observation.result;
    }
    if (entry.pull !== "pull_succeeded" || track.readyState !== "live") return snapshot;
    snapshot.receive_state = "track_received";
    if (!flowing) return snapshot;
    snapshot.receive_state = "bytes_flowing";
    if (!observation) return snapshot;
    snapshot.receive_state = observation.playing ? "playing" : "element_bound";
    return snapshot;
  }

  #reportStuck(entry: Entry, snapshot: Snapshot, now: number): void {
    if (snapshot.receive_state === "playing") {
      entry.reported = false;
      entry.since = now;
      return;
    }
    if (entry.reported || this.#stuckEvents >= 8 || now - entry.since <= 10000) return;
    entry.reported = true;
    this.#stuckEvents++;
    this.#options.onEvent({
      event: "audio_receive_stuck",
      source: entry.source,
      ...snapshot,
      duration_ms: Math.min(2147483647, Math.max(0, Math.floor(now - entry.since))),
      ...(entry.failure ? { media_error_kind: entry.failure, media_error_step: "sfu_tracks" } : {}),
    });
  }
}

type AudioStats = { bytesReceived?: number };

function projectionKey(participantId: string, source: string): string {
  return `${participantId}\u0000${source === "screen_audio" ? "screen" : source}`;
}

function audioStats(report: RTCStatsReport | undefined): Map<string, AudioStats> {
  const result = new Map<string, AudioStats>();
  report?.forEach((row) => {
    if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.trackIdentifier === "string") result.set(row.trackIdentifier, row);
  });
  return result;
}

function updateBytes(entry: Entry, track: MediaStreamTrack, stats: AudioStats | undefined): boolean {
  if (entry.trackId !== track.id) {
    entry.trackId = track.id;
    entry.bytes = undefined;
  }
  const bytes = stats?.bytesReceived;
  const flowing = increased(bytes, entry.bytes);
  entry.bytes = bytes;
  return flowing;
}

function increased(current: number | undefined, previous: number | undefined): boolean {
  return current !== undefined && previous !== undefined && current > previous;
}

function trackState(track: MediaStreamTrack): Snapshot["track_state"] {
  if (track.readyState === "ended") return "ended";
  return track.muted ? "muted" : "live";
}

async function readStats(connection: RTCPeerConnection | null): Promise<RTCStatsReport | undefined> {
  try {
    return await connection?.getStats();
  } catch {
    return undefined;
  }
}

function boundElement(observations: Set<Observation> | undefined, track: MediaStreamTrack): Observation | undefined {
  let selected: Observation | undefined;
  let rank = -1;
  for (const observation of observations ?? []) {
    const stream = observation.element.srcObject;
    if (stream === null || !("getTracks" in stream) || !stream.getTracks().includes(track)) continue;
    updatePlayback(observation);
    const priority = Number(observation.playing) * 2 + Number(!observation.element.paused);
    if (priority > rank) {
      selected = observation;
      rank = priority;
    }
  }
  return selected;
}

function updatePlayback(observation: Observation): void {
  const time = observation.element.currentTime;
  observation.playing = observation.started && observation.time !== undefined && time > observation.time;
  observation.time = time;
}

function playResult(result: unknown): PlayResult {
  if (result === undefined) return "ok";
  if (typeof DOMException !== "undefined" && result instanceof DOMException && (result.name === "NotAllowedError" || result.name === "AbortError")) return result.name;
  return "unknown";
}

function increment(counts: Counts, state: ReceiveState | "projection_off"): void {
  counts[state] = Math.min(10000, (counts[state] ?? 0) + 1);
}
