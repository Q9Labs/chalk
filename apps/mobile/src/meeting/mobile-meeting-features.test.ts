import { describe, expect, it } from "vitest";
import { MOBILE_MEETING_FEATURES } from "./mobile-meeting-features";

describe("mobile meeting features", () => {
  it("opts into the V2 room and collaboration surface without exposing unqualified recording or transcripts", () => {
    expect(MOBILE_MEETING_FEATURES).toEqual({
      chat: true,
      participants: true,
      transcripts: false,
      settings: true,
      screenShare: true,
      recording: false,
      reactions: true,
      handRaise: true,
      whiteboard: true,
    });
  });
});
