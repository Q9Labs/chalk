import { describe, expect, it } from "vitest";
import { SEND_STALL_WINDOW_MS, SendStallDetector, type SendSample } from "./send-stall";

const sample = (packetsSent: number, receiverReports: number, jitter: string): SendSample => ({ mid: "0", packetsSent, receiverReports, jitter });

describe("SendStallDetector", () => {
  it("flags a sender whose jitter reading freezes while packets leave and reports keep arriving", () => {
    const detector = new SendStallDetector();
    expect(detector.sample(0, [sample(0, 0, "0.003")])).toEqual([]);
    for (let second = 1; second <= 6; second++) expect(detector.sample(second * 1000, [sample(second * 50, second, "0.005")])).toEqual([]);
    expect(detector.sample(1000 + SEND_STALL_WINDOW_MS, [sample(350, 7, "0.005")])).toEqual(["0"]);
  });

  it("stays quiet while the jitter reading moves", () => {
    const detector = new SendStallDetector();
    for (let second = 0; second < 20; second++) expect(detector.sample(second * 1000, [sample(second * 50, second, `0.00${second}`)])).toEqual([]);
  });

  it("stays quiet when the sender sends nothing, as with silence", () => {
    const detector = new SendStallDetector();
    for (let second = 0; second < 20; second++) expect(detector.sample(second * 1000, [sample(165, second, "0.005")])).toEqual([]);
  });

  it("stays quiet when the SFU stops sending reports", () => {
    const detector = new SendStallDetector();
    for (let second = 0; second < 20; second++) expect(detector.sample(second * 1000, [sample(second * 50, 3, "0.005")])).toEqual([]);
  });
});
