/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSpaceInviteLink, clearDashboardSpaceEntry, hasDashboardSpaceEntry, spaceInviteToken, verifiedSpaceInviteLink } from "./named-space-route";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("public Space invite route", () => {
  it("reads the capability token from the hash without consuming it", () => {
    window.history.replaceState({}, "", "/space/design-lab#spaceInviteToken=cspi1.test&view=compact");

    expect(spaceInviteToken()).toBe("cspi1.test");
    expect(window.location.hash).toBe("#spaceInviteToken=cspi1.test&view=compact");
  });

  it("builds a canonical route from an opaque invite token", () => {
    expect(canonicalSpaceInviteLink("design lab", "cspi1.test")).toBe("http://localhost:3000/space/design%20lab#spaceInviteToken=cspi1.test");
  });

  it("keeps a same-origin verified invite link unchanged", () => {
    const link = "http://localhost:3000/space/design-lab#spaceInviteToken=cspi1.test";

    expect(canonicalSpaceInviteLink("design-lab", link)).toBe(link);
  });

  it("recognizes and clears the explicit account-entry marker without touching a capability", () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard&view=compact#spaceInviteToken=cspi1.test");

    expect(hasDashboardSpaceEntry()).toBe(true);
    clearDashboardSpaceEntry();

    expect(window.location.search).toBe("?view=compact");
    expect(window.location.hash).toBe("#spaceInviteToken=cspi1.test");
  });

  it("rejects an invite link from another origin", () => {
    expect(() => canonicalSpaceInviteLink("design-lab", "https://evil.example/space/design-lab#spaceInviteToken=cspi1.test")).toThrow("unexpected origin");
  });

  it("accepts the server-issued canonical invite URL", () => {
    const link = "http://localhost:3000/space/design-lab#spaceInviteToken=cspi1.created";

    expect(verifiedSpaceInviteLink("design-lab", link)).toBe(link);
  });

  it("rejects a canonical invite URL for another Space or token family", () => {
    expect(() => verifiedSpaceInviteLink("design-lab", "http://localhost:3000/space/other#spaceInviteToken=cspi1.created")).toThrow("did not match the verified Space");
    expect(() => verifiedSpaceInviteLink("design-lab", "http://localhost:3000/space/design-lab#spaceInviteToken=legacy.token")).toThrow("valid capability");
  });
});
