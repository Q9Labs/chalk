import { describe, expect, it } from "vitest";

import { defaultSpaceHrefBuilder, publicSpaceHrefBuilder } from "./space-links";

describe("Dashboard Space links", () => {
  it("marks an explicit Dashboard account entry for the requested Space", () => {
    expect(defaultSpaceHrefBuilder({ slug: "design/lab" })).toBe("/space/design%2Flab?entry=dashboard");
  });

  it("preserves the server-issued public fragment", () => {
    const canonicalURL = "/space/design-lab#cspi1=opaque-capability&view=compact";
    expect(publicSpaceHrefBuilder({ canonical_url: canonicalURL })).toBe(canonicalURL);
  });

  it("does not offer a public URL before the invite is materialized", () => {
    expect(publicSpaceHrefBuilder({ canonical_url: "  " })).toBeUndefined();
  });
});
