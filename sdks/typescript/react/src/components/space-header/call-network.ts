import type { CallStatsSample } from "@q9labsai/chalk-client";

export type CallQuality = {
  /** Signal bars lit, 1 to 4. */
  readonly level: 1 | 2 | 3 | 4;
  readonly tone: "good" | "warn" | "bad";
  readonly word: string;
  readonly helper?: string;
};

/** What the call menu needs to rate the connection and draw its charts. */
export type CallNetwork = { readonly live: boolean; readonly samples?: readonly CallStatsSample[] };

const FAIR_RTT_MS = 200;
const UNSTABLE_RTT_MS = 400;
const FAIR_LOSS_PCT = 1;
const UNSTABLE_LOSS_PCT = 5;

export const lossOf = (sample: CallStatsSample): number | null => {
  const measured = [sample.send_loss_pct, sample.recv_loss_pct].filter((value): value is number => typeof value === "number");
  return measured.length ? Math.max(...measured) : null;
};
export const rounded = (value: number | null, digits: number): string => (value === null ? "–" : String(Number(value.toFixed(digits))));

export function connectionQuality({ live, samples = [] }: CallNetwork): CallQuality {
  if (!live) return { level: 1, tone: "bad", word: "Reconnecting…", helper: "Lost the connection. Trying again; you don't need to rejoin." };
  const latest = samples.at(-1);
  const loss = latest ? lossOf(latest) : null;
  const rtt = latest?.rtt_ms ?? null;
  if ((loss ?? 0) >= UNSTABLE_LOSS_PCT) return { level: 2, tone: "warn", word: "Unstable", helper: `${rounded(loss, 0)}% of packets are getting lost. Audio may break up.` };
  if ((rtt ?? 0) >= UNSTABLE_RTT_MS) return { level: 2, tone: "warn", word: "Unstable", helper: "The connection is slow to respond. Audio may lag." };
  if ((loss ?? 0) >= FAIR_LOSS_PCT || (rtt ?? 0) >= FAIR_RTT_MS) return { level: 3, tone: "warn", word: "Fair" };
  return latest ? { level: 4, tone: "good", word: "Excellent" } : { level: 4, tone: "good", word: "Connected" };
}
