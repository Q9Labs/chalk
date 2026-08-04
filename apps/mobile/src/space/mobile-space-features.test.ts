import { describe, expect, it } from "vitest";

import { MOBILE_SPACE_FEATURES } from "./mobile-space-features";

describe("mobile Space features", () => {
  it("opts into the shared Space and collaboration surface", () => {
    expect(MOBILE_SPACE_FEATURES).toEqual({
      chat: true,
      handRaise: true,
      participants: true,
      reactions: true,
      screenShare: true,
      whiteboard: true,
    });
  });
});
