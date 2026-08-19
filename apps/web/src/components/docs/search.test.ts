import { describe, expect, it } from "vitest";

import { DOCS_GROUPS, DOCS_PAGES } from "../../docs/manifest";
import { searchDocsPages } from "./search";

describe("searchDocsPages", () => {
  it("returns useful starting points for an empty query", () => {
    expect(searchDocsPages(DOCS_PAGES, DOCS_GROUPS, "")).toEqual(DOCS_PAGES.slice(0, 8));
  });

  it("matches title, group, description, and keywords", () => {
    const titleMatch = searchDocsPages(DOCS_PAGES, DOCS_GROUPS, "quickstart");
    const groupMatch = searchDocsPages(DOCS_PAGES, DOCS_GROUPS, "sdk");
    const keywordMatch = searchDocsPages(DOCS_PAGES, DOCS_GROUPS, "webhook");

    expect(titleMatch.length).toBeGreaterThan(0);
    expect(groupMatch.length).toBeGreaterThan(0);
    expect(keywordMatch.length).toBeGreaterThan(0);
  });

  it("returns no results without changing the navigation manifest", () => {
    expect(searchDocsPages(DOCS_PAGES, DOCS_GROUPS, "zzzz-no-doc-page")).toEqual([]);
    expect(DOCS_PAGES.length).toBeGreaterThan(0);
  });
});
