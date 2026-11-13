// The Chalk SFU node refuses a client offer over 64 KiB. A browser keeps every m-section it ever had in every later offer: one a
// receiver closed stays as an inactive section, and a stopped one as a rejected section (port 0). The Chalk SFU numbers each pull after
// its highest MID, so a long call piles these up until every publish fails. Measured in Chromium, a closed audio section costs about
// 1.1 KB and a closed video section 1.1 to 4.3 KB, so the limit holds roughly 15 to 60 of them.

/** The offer is replaced before it reaches this size, which leaves room under the node's 64 KiB for the sections one publish adds. */
export const OFFER_REPLACE_BYTES = 48 << 10;
/** A replacement must free at least this much, or a call whose live sections fill the offer would be rebuilt on every publish. */
export const OFFER_RECLAIMABLE_BYTES = 8 << 10;

/** Whether a fresh connection would shrink this offer enough to be worth the rebuild. */
export function offerNeedsFreshConnection(sdp: string): boolean {
  if (sdp.length < OFFER_REPLACE_BYTES) return false;
  return closedSectionBytes(sdp) >= OFFER_RECLAIMABLE_BYTES;
}

/** The bytes of the sections that carry no media: rejected (port 0) or inactive. A fresh connection offers none of them. */
export function closedSectionBytes(sdp: string): number {
  const sections = sdp.split("\r\nm=").slice(1);
  let bytes = 0;
  for (const section of sections) {
    const closed = /^\S+ 0 /.test(section) || section.includes("\r\na=inactive");
    if (closed) bytes += section.length + "\r\nm=".length;
  }
  return bytes;
}
