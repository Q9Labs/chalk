import { describe, expect, it } from "vitest";

import type { MeasuredTalk } from "./talk-time";
import { playheadFraction, recordingSeconds, sharePercent, talkLength } from "./talk-time";

const talk: MeasuredTalk = {
  kind: "available",
  durationMs: 600_000,
  totalTalkMs: 0,
  overlapMs: 0,
  silenceMs: 0,
  bucketMs: 5000,
  recordings: [
    { id: "late", offsetMs: 120_000, transcribed: true },
    { id: "first", offsetMs: 0, transcribed: false },
  ],
  speakers: [],
};

describe("talk time words", () => {
  it("names a stretch of talking", () => {
    expect([0, 42_000, 725_000, 780_000, 3_900_000, 7_200_000].map(talkLength)).toEqual(["0 s", "42 s", "12 min 5 s", "13 min", "1 h 5 min", "2 h"]);
  });
  it("rounds shares but never shows a speaker as zero", () => {
    expect([0, 0.003, 0.616, 1].map(sharePercent)).toEqual(["0%", "<1%", "62%", "100%"]);
  });
});

describe("talk time and the player", () => {
  it("turns a point of the session into the recording's own time", () => {
    expect(recordingSeconds(talk, "late", 180_000)).toBe(60);
    expect(recordingSeconds(talk, "late", 60_000)).toBe(0);
    expect(recordingSeconds(talk, "other", 60_000)).toBeNull();
  });
  it("places the recording's clock on the session", () => {
    expect(playheadFraction(talk, "late", 60)).toBe(0.3);
    expect(playheadFraction(talk, "late", 10_000)).toBe(1);
    expect(playheadFraction(talk, "other", 0)).toBeNull();
  });
});
