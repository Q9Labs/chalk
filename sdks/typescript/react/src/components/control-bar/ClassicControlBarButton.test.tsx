import { describe, expect, it } from "vitest";

import { ClassicControlBarButton } from "./ClassicControlBarButton";

describe("ClassicControlBarButton", () => {
  it("exports the classic renderer", () => {
    expect(ClassicControlBarButton).toBeDefined();
  });
});
