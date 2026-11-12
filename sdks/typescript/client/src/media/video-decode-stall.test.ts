import { describe, expect, it } from "vitest";
import { decodedFrames, VIDEO_DECODE_STALL_MS, VideoDecodeStallDetector } from "./video-decode-stall";

const video = (framesDecoded: number, trackId = "t1") => ({ publicationId: "p1", trackId, framesDecoded });

describe("VideoDecodeStallDetector", () => {
  it("reports one stall when decoded frames stop growing, then arms again after decoding resumes", () => {
    const detector = new VideoDecodeStallDetector();
    let now = 0;
    detector.sample(now, [video(10)]);
    for (now = 1000; now < VIDEO_DECODE_STALL_MS; now += 1000) expect(detector.sample(now, [video(10)])).toEqual([]);
    expect(detector.sample(VIDEO_DECODE_STALL_MS, [video(10)])).toEqual([{ publicationId: "p1", stalledMs: VIDEO_DECODE_STALL_MS }]);
    expect(detector.sample(VIDEO_DECODE_STALL_MS + 1000, [video(10)])).toEqual([]);
    const resumedAt = VIDEO_DECODE_STALL_MS + 2000;
    detector.sample(resumedAt, [video(11)]);
    for (let elapsed = 1000; elapsed < VIDEO_DECODE_STALL_MS; elapsed += 1000) detector.sample(resumedAt + elapsed, [video(11)]);
    expect(detector.sample(resumedAt + VIDEO_DECODE_STALL_MS, [video(11)]).length).toBe(1);
  });

  it("counts a video only while it is passed in, so a hidden tile starts over when it returns", () => {
    const detector = new VideoDecodeStallDetector();
    detector.sample(0, [video(10)]);
    detector.sample(1000, []);
    detector.sample(2000, [video(10)]);
    for (let elapsed = 1000; elapsed < VIDEO_DECODE_STALL_MS - 1000; elapsed += 1000) detector.sample(2000 + elapsed, [video(10)]);
    expect(detector.sample(2000 + VIDEO_DECODE_STALL_MS - 1000, [video(10)])).toEqual([]);
  });

  it("starts over on a new track and after a gap between samples", () => {
    const detector = new VideoDecodeStallDetector();
    detector.sample(0, [video(10)]);
    for (let now = 1000; now < VIDEO_DECODE_STALL_MS; now += 1000) detector.sample(now, [video(10)]);
    expect(detector.sample(VIDEO_DECODE_STALL_MS, [video(10, "t2")])).toEqual([]);
    detector.sample(VIDEO_DECODE_STALL_MS + 1000, [video(10, "t2")]);
    expect(detector.sample(VIDEO_DECODE_STALL_MS + 20_000, [video(10, "t2")])).toEqual([]);
  });
});

describe("decodedFrames", () => {
  it("reads frames decoded of inbound video only", () => {
    const rows = [
      { type: "inbound-rtp", kind: "video", trackIdentifier: "v", framesDecoded: 4 },
      { type: "inbound-rtp", kind: "audio", trackIdentifier: "a" },
      { type: "outbound-rtp", kind: "video", trackIdentifier: "o", framesDecoded: 9 },
    ];
    const report = { forEach: (callback: (row: object) => void) => rows.forEach(callback) } as unknown as RTCStatsReport;
    expect([...decodedFrames(report)]).toEqual([["v", 4]]);
  });
});
