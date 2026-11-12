import { describe, expect, it } from "vitest";
import { recordingBadge, transcriptBadge } from "./lists";
import { parseLegacyListSearch } from "./search";

describe("what a row says", () => {
  it("names the video and the transcript", () => {
    expect(recordingBadge(null).label).toBe("No recording");
    expect(recordingBadge("play")).toMatchObject({ label: "Recording", tone: "plain" });
    expect(recordingBadge("preparing")).toMatchObject({ label: "Processing", icon: "spin" });
    expect(recordingBadge("preparable").label).toBe("Not prepared");
    expect(recordingBadge("retryable").tone).toBe("bad");
    expect(transcriptBadge("ready", "play")).toMatchObject({ label: "Transcript", tone: "plain" });
    expect(transcriptBadge("none", "preparable").label).toBe("None yet");
    expect(transcriptBadge("none", "capture_failed").label).toBe("–");
    expect(transcriptBadge("none", null).label).toBe("–");
  });
});

describe("old list links", () => {
  it("keeps a call filter and drops anything else", () => {
    expect(parseLegacyListSearch({ spaceId: "00000000-0000-4000-8000-000000000100", status: "failed", play: "x" })).toEqual({ spaceId: "00000000-0000-4000-8000-000000000100" });
    expect(parseLegacyListSearch({ spaceId: "nope" })).toEqual({ spaceId: undefined });
  });
});
