import { describe, expect, it } from "vitest";

import { ClassicNoiseSuppressionToggle } from "./ClassicNoiseSuppressionToggle";

describe("ClassicNoiseSuppressionToggle", () => {
  it("exports the classic renderer", () => {
    expect(ClassicNoiseSuppressionToggle).toBeDefined();
  });
});
