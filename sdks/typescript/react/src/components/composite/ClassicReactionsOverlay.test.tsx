import { describe, expect, it } from "vitest";

import { ClassicReactionsOverlay } from "./ClassicReactionsOverlay";

describe("ClassicReactionsOverlay", () => {
  it("exports the classic renderer", () => {
    expect(ClassicReactionsOverlay).toBeDefined();
  });
});
