import type { TelemetryEvent, TelemetrySink } from "../telemetry/types";
import type { TransportDiagnostic } from "../transport-diagnostics";
import { recordAudio, remoteAudioTrack } from "./audio-observation";
import { audioStats, increased, readStats, type AudioStats } from "./audio-stats";
import { connectionIsLive } from "./peer-connection";
import type { MediaPublication } from "./plane";
import type { CloudflareSFUPublication, CloudflareSFURemoteTrack } from "./types";

type ReceiveState = NonNullable<TransportDiagnostic["receive_state"]>;
type PlayResult = NonNullable<TransportDiagnostic["play_result"]>;
type FailureKind = NonNullable<TransportDiagnostic["media_error_kind"]>;
type Counts = NonNullable<TransportDiagnostic["receive_counts"]>;
type AudioSource = "microphone" | "screen_audio";
type Observation = { element: HTMLAudioElement; result?: PlayResult; started: boolean; time?: number; playing: boolean; onPlaying(): void };
type Entry = {
  source: AudioSource;
  projectionKey: string;
  observedTrack: ReturnType<typeof remoteAudioTrack>;
  hop?: TelemetryEvent["audio_observation"];
  since: number;
  pull: "announced" | "pull_requested" | "pull_failed" | "pull_succeeded";
  failure?: FailureKind;
  reported: boolean;
  projectionOff: boolean;
  trackId?: string;
  bytes?: number;
  sampledAt?: number;
  flatSince?: number;
  paused?: boolean;
};
type Snapshot = Pick<TransportDiagnostic, "receive_state" | "track_state" | "element_state" | "play_result">;

export type AudioReceiveHealthOptions = {
  now: () => number;
  setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  connection: () => RTCPeerConnection | null;
  tracks: () => Iterable<CloudflareSFURemoteTrack>;
  onEvent: (event: TransportDiagnostic) => void;
  audioTelemetry?: Pick<TelemetrySink, "record">;
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
      entry.sampledAt = undefined;
      entry.flatSince = undefined;
      entry.hop = undefined;
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
      const existing = this.#entries.get(publication.publicationId);
      if (existing) existing.paused = publication.paused;
      else {
        this.#entries.set(publication.publicationId, {
          source: publication.source,
          projectionKey: projectionKey(publication.participantId, publication.source),
          paused: publication.paused,
          observedTrack: publication.source === "microphone" && this.#options.audioTelemetry ? remoteAudioTrack(publication.participantId, publication.publicationId) : undefined,
          since: this.#options.now(),
          pull: "announced",
          reported: false,
          projectionOff: false,
        });
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
      this.#recordSample(stats, connection !== null && connectionIsLive(connection));
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
      entry.sampledAt = undefined;
      entry.flatSince = undefined;
    }
  }

  #resetPlayback(): void {
    for (const observations of this.#elements.values()) {
      for (const observation of observations) observation.time = undefined;
    }
  }

  #recordSample(stats: RTCStatsReport | undefined, connected: boolean): void {
    const tracks = new Map(Array.from(this.#options.tracks(), (publication) => [publication.publicationId, publication.track]));
    const inbound = audioStats(stats);
    const counts: Counts = {};
    const now = this.#options.now();
    for (const [id, entry] of this.#entries) {
      const track = tracks.get(id);
      if (!this.#enabled(entry, track)) {
        entry.projectionOff = true;
        entry.bytes = undefined;
        entry.sampledAt = undefined;
        entry.flatSince = undefined;
        this.#recordHop(entry, "remote_off");
        increment(counts, "projection_off");
        continue;
      }
      if (entry.projectionOff) {
        entry.since = now;
        entry.projectionOff = false;
      }
      const bytes = track ? inbound.get(track.id)?.bytesReceived : undefined;
      const comparable = track && entry.trackId === track.id && entry.bytes !== undefined && bytes !== undefined && bytes >= entry.bytes;
      const elapsed = comparable && entry.sampledAt !== undefined ? Math.floor(now - entry.sampledAt) : 0;
      const previousSample = entry.sampledAt;
      entry.sampledAt = now;
      const snapshot = this.#snapshot(entry, track, inbound);
      this.#recordAudioSample(entry, snapshot, elapsed >= 1000 && elapsed <= 60_000 ? previousSample : undefined, now, connected);
      const state = snapshot.receive_state ?? "announced";
      increment(counts, state);
      this.#reportStuck(entry, snapshot, now);
    }
    if (this.#entries.size > 0 && ++this.#samples % 12 === 0) {
      this.#options.onEvent({ event: "audio_receive_summary", receive_counts: counts });
    }
  }

  #recordAudioSample(entry: Entry, snapshot: Snapshot, previousSample: number | undefined, now: number, connected: boolean): void {
    if (!entry.observedTrack) return;
    if (previousSample !== undefined && snapshot.receive_state === "track_received") {
      entry.flatSince ??= previousSample;
      const flatMs = Math.floor(now - entry.flatSince);
      // Cover a full SFU sampling interval even when the endpoints sample at different times.
      if (flatMs >= 20_000) {
        if (flatMs <= 60_000) this.#recordHop(entry, "inbound_flat", flatMs);
        entry.flatSince = now;
      } else if (entry.hop === undefined) this.#recordHop(entry, "subscribed");
      return;
    }
    entry.flatSince = undefined;
    if (previousSample !== undefined && snapshot.receive_state === "playing") this.#recordHop(entry, "playing");
    else if (previousSample !== undefined && (snapshot.receive_state === "element_bound" || snapshot.receive_state === "bytes_flowing")) {
      if (snapshot.play_result === "NotAllowedError") this.#recordHop(entry, "autoplay_blocked");
      else if (snapshot.element_state === "paused" && snapshot.play_result === "ok") this.#recordHop(entry, "playback_paused");
      else this.#recordHop(entry, "inbound_flowing");
    } else if (connected && now - entry.since > 10_000 && snapshot.receive_state === "pull_failed") this.#recordHop(entry, "pull_failed");
    else if (entry.pull === "pull_succeeded") this.#recordHop(entry, "subscribed");
  }

  #recordHop(entry: Entry, hop: NonNullable<TelemetryEvent["audio_observation"]>, sampleMs?: number): void {
    if (!entry.observedTrack || (entry.hop === hop && hop !== "inbound_flat")) return;
    entry.hop = hop;
    recordAudio(this.#options.audioTelemetry, hop, entry.observedTrack, sampleMs);
  }

  /** What the page does with the audio of one remote track, for the stats window that names it. */
  playout(trackId: string): "playing" | "paused" | "no_element" | "unknown" {
    for (const [track, observations] of this.#elements) {
      if (track.id !== trackId) continue;
      const observation = boundElement(observations, track);
      return observation ? (observation.element.paused ? "paused" : "playing") : "no_element";
    }
    return "unknown";
  }

  #enabled(entry: Entry, track: MediaStreamTrack | undefined): boolean {
    if (entry.paused) return false;
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
    if (track.readyState !== "live") return snapshot;
    // Playback of a live track with growing bytes outranks the pull record: a pull stage that was never recorded must not hide audio the element is playing.
    if (entry.pull !== "pull_succeeded" && !(flowing && observation?.playing === true)) return snapshot;
    snapshot.receive_state = receivedStage(flowing, observation);
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

function projectionKey(participantId: string, source: string): string {
  return `${participantId}\u0000${source === "screen_audio" ? "screen" : source}`;
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

function trackState(track: MediaStreamTrack): Snapshot["track_state"] {
  if (track.readyState === "ended") return "ended";
  return track.muted ? "muted" : "live";
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
  observation.playing = !observation.element.paused && observation.started && observation.time !== undefined && time > observation.time;
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

function receivedStage(flowing: boolean, observation: ReturnType<typeof boundElement>): Snapshot["receive_state"] {
  if (!flowing) return "track_received";
  if (!observation) return "bytes_flowing";
  return observation.playing ? "playing" : "element_bound";
}
