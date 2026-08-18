import { describe, expect, it } from "vitest";

import { ClassicWaveform } from "./ClassicWaveform";

describe("ClassicWaveform", () => {
  it("exports the classic renderer", () => {
    expect(ClassicWaveform).toBeDefined();
  });
});
