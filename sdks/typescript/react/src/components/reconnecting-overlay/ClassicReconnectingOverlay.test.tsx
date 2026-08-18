import { describe, expect, it } from "vitest";

import { ClassicReconnectingOverlay } from "./ClassicReconnectingOverlay";

describe("ClassicReconnectingOverlay", () => {
  it("exports the internal renderer", () => {
    expect(ClassicReconnectingOverlay).toBeDefined();
  });
});
