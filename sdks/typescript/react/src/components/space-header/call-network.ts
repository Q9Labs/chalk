import type { CallStatsSample, LinkQuality } from "@q9labsai/chalk-client";

export type CallQuality = {
  /** Signal bars lit, 1 to 4. */
  readonly level: 1 | 2 | 3 | 4;
  readonly tone: "good" | "warn" | "bad";
  readonly word: string;
  readonly helper?: string;
};

/** What the call menu needs to rate the connection and draw its charts. */
export type CallNetwork = {
  readonly live: boolean;
  readonly samples?: readonly CallStatsSample[];
  /** The steady tier the header chip shows. When present it decides weak and very poor, so the menu never disagrees with the chip. */
  readonly link?: LinkQuality;
};

const FAIR_RTT_MS = 200;
const UNSTABLE_RTT_MS = 400;
const FAIR_LOSS_PCT = 1;
const UNSTABLE_LOSS_PCT = 5;

export const lossOf = (sample: CallStatsSample): number | null => {
  const measured = [sample.send_loss_pct, sample.recv_loss_pct].filter((value): value is number => typeof value === "number");
  return measured.length ? Math.max(...measured) : null;
};
export const rounded = (value: number | null, digits: number): string => (value === null ? "–" : String(Number(value.toFixed(digits))));

export function connectionQuality({ live, samples = [], link }: CallNetwork): CallQuality {
  if (!live) return { level: 1, tone: "bad", word: "Reconnecting…", helper: "Lost the connection. Trying again; you don't need to rejoin." };
  const latest = samples.at(-1);
  const loss = latest ? lossOf(latest) : null;
  const rtt = latest?.rtt_ms ?? null;
  if (link?.tier === "poor") return { level: 1, tone: "bad", word: "Very poor", helper: "Video may freeze and audio may cut out. Turning off your video can help." };
  if (link?.tier === "weak") return { level: 2, tone: "warn", word: "Unstable", helper: weakHelper(link, loss) };
  if (link?.tier === "good" && ((loss ?? 0) >= UNSTABLE_LOSS_PCT || (rtt ?? 0) >= UNSTABLE_RTT_MS)) return { level: 3, tone: "warn", word: "Fair" };
  if ((loss ?? 0) >= UNSTABLE_LOSS_PCT) return { level: 2, tone: "warn", word: "Unstable", helper: `${rounded(loss, 0)}% of packets are getting lost. Audio may break up.` };
  if ((rtt ?? 0) >= UNSTABLE_RTT_MS) return { level: 2, tone: "warn", word: "Unstable", helper: "The connection is slow to respond. Audio may lag." };
  if ((loss ?? 0) >= FAIR_LOSS_PCT || (rtt ?? 0) >= FAIR_RTT_MS) return { level: 3, tone: "warn", word: "Fair" };
  return latest ? { level: 4, tone: "good", word: "Good" } : { level: 4, tone: "good", word: "Connected" };
}

function weakHelper(link: LinkQuality, loss: number | null): string {
  if (link.reason === "sync") return "Chat and reactions are slow to arrive.";
  if (link.reason === "latency") return "The connection is slow to respond. Audio may lag.";
  return loss === null ? "Packets are getting lost. Audio may break up." : `${rounded(loss, 0)}% of packets are getting lost. Audio may break up.`;
}
