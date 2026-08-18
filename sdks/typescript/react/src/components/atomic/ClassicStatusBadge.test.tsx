import { describe, expect, it } from "vitest";

import { ClassicStatusBadge } from "./ClassicStatusBadge";

describe("ClassicStatusBadge", () => {
  it("exports the classic renderer", () => {
    expect(ClassicStatusBadge).toBeDefined();
  });
});
