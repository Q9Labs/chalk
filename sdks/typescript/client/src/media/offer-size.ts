// A closed receiver stays in every later offer: parked inactive (the SDK never stops a receiver) or, if something stopped it, as a rejected m-line (port 0).
// Either costs about 1.2 KB for audio and 5 KB for video in Chromium. The Chalk SFU refuses an offer over 256 KiB.

import type { MediaPublicationSource } from "./plane";

/** An offer this large starts the soft replacement path when enough closed sections have accumulated. */
const OFFER_BYTES_TRIGGER = 160 * 1024;
/** Projected offers above this budget replace without waiting for the cooldown, leaving room below the node's cap. */
const OFFER_BYTES_BUDGET = 176 * 1024;
/** From here the next pull or publish can pass the node's 256 KiB cap, so a smaller amount of closed sections is worth reclaiming. */
const OFFER_BYTES_CEILING = 224 * 1024;
/** From here an offer is close to the node's refusal, so the replacement cooldown does not hold the replacement back. */
const OFFER_BYTES_HARD_LIMIT = 240 * 1024;
/** At or above the ceiling, closed sections must still hold this much, so the fresh connection is clearly smaller. */
const OFFER_CLOSED_BYTES_NEAR_CAP = 4 * 1024;
/** The soft path needs this much in closed sections. A replacement resets them to zero, so live sections cannot cause a replacement loop. */
const OFFER_CLOSED_BYTES_MIN = 8 * 1024;

export interface OfferSize {
  readonly bytes: number;
  readonly reclaimableBytes: number;
}

export function expectedOfferAddition(tracks: readonly { readonly source: MediaPublicationSource }[]): number {
  return tracks.reduce((bytes, { source }) => bytes + (source === "microphone" || source === "screen_audio" ? 1200 : 5200), 0);
}

export function measureOffer(sdp: string): OfferSize {
  const reclaimableBytes = sdp
    .split(/(?=^m=)/m)
    .filter((section) => /^m=\w+ 0 /.test(section) || /\r?\na=inactive\r?\n/.test(section))
    .reduce((total, section) => total + section.length, 0);
  return { bytes: sdp.length, reclaimableBytes };
}

/** True when closed sections are worth replacing the connection for. Live sections never count, because a fresh connection keeps them. */
export function shouldReplaceForOfferSize({ bytes, reclaimableBytes }: OfferSize, { additionalBytes = 0, coolingDown = false }: { readonly additionalBytes?: number; readonly coolingDown?: boolean } = {}): boolean {
  if (bytes + additionalBytes > OFFER_BYTES_BUDGET && (reclaimableBytes >= OFFER_CLOSED_BYTES_NEAR_CAP || (additionalBytes > 0 && reclaimableBytes >= additionalBytes))) return true;
  if (bytes < OFFER_BYTES_TRIGGER || (coolingDown && bytes < OFFER_BYTES_HARD_LIMIT)) return false;
  return reclaimableBytes >= (bytes >= OFFER_BYTES_CEILING ? OFFER_CLOSED_BYTES_NEAR_CAP : OFFER_CLOSED_BYTES_MIN);
}
