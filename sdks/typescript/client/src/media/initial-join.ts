import { ClockEstimator } from "../obs/clock";
import { createKernel, type Kernel } from "../obs/kernel";
import { FIELDS, type EventFields } from "../obs/registry";
import type { TelemetryOutbox } from "../telemetry/outbox";
import { initialMediaStats } from "./call-stats";

type Signal = EventFields["join.initial_signal"]["join_signal"];
type Failure = Extract<Signal, "sync_timeout" | "sync_failed" | "publish_failed" | "startup_ice_failed" | "startup_dtls_failed" | "transport_timeout" | "subscribe_timeout" | "rtp_timeout">;
type InputDisposition = "off" | "captured" | "denied" | "absent" | "unavailable";
const OBSERVED_BUDGET_MS = 30_000;
const MAX_SAMPLE_GAP_MS = 2_500;

type Peer = {
  readonly pc: RTCPeerConnection;
  sent: boolean;
  received: boolean;
  direct: boolean;
  transportExpired: boolean;
  dtlsFailed: boolean;
};

/** Each sample must belong to the live peer. Once any RTP flows, startup can no longer fail as "no media". */
export class InitialJoin {
  readonly #record: (signal: Signal) => void;
  readonly #seen = new Set<Signal>();
  #peer: Peer | undefined;
  #closed = false;
  #firstRtpAt: number | undefined;
  #publish: "undecided" | "started" | "accepted" | "skipped" = "undecided";
  #pull: "unrequested" | "requested" | "accepted" = "unrequested";
  #observed: { reason: Failure; since: number; last: number } | undefined;

  constructor(record: (signal: Signal) => void) {
    this.#record = record;
    this.signal("started");
  }

  capture(mic: InputDisposition, camera: InputDisposition): void {
    this.signal(`mic_${mic}`);
    this.signal(`camera_${camera}`);
  }

  signal(signal: Signal): void {
    if (this.#closed || this.#seen.has(signal)) return;
    this.#seen.add(signal);
    this.#record(signal);
  }

  syncEntered(): void {
    this.signal("sync_entered");
    this.#finishReady();
  }

  fail(reason: Failure): void {
    if (this.#firstRtpAt === undefined) this.signal(reason);
    this.close();
  }

  close(): void {
    this.#closed = true;
  }

  publication(state: "started" | "accepted" | "skipped"): void {
    this.#publish = state;
    this.signal(`publish_${state}`);
    this.#finishReady();
  }

  publishFailure(): Failure | undefined {
    if (this.#publish !== "started") return undefined;
    if (this.#peer?.pc.iceConnectionState === "failed") return "startup_ice_failed";
    if (this.#peer?.dtlsFailed) return "startup_dtls_failed";
    if (this.#peer?.transportExpired) return "transport_timeout";
    return "publish_failed";
  }

  noRemotePublication(pc: RTCPeerConnection): void {
    if (this.#peer?.pc !== pc || this.#pull === "unrequested") return;
    this.#pull = "unrequested";
    this.#observed = undefined;
  }

  subscribe(pc: RTCPeerConnection, state: "started" | "accepted" | "failed"): void {
    if (this.#peer?.pc !== pc || this.#closed) return;
    if (state === "accepted") this.#pull = "accepted";
    else if (state === "started" && this.#pull === "unrequested") this.#pull = "requested";
    this.signal(`subscribe_${state}`);
  }

  observing(pc: RTCPeerConnection): boolean {
    return !this.#closed && this.#peer?.pc === pc;
  }

  observePeer(pc: RTCPeerConnection): void {
    if (this.#closed) return;
    const ice = pc.iceConnectionState;
    if (this.#firstRtpAt !== undefined && (this.#peer?.pc !== pc || ice === "disconnected" || ice === "failed")) {
      this.close();
      return;
    }
    if (this.#peer?.pc !== pc) {
      this.#peer = { pc, sent: false, received: false, direct: false, transportExpired: false, dtlsFailed: false };
      this.#pull = "unrequested";
      this.#observed = undefined;
    }
    if (ice === "completed" || ice === "connected") {
      this.#peer.transportExpired = false;
      this.signal("ice_connected");
    } else if (ice === "checking" || ice === "disconnected" || ice === "failed") this.signal(`ice_${ice}`);
  }

  transportExpired(pc: RTCPeerConnection): void {
    if (this.#peer?.pc === pc && pc.iceConnectionState !== "closed") this.#peer.transportExpired = true;
  }

  sample(pc: RTCPeerConnection, report: RTCStatsReport, now: number, interrupted: boolean): void {
    const peer = this.#peer;
    if (this.#closed || !peer || pc !== peer.pc) return;
    if (this.#firstRtpAt !== undefined && now - this.#firstRtpAt > OBSERVED_BUDGET_MS) {
      this.close();
      return;
    }
    const stats = initialMediaStats(report);
    if (stats.dtls) this.signal(`dtls_${stats.dtls}`);
    peer.dtlsFailed = stats.dtls === "failed";
    if (stats.path === "direct") {
      peer.direct = true;
      this.signal("direct_selected");
    } else if (stats.path === "relay") {
      this.signal("relay_selected");
      if (peer.direct) this.signal("relay_fallback");
    }
    if (stats.sent === "flowed") {
      peer.sent = true;
      this.signal("send_rtp");
    }
    if (stats.received === "flowed") {
      peer.received = true;
      this.signal("receive_rtp");
    }
    if (peer.sent || peer.received) this.#firstRtpAt ??= now;
    this.#finishReady();
    this.#checkBudget(interrupted ? undefined : this.#noProgress(stats), now);
  }

  #finishReady(): void {
    if (!this.#seen.has("sync_entered") || !this.#peer?.received || this.#pull !== "accepted") return;
    if (this.#publish === "skipped") this.signal("listen_only");
    else if (this.#publish === "accepted" && this.#peer.sent) this.signal("ready");
    else return;
    this.close();
  }

  #noProgress(stats: ReturnType<typeof initialMediaStats>): Failure | undefined {
    const pc = this.#peer?.pc;
    const expectsMedia = this.#pull !== "unrequested" || this.#publish === "started" || this.#publish === "accepted";
    if (!pc || this.#closed || this.#firstRtpAt !== undefined || !this.#seen.has("sync_entered") || !expectsMedia) return;
    if (pc.iceConnectionState === "failed") return "startup_ice_failed";
    if (stats.dtls === "failed") return "startup_dtls_failed";
    if (pc.iceConnectionState === "checking" || stats.dtls === "connecting") return "transport_timeout";
    if (this.#pull === "requested") return "subscribe_timeout";
    if (pc.connectionState === "connected" && ((this.#publish === "accepted" && stats.sent === "zero") || (this.#pull === "accepted" && stats.received === "zero"))) return "rtp_timeout";
    return undefined;
  }

  #checkBudget(reason: Failure | undefined, now: number): void {
    if (!reason) {
      this.#observed = undefined;
      return;
    }
    const previous = this.#observed;
    if (!previous || previous.reason !== reason || now - previous.last > MAX_SAMPLE_GAP_MS) {
      this.#observed = { reason, since: now, last: now };
      return;
    }
    previous.last = now;
    if (now - previous.since >= OBSERVED_BUDGET_MS) this.fail(reason);
  }
}

function carriesKernel(telemetry: TelemetryOutbox): telemetry is TelemetryOutbox & { readonly obs: Pick<Kernel, "fact"> } {
  return "obs" in telemetry && typeof telemetry.obs === "object" && telemetry.obs !== null && "fact" in telemetry.obs && typeof telemetry.obs.fact === "function";
}

export function observeInitialJoin(telemetry: TelemetryOutbox): InitialJoin {
  const opId = globalThis.crypto.randomUUID();
  if (carriesKernel(telemetry)) {
    return new InitialJoin((signal) => telemetry.obs.fact("join.initial_signal", { join_attempt_id: opId, join_signal: signal }));
  }
  const kernel = createKernel({
    mode: "open",
    sourceId: opId,
    build: { module: "sdk", env: "local" },
    clock: new ClockEstimator({ mono: () => performance.now(), wall: Date.now }),
    // The legacy outbox owns the wire ids and sequence. Forward only the registered fact's payload.
    sink: (row) => {
      const signal = FIELDS.join_signal.values.find((value) => value === row.join_signal);
      if (row.name === "join.initial_signal" && signal) telemetry.record({ type: "initial_join", op_id: opId, join_signal: signal });
    },
  });
  return new InitialJoin((signal) => kernel.fact("join.initial_signal", { join_attempt_id: opId, join_signal: signal }));
}
