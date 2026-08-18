import { describe, expect, it } from "vitest";

import { ClassicAudioIndicator } from "./ClassicAudioIndicator";

describe("ClassicAudioIndicator", () => {
  it("exports the classic renderer", () => {
    expect(ClassicAudioIndicator).toBeDefined();
  });
});
