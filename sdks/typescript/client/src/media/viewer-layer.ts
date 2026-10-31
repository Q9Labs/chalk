import { videoRenderSize } from "./video-render-size";

// A viewer picks which simulcast layer of a remote camera it receives. The SFU
// never adapts by itself (priorityOrdering and ridNotAvailable default to none),
// so this decides from the viewer's own receive stats and the size of its tile.
// Chrome's availableIncomingBitrate is left out: it follows the rate the sender
// chose to send, so it cannot say whether a link has room for h.
export type ViewerLayer = "h" | "l";

// l is 360p. A tile this small gains nothing from h; the gap between the two
// limits keeps a tile that is resized around the edge from flapping.
const LOW_TILE_MAX_HEIGHT = 400;
const HIGH_TILE_MIN_HEIGHT = 480;
const BAD_LOSS = 0.05;
const SEVERE_LOSS = 0.15;
// Chrome counts a freeze after a gap of about 200 ms at 24 fps, which a jitter spike alone causes.
const SEVERE_FREEZE_SECONDS = 1;
const GOOD_LOSS = 0.02;
const MIN_FRAMES_PER_SECOND = 8;
const DROP_AFTER_BAD_SAMPLES = 2;
const RISE_AFTER_GOOD_SAMPLES = 15;
const RISE_AFTER_TILE_GROWS_SAMPLES = 2;
// A switch needs a keyframe, so the next samples describe the old layer.
const SETTLE_SAMPLES = 2;
const FAILED_PROBE_WITHIN_SAMPLES = 30;
const STABLE_SAMPLES_RESETTING_BACKOFF = 60;
const MAX_RISE_BACKOFF = 8;
const FRAME_RATE_COMPARISON_SAMPLES = 3;

export type ViewerLayerSample = {
  /** Fraction of packets lost since the last sample; undefined when no packet arrived or was lost. */
  readonly lossFraction: number | undefined;
  readonly framesPerSecond: number | undefined;
  readonly newFreezes: number;
  readonly freezeSeconds: number;
  /** Rendered tile height in device pixels, when the UI reports it. */
  readonly tileHeight: number | undefined;
};

type Health = "good" | "bad" | "severe" | "unknown";

export class ViewerLayerPolicy {
  #layer: ViewerLayer = "h";
  #tileIsSmall = false;
  #limitedByNetwork = false;
  #badSamples = 0;
  #goodSamples = 0;
  #stableSamples = 0;
  #samplesSinceRise = Number.POSITIVE_INFINITY;
  #settling = 0;
  #backoff = 1;
  #frameRateProbe: number | undefined;
  #senderFrameRate: number | undefined;
  #unimprovedSamples = 0;

  get layer(): ViewerLayer {
    return this.#layer;
  }

  /** Drops fast, rises slowly: a failed attempt at h doubles the wait before the next one. */
  sample(sample: ViewerLayerSample): ViewerLayer {
    this.#tileIsSmall = tileIsSmall(this.#tileIsSmall, sample.tileHeight);
    if (this.#layer === "h" && sample.framesPerSecond !== undefined && sample.framesPerSecond >= MIN_FRAMES_PER_SECOND) this.#senderFrameRate = undefined;
    const checkFrameRate = this.#layer === "h" && (this.#senderFrameRate === undefined || (sample.framesPerSecond ?? 0) < this.#senderFrameRate * 0.75);
    const health = this.#settling > 0 ? this.#settle() : classify(sample, checkFrameRate);
    return this.#layer === "h" ? this.#sampleHigh(health, sample) : this.#sampleLow(health, sample);
  }

  #settle(): Health {
    this.#settling--;
    return "unknown";
  }

  #sampleHigh(health: Health, sample: ViewerLayerSample): ViewerLayer {
    this.#samplesSinceRise++;
    if (this.#tileIsSmall) return this.#drop(false);
    if (health === "bad" || health === "severe") {
      this.#stableSamples = 0;
      if (health === "severe" || ++this.#badSamples >= DROP_AFTER_BAD_SAMPLES) return this.#drop(true, frameRateProbe(sample, health));
      return this.#layer;
    }
    this.#badSamples = 0;
    if (health === "good" && ++this.#stableSamples >= STABLE_SAMPLES_RESETTING_BACKOFF) this.#backoff = 1;
    return this.#layer;
  }

  #sampleLow(health: Health, sample: ViewerLayerSample): ViewerLayer {
    if (this.#tileIsSmall || health !== "good") {
      this.#goodSamples = 0;
      this.#unimprovedSamples = 0;
      return this.#layer;
    }
    if (this.#detectSenderLimit(sample.framesPerSecond)) {
      this.#senderFrameRate = this.#frameRateProbe;
      this.#backoff = 1;
      return this.#rise();
    }
    const needed = this.#limitedByNetwork ? RISE_AFTER_GOOD_SAMPLES * this.#backoff : RISE_AFTER_TILE_GROWS_SAMPLES;
    if (++this.#goodSamples < needed) return this.#layer;
    return this.#rise();
  }

  #detectSenderLimit(fps: number | undefined): boolean {
    // If clean, settled l samples buy no frame rate, keep h's resolution.
    if (this.#frameRateProbe === undefined || fps === undefined || fps <= 0 || fps > this.#frameRateProbe * 1.25) {
      this.#unimprovedSamples = 0;
      return false;
    }
    return ++this.#unimprovedSamples >= FRAME_RATE_COMPARISON_SAMPLES;
  }

  #drop(byNetwork: boolean, frameRate?: number): ViewerLayer {
    this.#frameRateProbe = frameRate;
    this.#unimprovedSamples = 0;
    if (byNetwork) {
      if (this.#samplesSinceRise < FAILED_PROBE_WITHIN_SAMPLES) this.#backoff = Math.min(this.#backoff * 2, MAX_RISE_BACKOFF);
      this.#limitedByNetwork = true;
    }
    return this.#switchTo("l");
  }

  #rise(): ViewerLayer {
    this.#limitedByNetwork = false;
    this.#samplesSinceRise = 0;
    return this.#switchTo("h");
  }

  #switchTo(layer: ViewerLayer): ViewerLayer {
    this.#layer = layer;
    this.#badSamples = 0;
    this.#goodSamples = 0;
    this.#stableSamples = 0;
    this.#settling = SETTLE_SAMPLES;
    return layer;
  }
}

function tileIsSmall(previous: boolean, height: number | undefined): boolean {
  if (height === undefined) return previous;
  if (height <= LOW_TILE_MAX_HEIGHT) return true;
  return height < HIGH_TILE_MIN_HEIGHT ? previous : false;
}

function isSevere({ lossFraction, freezeSeconds }: ViewerLayerSample): boolean {
  return freezeSeconds >= SEVERE_FREEZE_SECONDS || (lossFraction !== undefined && lossFraction >= SEVERE_LOSS);
}

// Frames that stop while packets still arrive mean the layer is too heavy;
// frames that stop with no packets belong to receive-stall recovery.
// Comparing clean frame rates across layers separates sender limits from a heavy h.
function isBad({ lossFraction, framesPerSecond, newFreezes }: ViewerLayerSample, checkFrameRate: boolean): boolean {
  if (newFreezes > 0 || (lossFraction !== undefined && lossFraction >= BAD_LOSS)) return true;
  return checkFrameRate && lossFraction !== undefined && framesPerSecond !== undefined && framesPerSecond < MIN_FRAMES_PER_SECOND;
}

function frameRateProbe(sample: ViewerLayerSample, health: Health): number | undefined {
  return health === "severe" || isBad(sample, false) ? undefined : sample.framesPerSecond;
}

function classify(sample: ViewerLayerSample, checkFrameRate: boolean): Health {
  if (isSevere(sample)) return "severe";
  if (isBad(sample, checkFrameRate)) return "bad";
  const { lossFraction, framesPerSecond } = sample;
  if (lossFraction === undefined || framesPerSecond === undefined) return "unknown";
  return lossFraction < GOOD_LOSS ? "good" : "unknown";
}

type InboundCounters = {
  readonly timestamp: number;
  readonly packetsReceived: number;
  readonly packetsLost: number;
  readonly framesDecoded: number;
  readonly freezeCount: number;
  readonly freezeSeconds: number;
};

type ViewerStatsRow = {
  readonly type?: string;
  readonly kind?: string;
  readonly trackIdentifier?: string;
  readonly timestamp?: number;
  readonly packetsReceived?: number;
  readonly packetsLost?: number;
  readonly framesDecoded?: number;
  readonly freezeCount?: number;
  readonly totalFreezesDuration?: number;
};

/** Turns cumulative inbound-rtp counters into per-interval rates for one video track. */
export class ViewerStatsReader {
  readonly #previous = new Map<string, InboundCounters>();

  read(stats: Iterable<ViewerStatsRow>, trackId: string): Pick<ViewerLayerSample, "lossFraction" | "framesPerSecond" | "newFreezes" | "freezeSeconds"> | undefined {
    const row = [...stats].find((stat) => stat.type === "inbound-rtp" && stat.kind === "video" && stat.trackIdentifier === trackId);
    const counters = row && inboundCounters(row);
    if (!counters) return undefined;
    const previous = this.#previous.get(trackId);
    this.#previous.set(trackId, counters);
    if (!previous || counters.timestamp <= previous.timestamp) return undefined;
    const received = counters.packetsReceived - previous.packetsReceived;
    const lost = Math.max(0, counters.packetsLost - previous.packetsLost);
    const frames = counters.framesDecoded - previous.framesDecoded;
    // A counter that moves backwards means the receiver was replaced.
    if (received < 0 || frames < 0) return undefined;
    return {
      lossFraction: received + lost > 0 ? lost / (received + lost) : undefined,
      framesPerSecond: (frames * 1000) / (counters.timestamp - previous.timestamp),
      newFreezes: Math.max(0, counters.freezeCount - previous.freezeCount),
      freezeSeconds: Math.max(0, counters.freezeSeconds - previous.freezeSeconds),
    };
  }

  forget(trackId: string): void {
    this.#previous.delete(trackId);
  }
}

function inboundCounters(row: ViewerStatsRow): InboundCounters | undefined {
  const { timestamp, packetsReceived, packetsLost, framesDecoded } = row;
  if (timestamp === undefined || packetsReceived === undefined || packetsLost === undefined || framesDecoded === undefined) return undefined;
  return { timestamp, packetsReceived, packetsLost, framesDecoded, freezeCount: row.freezeCount ?? 0, freezeSeconds: row.totalFreezesDuration ?? 0 };
}

export type ViewerLayerCamera = { readonly publicationId: string; readonly track: MediaStreamTrack };
export type ViewerLayerChange = ViewerLayerCamera & { readonly layer: ViewerLayer };

// The SFU rejects a switch for a publisher with one layer (Firefox) while its
// video keeps flowing, so a rejected camera is retried ever more rarely.
const RETRY_AFTER_FAILED_SWITCH_MS = 5000;
const MAX_RETRY_DELAY_MS = 60_000;

type CameraView = { readonly policy: ViewerLayerPolicy; track: MediaStreamTrack; applied: ViewerLayer; retryAt: number; failures: number };

/** One per peer connection: owns a policy for each remote camera and reports the switches still to apply. */
export class ViewerLayerSelector {
  readonly #views = new Map<string, CameraView>();
  readonly #reader = new ViewerStatsReader();

  sample(now: number, report: RTCStatsReport, cameras: readonly ViewerLayerCamera[]): readonly ViewerLayerChange[] {
    const rows = [...report.values()] as ViewerStatsRow[];
    const active = new Set(cameras.map((camera) => camera.publicationId));
    for (const [publicationId, view] of this.#views) {
      if (!active.has(publicationId)) {
        this.#reader.forget(view.track.id);
        this.#views.delete(publicationId);
      }
    }
    const changes: ViewerLayerChange[] = [];
    for (const camera of cameras) {
      const view = this.#view(camera);
      const stats = this.#reader.read(rows, camera.track.id);
      if (!stats) continue;
      // Do not learn from l until the switch actually reached the receiver.
      const layer = view.policy.layer === view.applied ? view.policy.sample({ ...stats, tileHeight: videoRenderSize(camera.track)?.height }) : view.policy.layer;
      if (layer !== view.applied && now >= view.retryAt) changes.push({ ...camera, layer });
    }
    return changes;
  }

  applied({ publicationId, track, layer }: ViewerLayerChange): void {
    const view = this.#views.get(publicationId);
    if (!view || view.track !== track) return;
    view.applied = layer;
    view.failures = 0;
  }

  failed({ publicationId, track }: ViewerLayerChange, now: number): void {
    const view = this.#views.get(publicationId);
    if (!view || view.track !== track) return;
    view.retryAt = now + Math.min(MAX_RETRY_DELAY_MS, RETRY_AFTER_FAILED_SWITCH_MS * 2 ** view.failures);
    view.failures++;
  }

  // A re-pull of the same publication gives a new receiver, and the SFU starts it on h.
  #view({ publicationId, track }: ViewerLayerCamera): CameraView {
    let view = this.#views.get(publicationId);
    if (!view) {
      view = { policy: new ViewerLayerPolicy(), track, applied: "h", retryAt: 0, failures: 0 };
      this.#views.set(publicationId, view);
    } else if (view.track !== track) {
      this.#reader.forget(view.track.id);
      Object.assign(view, { track, applied: "h", retryAt: 0, failures: 0 });
    }
    return view;
  }
}
