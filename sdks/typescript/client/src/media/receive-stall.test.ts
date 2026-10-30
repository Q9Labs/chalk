import { describe, expect, it } from "vitest";
import { ReceiveStallDetector, RECEIVE_STALL_WINDOW_MS } from "./receive-stall";

const track = { publicationId: "publication", trackId: "receiver", packets: 10 };
function observe(detector: ReceiveStallDetector, from = 0, until = RECEIVE_STALL_WINDOW_MS) {
  let result: readonly string[] = [];
  for (let now = from; now <= until; now += 1000) result = detector.sample(now, [track]).stalled;
  return result;
}
describe("expected receive packet progress", () => {
  it("gives a new pull a full window before declaring a stall", () => {
    const detector = new ReceiveStallDetector();
    expect(observe(detector, 0, RECEIVE_STALL_WINDOW_MS - 1000)).toEqual([]);
    expect(detector.sample(RECEIVE_STALL_WINDOW_MS, [track]).stalled).toEqual([track.publicationId]);
  });
  it("does not count elapsed time while stats sampling is throttled", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 10_000);
    expect(detector.sample(100_000, [track]).stalled).toEqual([]);
    expect(observe(detector, 101_000, 119_000)).toEqual([]);
  });
  it("starts a fresh window after a pause or a new receiver", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 19_000);
    detector.sample(20_000, []);
    expect(detector.sample(21_000, [track]).stalled).toEqual([]);
    expect(detector.sample(22_000, [{ ...track, trackId: "new-receiver" }]).stalled).toEqual([]);
  });
  it("uses packets and restarts the window on progress or a counter reset", () => {
    const detector = new ReceiveStallDetector();
    observe(detector, 0, 19_000);
    expect(detector.sample(20_000, [{ ...track, packets: 11 }]).stalled).toEqual([]);
    expect(detector.sample(21_000, [{ ...track, packets: 0 }]).stalled).toEqual([]);
  });
});
