import { describe, expect, it } from "vitest";

import { ClassicVolumeSlider } from "./ClassicVolumeSlider";

describe("ClassicVolumeSlider", () => {
  it("exports the classic renderer", () => {
    expect(ClassicVolumeSlider).toBeDefined();
  });
});
