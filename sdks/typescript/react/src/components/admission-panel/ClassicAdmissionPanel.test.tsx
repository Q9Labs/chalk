import { describe, expect, it } from "vitest";

import { ClassicAdmissionPanel } from "./ClassicAdmissionPanel";

describe("ClassicAdmissionPanel", () => {
  it("exports the internal renderer", () => {
    expect(ClassicAdmissionPanel).toBeDefined();
  });
});
