import { describe, expect, it } from "vitest";
import type { MediaPlaneResult } from "./plane";

describe("media plane contract", () => {
  it("keeps outcomes explicit", () => {
    const result: MediaPlaneResult = { outcome: "confirmed", errorCode: null };
    expect(result.outcome).toBe("confirmed");
  });
});
