import { describe, expect, it } from "vitest";
import { normalizeClientError } from "./errors";

describe("unexpected client exceptions", () => {
  it("keeps unclassified exceptions internal and nonrecoverable", () => {
    expect(normalizeClientError(new Error("Unexpected operation failure"))).toMatchObject({ code: "client.internal_error", recoverable: false, message: "Unexpected operation failure" });
  });
});
