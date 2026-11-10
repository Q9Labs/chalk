import type { LinkQuality } from "@q9labsai/chalk-client";
import type { ConnectionNoticeReason } from "./ConnectionNotice";

export type NoticeTier = "weak" | "poor";
export type ShownNotice = { readonly tier: NoticeTier; readonly reason?: ConnectionNoticeReason };

const RANK: Readonly<Record<NoticeTier, number>> = { weak: 1, poor: 2 };

/**
 * The chip to show for the link, or none. A dismissed chip stays hidden until the tier gets worse.
 * The caller clears `dismissed` once the link is good again, so the chip returns the next time it goes bad.
 */
export function shownNotice(link: LinkQuality | undefined, dismissed: NoticeTier | null): ShownNotice | null {
  if (link === undefined || link.tier === "good") return null;
  if (dismissed !== null && RANK[link.tier] <= RANK[dismissed]) return null;
  return link.reason === undefined ? { tier: link.tier } : { tier: link.tier, reason: link.reason };
}
