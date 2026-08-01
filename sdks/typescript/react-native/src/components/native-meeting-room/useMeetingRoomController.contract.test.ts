import { describe, expect, it } from "vitest";

import type { MeetingRoomControllerContractCheck } from "./useMeetingRoomController.contract";

describe("useMeetingRoomController contract", () => {
  it("keeps the bidirectional return-shape assertion compiled", () => {
    const contractCheck: MeetingRoomControllerContractCheck = true;
    expect(contractCheck).toBe(true);
  });
});
