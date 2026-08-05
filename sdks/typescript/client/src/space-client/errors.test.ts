import { describe, expect, it } from "vitest";
import { normalizeClientError } from "./errors";

describe("SpaceClient errors", () => {
  it("uses noun.condition codes", () => {
    expect(normalizeClientError(Object.assign(new Error("expired"), { code: "access.invalid" })).code).toBe("access.invalid");
  });
});
