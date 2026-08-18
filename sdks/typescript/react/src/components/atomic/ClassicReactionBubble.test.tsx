import { describe, expect, it } from "vitest";

import { ClassicReactionBubble } from "./ClassicReactionBubble";

describe("ClassicReactionBubble", () => {
  it("exports the classic renderer", () => {
    expect(ClassicReactionBubble).toBeDefined();
  });
});
