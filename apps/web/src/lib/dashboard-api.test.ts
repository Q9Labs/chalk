import { describe, expect, it } from "vitest";

import { publicAdmissionDecisionRequestScope } from "./dashboard-api";

describe("public admission decision request scope", () => {
  it("keeps concurrent request retry keys separate", () => {
    expect(publicAdmissionDecisionRequestScope("approve", "arrival-1")).not.toBe(publicAdmissionDecisionRequestScope("approve", "arrival-2"));
    expect(publicAdmissionDecisionRequestScope("approve", "arrival-1")).toBe(publicAdmissionDecisionRequestScope("approve", "arrival-1"));
  });
});
