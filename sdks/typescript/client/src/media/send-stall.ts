export const SEND_STALL_WINDOW_MS = 6000;
const MIN_PACKETS = 100;
const MIN_RECEIVER_REPORTS = 3;
const MAX_SAMPLE_GAP_MS = 3000;

export type SendSample = {
  readonly mid: string;
  readonly packetsSent: number;
  readonly receiverReports: number;
  /** The SFU's jitter reading for the stream. It changes with every report while packets arrive. */
  readonly jitter: string;
};

type Baseline = Omit<SendSample, "mid"> & { readonly at: number };

/**
 * A sender is stalled when the SFU keeps answering with receiver reports, our packets keep
 * leaving, and the SFU's jitter reading never moves. That is what a track the SFU closed looks like.
 */
export class SendStallDetector {
  readonly #baselines = new Map<string, Baseline>();
  #sampledAt: number | undefined;

  clear(): void {
    this.#baselines.clear();
    this.#sampledAt = undefined;
  }

  sample(now: number, samples: readonly SendSample[]): readonly string[] {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.#baselines.clear();
    this.#sampledAt = now;
    const stalled: string[] = [];
    const seen = new Set<string>();
    for (const sample of samples) {
      seen.add(sample.mid);
      const base = this.#baselines.get(sample.mid);
      if (!base || sample.jitter !== base.jitter || sample.packetsSent <= base.packetsSent || sample.receiverReports < base.receiverReports) {
        this.#baselines.set(sample.mid, { at: now, packetsSent: sample.packetsSent, receiverReports: sample.receiverReports, jitter: sample.jitter });
        continue;
      }
      if (now - base.at < SEND_STALL_WINDOW_MS) continue;
      if (sample.packetsSent - base.packetsSent >= MIN_PACKETS && sample.receiverReports - base.receiverReports >= MIN_RECEIVER_REPORTS) stalled.push(sample.mid);
      this.#baselines.set(sample.mid, { at: now, packetsSent: sample.packetsSent, receiverReports: sample.receiverReports, jitter: sample.jitter });
    }
    for (const mid of this.#baselines.keys()) if (!seen.has(mid)) this.#baselines.delete(mid);
    return stalled;
  }
}

/** Reads one sample per sending MID from a stats report. Streams without receiver reports are skipped. */
export function sendSamples(report: RTCStatsReport): readonly SendSample[] {
  const byMid = new Map<string, { packetsSent: number; receiverReports: number; jitter: string[] }>();
  for (const stat of report.values()) {
    if (stat.type !== "outbound-rtp" || typeof stat.mid !== "string" || typeof stat.remoteId !== "string") continue;
    const remote = report.get(stat.remoteId);
    if (!remote || remote.type !== "remote-inbound-rtp") continue;
    const entry = byMid.get(stat.mid) ?? { packetsSent: 0, receiverReports: 0, jitter: [] };
    entry.packetsSent += Number(stat.packetsSent ?? 0);
    entry.receiverReports += Number(remote.roundTripTimeMeasurements ?? 0);
    entry.jitter.push(String(remote.jitter));
    byMid.set(stat.mid, entry);
  }
  return [...byMid].map(([mid, entry]) => ({ mid, packetsSent: entry.packetsSent, receiverReports: entry.receiverReports, jitter: entry.jitter.join(",") }));
}
