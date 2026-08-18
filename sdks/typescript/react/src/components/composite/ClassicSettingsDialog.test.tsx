import { describe, expect, it } from "vitest";

import { ClassicSettingsDialog } from "./ClassicSettingsDialog";

describe("ClassicSettingsDialog", () => {
  it("exports the classic renderer", () => {
    expect(ClassicSettingsDialog).toBeDefined();
  });
});
