import type { DocsPage } from "./manifest";
import { SITE_ORIGIN, SOCIAL_IMAGE_URL } from "../lib/site-head";

export function docsPageHead(page: DocsPage) {
  const title = `${page.title} | Chalk Docs`;
  const canonicalUrl = `${SITE_ORIGIN}${page.href}`;

  return {
    meta: [
      { title },
      { name: "description", content: page.description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Chalk" },
      { property: "og:title", content: title },
      { property: "og:description", content: page.description },
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: SOCIAL_IMAGE_URL },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: page.description },
      { name: "twitter:image", content: SOCIAL_IMAGE_URL },
    ],
    links: [{ rel: "canonical", href: canonicalUrl }],
  };
}

export function docsNotFoundHead() {
  return {
    meta: [{ title: "Page not found | Chalk Docs" }, { name: "description", content: "The Chalk docs page you requested does not exist." }, { name: "robots", content: "noindex" }],
  };
}
