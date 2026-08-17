import { describe, expect, it } from "vitest";

import { resolveSpaceInviteLink } from "./invite-link";

describe("resolveSpaceInviteLink", () => {
  const origin = "https://chalk.test";

  it("accepts Space paths and preserves hash invite tokens", () => {
    expect(resolveSpaceInviteLink(" /space/design-lab#spaceInviteToken=opaque-token ", origin)).toBe("https://chalk.test/space/design-lab#spaceInviteToken=opaque-token");
    expect(resolveSpaceInviteLink("https://other.example/space/design-lab#token", origin)).toBe("https://other.example/space/design-lab#token");
  });

  it("rejects invalid paths and query-bearing links", () => {
    expect(resolveSpaceInviteLink("", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("//evil.example/space/design-lab", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/spaces/design-lab#token", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design-lab?token=secret", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("javascript:alert(1)", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design/lab#token", origin)).toBeUndefined();
  });
});
