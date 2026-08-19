import { describe, expect, it } from "vitest";

import { leaseSpaceId } from "../src/anonymous-space";
import type { LeaseRecord } from "../src/store";

const lease = {
  createdAt: 1,
  creatorCredentialId: "creator",
  expiresAt: 2,
  logId: "lease",
} satisfies Omit<LeaseRecord, "spaceOrigin">;

describe("anonymous Space isolation", () => {
  it("uses the Space bound to an isolated lease", () => {
    expect(leaseSpaceId({ ...lease, spaceId: "isolated-space", spaceOrigin: "isolated" }, "legacy-space")).toBe("isolated-space");
  });

  it("fails closed when an isolated lease has no Space", () => {
    expect(() => leaseSpaceId({ ...lease, spaceOrigin: "isolated" }, "legacy-space")).toThrow("The Space is not ready.");
  });

  it("keeps the shared Space fallback only for a draining legacy lease", () => {
    expect(leaseSpaceId({ ...lease, spaceOrigin: "legacy" }, "legacy-space")).toBe("legacy-space");
  });
});
