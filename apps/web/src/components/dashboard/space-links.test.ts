import { describe, expect, it } from "vitest";

import { defaultSpaceHrefBuilder } from "./space-links";

describe("Dashboard Space links", () => {
  it("marks a Dashboard join so stale broker access cannot change the Space", () => {
    expect(defaultSpaceHrefBuilder({ slug: "design/lab" })).toBe("/space/design%2Flab?entry=dashboard");
  });
});
