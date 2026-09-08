import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deriveRecordingMediaSourceId, isRecordingPresentationTimelineV1, parseRecordingPresentationTimelineV1, projectRecordingPresentation } from "./index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../contract/schema/fixtures/recording-presentation-v1/${name}`, import.meta.url), "utf8"));

describe("recording_presentation.v1", () => {
  it("derives a stable length-framed media source identity", async () => {
    await expect(
      deriveRecordingMediaSourceId({
        recordingId: "00000000-0000-4000-8000-000000000001",
        participantId: "00000000-0000-4000-8000-000000000005",
        participantGeneration: 2,
        kind: "screen_share",
        trackId: "publication-track-7",
        epoch: 3,
      }),
    ).resolves.toBe("rps_0972a3f444e561d341205c80536b7725a86c5ac55ffad05905c9e8275664fa03");
  });

  it("validates the shared fixture and rejects private or unordered content", () => {
    expect(isRecordingPresentationTimelineV1(fixture("minimal-valid.json"))).toBe(true);
    expect(isRecordingPresentationTimelineV1(fixture("invalid-private-field.json"))).toBe(false);
    expect(isRecordingPresentationTimelineV1(fixture("invalid-event-order.json"))).toBe(false);
  });

  it("applies equal-time events inclusively with one deterministic clock", () => {
    const timeline = parseRecordingPresentationTimelineV1(fixture("minimal-valid.json"));

    expect(projectRecordingPresentation(timeline, 999).chat.messages).toHaveLength(0);
    expect(projectRecordingPresentation(timeline, 1000).chat.messages.map((message) => message.text)).toEqual(["Hello"]);
    expect(projectRecordingPresentation(timeline, 1999).participants[0]?.handRaised).toBe(false);
    expect(projectRecordingPresentation(timeline, 2000).participants[0]?.handRaised).toBe(true);
    expect(projectRecordingPresentation(timeline, 2000).elapsedMs).toBe(2000);
  });

  it("rejects frame times outside the authenticated duration", () => {
    const timeline = parseRecordingPresentationTimelineV1(fixture("minimal-valid.json"));
    expect(() => projectRecordingPresentation(timeline, -1)).toThrow(RangeError);
    expect(() => projectRecordingPresentation(timeline, 5001)).toThrow(RangeError);
  });
});
