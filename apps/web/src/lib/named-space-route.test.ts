/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { consumeDashboardSpaceEntry } from "./named-space-route";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("named Space route", () => {
  it("removes a stale broker invite only from a Dashboard join", () => {
    window.history.replaceState({}, "", "/space/design-lab?entry=dashboard&layout=compact#spaceInviteToken=opaque-capability&view=compact");

    consumeDashboardSpaceEntry();

    expect(window.location.pathname).toBe("/space/design-lab");
    expect(window.location.search).toBe("?layout=compact");
    expect(window.location.hash).toBe("#view=compact");
  });

  it("keeps a public invite link unchanged", () => {
    window.history.replaceState({}, "", "/space/design-lab#spaceInviteToken=opaque-capability&view=compact");

    consumeDashboardSpaceEntry();

    expect(window.location.hash).toBe("#spaceInviteToken=opaque-capability&view=compact");
  });
});
