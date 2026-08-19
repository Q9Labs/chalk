import { describe, expect, it } from "vitest";

import { buildPublicSiteHead, SOCIAL_IMAGE_URL } from "./site-head";

describe("public site head", () => {
  it("builds an absolute canonical URL and complete social preview metadata", () => {
    const head = buildPublicSiteHead({
      path: "/status",
      title: "Status | Chalk",
      description: "Live Chalk service status.",
      imageAlt: "Chalk status preview",
    });

    expect(head.links).toEqual([{ rel: "canonical", href: "https://chalkmeet.com/status" }]);
    expect(head.meta).toContainEqual({ property: "og:image", content: SOCIAL_IMAGE_URL });
    expect(head.meta).toContainEqual({ property: "og:image:width", content: "1200" });
    expect(head.meta).toContainEqual({ property: "og:image:height", content: "630" });
    expect(head.meta).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(head.meta).toContainEqual({ name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" });
  });
});
