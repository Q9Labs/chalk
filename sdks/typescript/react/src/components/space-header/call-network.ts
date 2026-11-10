import type { CallStatsSample } from "@q9labsai/chalk-client";

export type CallQuality = {
  /** Signal bars lit, 1 to 4. */
  readonly level: 1 | 2 | 3 | 4;
  readonly tone: "good" | "warn" | "bad";
  readonly word: string;
  readonly helper?: string;
};

/** One value per call-stats window, oldest first; `null` where a window measured nothing. */
export type NetworkSeries = readonly (number | null)[];

export type CallCharts = {
  readonly latency: { readonly points: NetworkSeries; readonly headline: string };
  readonly loss: { readonly points: NetworkSeries; readonly headline: string };
  readonly bandwidth: { readonly upload: NetworkSeries; readonly download: NetworkSeries; readonly headline: string };
};

export type CallNetwork = { readonly quality: CallQuality; readonly charts: CallCharts | null };

const FAIR_RTT_MS = 200;
const UNSTABLE_RTT_MS = 400;
const FAIR_LOSS_PCT = 1;
const UNSTABLE_LOSS_PCT = 5;
/** Charts need a line, so they wait for a second window. */
const MIN_CHART_SAMPLES = 2;

const lossOf = (sample: CallStatsSample): number | null => {
  const measured = [sample.send_loss_pct, sample.recv_loss_pct].filter((value): value is number => typeof value === "number");
  return measured.length ? Math.max(...measured) : null;
};
const megabits = (kbps: number | null | undefined): number | null => (typeof kbps === "number" ? kbps / 1000 : null);
const rounded = (value: number | null, digits: number): string => (value === null ? "–" : String(Number(value.toFixed(digits))));

export function connectionQuality(live: boolean, samples: readonly CallStatsSample[]): CallQuality {
  if (!live) return { level: 1, tone: "bad", word: "Reconnecting…", helper: "Lost the connection. Trying again; you don't need to rejoin." };
  const latest = samples.at(-1);
  const loss = latest ? lossOf(latest) : null;
  const rtt = latest?.rtt_ms ?? null;
  if ((loss ?? 0) >= UNSTABLE_LOSS_PCT) return { level: 2, tone: "warn", word: "Unstable", helper: `${rounded(loss, 0)}% of packets are getting lost. Audio may break up.` };
  if ((rtt ?? 0) >= UNSTABLE_RTT_MS) return { level: 2, tone: "warn", word: "Unstable", helper: "The connection is slow to respond. Audio may lag." };
  if ((loss ?? 0) >= FAIR_LOSS_PCT || (rtt ?? 0) >= FAIR_RTT_MS) return { level: 3, tone: "warn", word: "Fair" };
  return latest ? { level: 4, tone: "good", word: "Excellent" } : { level: 4, tone: "good", word: "Connected" };
}

export function callCharts(samples: readonly CallStatsSample[]): CallCharts | null {
  if (samples.length < MIN_CHART_SAMPLES) return null;
  const latest = samples.at(-1);
  if (!latest) return null;
  const upload = samples.map((sample) => megabits(sample.send_bitrate_kbps));
  const download = samples.map((sample) => megabits(sample.recv_bitrate_kbps));
  return {
    latency: { points: samples.map((sample) => sample.rtt_ms ?? null), headline: rounded(latest.rtt_ms ?? null, 0) },
    loss: { points: samples.map(lossOf), headline: rounded(lossOf(latest), 1) },
    bandwidth: { upload, download, headline: `${rounded(upload.at(-1) ?? null, 1)} / ${rounded(download.at(-1) ?? null, 1)}` },
  };
}

export function callNetwork(live: boolean, samples: readonly CallStatsSample[] = []): CallNetwork {
  return { quality: connectionQuality(live, samples), charts: callCharts(samples) };
}
