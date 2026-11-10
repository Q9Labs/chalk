// A closed receiver stays in every later offer: parked inactive (the SDK never stops a receiver) or, if something stopped it, as a rejected m-line (port 0).
// Either costs about 1.2 KB for audio and 5 KB for video in Chromium. The SFU numbers each pull past the last mid, so the slot is not reused, and the Chalk SFU refuses an offer over 64 KiB.

/** An offer this large starts the replacement of the connection. It leaves room for the sections one publish or pull adds. */
export const OFFER_BYTES_TRIGGER = 40 * 1024;
/** From here the next pull or publish can pass the node's 64 KiB cap, so a smaller amount of closed sections is worth reclaiming. */
export const OFFER_BYTES_CEILING = 56 * 1024;
/** From here an offer is close to the node's refusal, so the replacement cooldown does not hold the replacement back. */
export const OFFER_BYTES_HARD_LIMIT = 60 * 1024;
/** At or above the ceiling, closed sections must still hold this much, so the fresh connection is clearly smaller. */
export const OFFER_CLOSED_BYTES_NEAR_CAP = 4 * 1024;
/** Below the ceiling, closed sections must hold at least this much of the offer. A replacement resets them to zero, so it cannot repeat until pulls or publishes close this much again. */
export const OFFER_CLOSED_BYTES_MIN = 8 * 1024;

export interface OfferSize {
  readonly bytes: number;
  readonly reclaimableBytes: number;
}

export function measureOffer(sdp: string): OfferSize {
  const reclaimableBytes = sdp
    .split(/(?=^m=)/m)
    .filter((section) => /^m=\w+ 0 /.test(section) || /\r?\na=inactive\r?\n/.test(section))
    .reduce((total, section) => total + section.length, 0);
  return { bytes: sdp.length, reclaimableBytes };
}

/** True when closed sections are worth replacing the connection for. Live sections never count, because a fresh connection keeps them. */
export function shouldReplaceForOfferSize({ bytes, reclaimableBytes }: OfferSize): boolean {
  if (bytes < OFFER_BYTES_TRIGGER) return false;
  return reclaimableBytes >= (bytes >= OFFER_BYTES_CEILING ? OFFER_CLOSED_BYTES_NEAR_CAP : OFFER_CLOSED_BYTES_MIN);
}
