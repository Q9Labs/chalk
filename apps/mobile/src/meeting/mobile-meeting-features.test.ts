import { describe, expect, it } from "vitest";
import { MOBILE_MEETING_FEATURES } from "./mobile-meeting-features";

describe("mobile meeting features", () => {
  it("opts into the canonical V2 room and collaboration surface", () => {
    expect(MOBILE_MEETING_FEATURES).toEqual({
      chat: true,
      participants: true,
      screenShare: true,
      reactions: true,
      handRaise: true,
      whiteboard: true,
    });
  });
});
