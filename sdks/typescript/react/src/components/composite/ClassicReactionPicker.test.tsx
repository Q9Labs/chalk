import { describe, expect, it } from "vitest";

import { ClassicReactionPicker } from "./ClassicReactionPicker";

describe("ClassicReactionPicker", () => {
  it("exports the classic renderer", () => {
    expect(ClassicReactionPicker).toBeDefined();
  });
});
