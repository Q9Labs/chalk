import { describe, expect, it } from "vitest";

import { DOCS_GROUPS, DOCS_PAGES, findDocsPage, getAdjacentDocsPages } from "./manifest";

describe("docs manifest", () => {
  it("keeps navigation groups and page destinations unique", () => {
    expect(DOCS_GROUPS.map((group) => group.id)).toEqual(["start", "concepts", "sdks", "features", "platform", "operations"]);

    const slugs = DOCS_PAGES.map((page) => page.slug);
    const hrefs = DOCS_PAGES.map((page) => page.href);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(DOCS_PAGES.every((page) => page.href === "/docs" || page.href.startsWith("/docs/"))).toBe(true);
  });

  it("finds pages and returns neighboring navigation entries", () => {
    const quickstart = findDocsPage("quickstart");
    expect(quickstart?.title).toBe("Quickstart");
    expect(findDocsPage("missing-page")).toBeUndefined();

    const adjacent = getAdjacentDocsPages("quickstart");
    expect(adjacent.previous?.slug).toBe("");
    expect(adjacent.next?.slug).toBe("spaces-and-episodes");
    expect(getAdjacentDocsPages("missing-page")).toEqual({ previous: undefined, next: undefined });
  });
});
