import { describe, expect, it } from "vitest";
import { summarizeRtcStats } from "./rtc";

describe("summarizeRtcStats", () => {
  it("aggregates WebRTC counters without retaining raw reports", () => {
    expect(summarizeRtcStats([{ type: "inbound-rtp", bytesReceived: 50, packetsLost: 2, jitter: 0.006 }])).toMatchObject({ bytesReceived: 50, inboundStreams: 1, jitterMs: 6, packetsLost: 2 });
  });
});
