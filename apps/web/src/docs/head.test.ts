import { describe, expect, it } from "vitest";

import { docsNotFoundHead, docsPageHead } from "./head";
import { SOCIAL_IMAGE_URL } from "../lib/site-head";
import { DOCS_PAGES } from "./manifest";

describe("docs head metadata", () => {
  it("builds canonical and social metadata from the selected page", () => {
    const page = DOCS_PAGES.find((candidate) => candidate.slug === "quickstart");
    if (!page) throw new Error("Quickstart is missing from the docs manifest");

    const head = docsPageHead(page);

    expect(head.meta).toContainEqual({ title: "Quickstart | Chalk Docs" });
    expect(head.meta).toContainEqual({ name: "description", content: page.description });
    expect(head.meta).toContainEqual({ property: "og:url", content: "https://chalkmeet.com/docs/quickstart" });
    expect(head.meta).toContainEqual({ property: "og:image", content: SOCIAL_IMAGE_URL });
    expect(head.meta).toContainEqual({ name: "twitter:image", content: SOCIAL_IMAGE_URL });
    expect(head.links).toEqual([{ rel: "canonical", href: "https://chalkmeet.com/docs/quickstart" }]);
  });

  it("marks missing docs pages as noindex", () => {
    expect(docsNotFoundHead()).toEqual({
      meta: [{ title: "Page not found | Chalk Docs" }, { name: "description", content: "The Chalk docs page you requested does not exist." }, { name: "robots", content: "noindex" }],
    });
  });
});
