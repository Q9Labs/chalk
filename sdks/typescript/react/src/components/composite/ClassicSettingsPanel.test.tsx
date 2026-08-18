import { describe, expect, it } from "vitest";

import { ClassicSettingsPanel } from "./ClassicSettingsPanel";

describe("ClassicSettingsPanel", () => {
  it("exports the classic renderer", () => {
    expect(ClassicSettingsPanel).toBeDefined();
  });
});
