import type { CallStatsSample } from "./call-stats";

/** How well this person's own link carries the call. Guests see it on the person's tile, and the person sees it in the header. */
export type LinkTier = "good" | "weak" | "poor";
export type LinkReason = "loss" | "latency" | "sync";
export type LinkQuality = { readonly tier: LinkTier; readonly reason?: LinkReason };

const GOOD: LinkQuality = Object.freeze({ tier: "good" });

/** A tier shows after this many windows in a row past its line, so one bad window never shows. */
const LINK_ENTER_WINDOWS = 2;
/** A tier clears after this many windows in a row under its exit line. */
const LINK_LEAVE_WINDOWS = 3;
/** Once a tier shows, it stays at least this long. */
export const LINK_MIN_SHOWN_MS = 30_000;

const WEAK_LOSS_PCT = 5;
const WEAK_RTT_MS = 400;
const WEAK_EXIT_LOSS_PCT = 2;
const WEAK_EXIT_RTT_MS = 300;
const POOR_LOSS_PCT = 15;
const POOR_RTT_MS = 800;
const POOR_FREEZE_MS = 3_000;
const POOR_EXIT_LOSS_PCT = 8;
const POOR_EXIT_RTT_MS = 600;

const RANK: Readonly<Record<LinkTier, number>> = { good: 0, weak: 1, poor: 2 };
const lower = (left: LinkTier, right: LinkTier): LinkTier => (RANK[left] <= RANK[right] ? left : right);
const higher = (left: LinkTier, right: LinkTier): LinkTier => (RANK[left] >= RANK[right] ? left : right);

export type LinkWindow = { readonly loss: number; readonly rtt: number; readonly freeze: number; readonly syncDegraded: boolean };

/** The worst loss in a window, with a window that measured nothing counting as clean. */
export function linkWindow(sample: CallStatsSample, syncDegraded: boolean): LinkWindow {
  const losses = [sample.send_loss_pct, sample.recv_loss_pct].filter((value): value is number => typeof value === "number");
  return { loss: losses.length ? Math.max(...losses) : 0, rtt: sample.rtt_ms ?? 0, freeze: sample.freeze_ms ?? 0, syncDegraded };
}

/** The tier this window earns on its own: the line a tier is entered at. */
export function enterTier(window: LinkWindow): LinkTier {
  if (window.loss >= POOR_LOSS_PCT || window.rtt >= POOR_RTT_MS || window.freeze >= POOR_FREEZE_MS) return "poor";
  if (window.loss >= WEAK_LOSS_PCT || window.rtt >= WEAK_RTT_MS || window.syncDegraded) return "weak";
  return "good";
}

/** The tier this window still holds: a tier is only left once the numbers are under its lower exit line. */
export function holdTier(window: LinkWindow): LinkTier {
  if (window.loss >= POOR_EXIT_LOSS_PCT || window.rtt >= POOR_EXIT_RTT_MS || window.freeze >= POOR_FREEZE_MS) return "poor";
  if (window.loss >= WEAK_EXIT_LOSS_PCT || window.rtt >= WEAK_EXIT_RTT_MS || window.syncDegraded) return "weak";
  return "good";
}

function reasonOf(window: LinkWindow): LinkReason | undefined {
  if (window.loss >= WEAK_EXIT_LOSS_PCT) return "loss";
  if (window.rtt >= WEAK_EXIT_RTT_MS) return "latency";
  return window.syncDegraded ? "sync" : undefined;
}

export type LinkTracker = {
  /** Feed the newest call-stats window; the same window again changes nothing. Returns the current quality. */
  readonly observe: (sample: CallStatsSample | undefined, syncDegraded: boolean) => LinkQuality;
  readonly current: () => LinkQuality;
  /** A new peer connection starts new counters and shows nothing until fresh windows say otherwise. `newest` is the window already in the history, which is not counted again. */
  readonly reset: (newest?: CallStatsSample) => void;
};

/**
 * Turns 10 s windows into a steady tier. A tier rises after 2 bad windows in a row and falls after
 * 3 clean ones, and stays up at least 30 s, so the header never flickers.
 */
export function createLinkTracker(options: { readonly now?: () => number } = {}): LinkTracker {
  const now = options.now ?? (() => Date.now());
  let quality: LinkQuality = GOOD;
  let shownAt = 0;
  let lastSeen: CallStatsSample | undefined;
  let rising: { count: number; tier: LinkTier } | null = null;
  let falling: { count: number; tier: LinkTier } | null = null;

  const set = (next: LinkQuality): void => {
    if (next.tier !== quality.tier && quality.tier === "good") shownAt = now();
    quality = next.tier === "good" ? GOOD : next;
  };

  const rise = (window: LinkWindow, entered: LinkTier): void => {
    falling = null;
    rising = { count: (rising?.count ?? 0) + 1, tier: rising ? lower(rising.tier, entered) : entered };
    if (rising.count < LINK_ENTER_WINDOWS) return;
    set({ tier: rising.tier, reason: reasonOf(window) });
    rising = null;
  };

  const fall = (window: LinkWindow, held: LinkTier): void => {
    falling = { count: (falling?.count ?? 0) + 1, tier: falling ? higher(falling.tier, held) : held };
    const settled = falling.count >= LINK_LEAVE_WINDOWS;
    const stayedLongEnough = falling.tier !== "good" || now() - shownAt >= LINK_MIN_SHOWN_MS;
    if (!settled || !stayedLongEnough) return;
    set({ tier: falling.tier, reason: reasonOf(window) });
    falling = null;
  };

  const step = (window: LinkWindow): void => {
    const entered = enterTier(window);
    const held = holdTier(window);
    if (RANK[entered] > RANK[quality.tier]) return rise(window, entered);
    rising = null;
    if (RANK[held] < RANK[quality.tier]) return fall(window, held);
    falling = null;
    if (quality.tier !== "good") quality = { tier: quality.tier, reason: reasonOf(window) ?? quality.reason };
  };

  return {
    observe: (sample, syncDegraded) => {
      if (sample && sample !== lastSeen) {
        lastSeen = sample;
        step(linkWindow(sample, syncDegraded));
      }
      return quality;
    },
    current: () => quality,
    reset: (newest) => {
      quality = GOOD;
      rising = null;
      falling = null;
      lastSeen = newest;
    },
  };
}
