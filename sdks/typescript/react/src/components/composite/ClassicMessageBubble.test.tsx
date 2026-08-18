import { describe, expect, it } from "vitest";

import { ClassicMessageBubble } from "./ClassicMessageBubble";

describe("ClassicMessageBubble", () => {
  it("exports the classic renderer", () => {
    expect(ClassicMessageBubble).toBeDefined();
  });
});
