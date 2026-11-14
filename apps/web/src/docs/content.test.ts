import { expect, it } from "vitest";
import { DOCS_CONTENT } from "./content";
import { DOCS_PAGES } from "./manifest";

it("has one article for every docs page and a page for every article", () => {
  expect([...DOCS_CONTENT.keys()].sort()).toEqual(DOCS_PAGES.map((page) => page.slug).sort());
});
