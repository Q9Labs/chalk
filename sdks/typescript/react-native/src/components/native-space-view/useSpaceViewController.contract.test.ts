import { describe, expect, it } from "vitest";

import type { SpaceViewControllerContractCheck } from "./useSpaceViewController.contract";

describe("useSpaceViewController contract", () => {
  it("keeps the bidirectional return-shape assertion compiled", () => {
    const contractCheck: SpaceViewControllerContractCheck = true;
    expect(contractCheck).toBe(true);
  });
});
