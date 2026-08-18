import { describe, expect, it } from "vitest";

import { ClassicControlBar } from "./ClassicControlBar";

describe("ClassicControlBar", () => {
  it("exports the classic renderer", () => {
    expect(ClassicControlBar).toBeDefined();
  });
});
