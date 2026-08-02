import { describe, expect, it } from "vitest";

import type { ConferenceViewControllerContractCheck } from "./useConferenceViewController.contract";

describe("useConferenceViewController contract", () => {
  it("keeps the bidirectional return-shape assertion compiled", () => {
    const contractCheck: ConferenceViewControllerContractCheck = true;
    expect(contractCheck).toBe(true);
  });
});
