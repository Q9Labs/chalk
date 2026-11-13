import { describe, expect, it } from "vitest";
import { closedSectionBytes, OFFER_RECLAIMABLE_BYTES, OFFER_REPLACE_BYTES, offerNeedsFreshConnection } from "./offer-size";

const section = (kind: "live" | "inactive" | "rejected", mid: string, padding: number) => {
  const port = kind === "rejected" ? 0 : 9;
  const direction = kind === "live" ? "recvonly" : "inactive";
  return `m=audio ${port} UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:${mid}\r\na=${direction}\r\na=padding:${"x".repeat(padding)}\r\n`;
};
const offer = (...sections: string[]) => `v=0\r\ns=-\r\nt=0 0\r\n${sections.join("")}`;

describe("closedSectionBytes", () => {
  it("counts the rejected and inactive sections and nothing else", () => {
    const live = section("live", "0", 100);
    const inactive = section("inactive", "1", 200);
    const rejected = section("rejected", "2", 300);
    expect(closedSectionBytes(offer(live, inactive, rejected))).toBe(inactive.length + rejected.length);
    expect(closedSectionBytes(offer(live))).toBe(0);
    expect(closedSectionBytes(offer())).toBe(0);
  });
});

describe("offerNeedsFreshConnection", () => {
  it("rebuilds only a large offer that closed sections made large", () => {
    const closed = (bytes: number) => section("rejected", "9", bytes);
    expect(offerNeedsFreshConnection(offer(section("live", "0", 100), closed(100)))).toBe(false);
    expect(offerNeedsFreshConnection(offer(section("live", "0", OFFER_REPLACE_BYTES), closed(OFFER_RECLAIMABLE_BYTES - 200)))).toBe(false);
    expect(offerNeedsFreshConnection(offer(section("live", "0", OFFER_REPLACE_BYTES), closed(OFFER_RECLAIMABLE_BYTES)))).toBe(true);
    expect(offerNeedsFreshConnection(offer(section("live", "0", 100), closed(OFFER_RECLAIMABLE_BYTES)))).toBe(false);
  });
});
