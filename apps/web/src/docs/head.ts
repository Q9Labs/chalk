import type { DocsPage } from "./manifest";

const publicOrigin = "https://chalkmeet.com";
const socialImage = `${publicOrigin}/images/landing/chalk-flow-hero-20260818.webp`;

export function docsPageHead(page: DocsPage) {
  const title = `${page.title} | Chalk Docs`;
  const canonicalUrl = `${publicOrigin}${page.href}`;

  return {
    meta: [
      { title },
      { name: "description", content: page.description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Chalk" },
      { property: "og:title", content: title },
      { property: "og:description", content: page.description },
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: socialImage },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: page.description },
      { name: "twitter:image", content: socialImage },
    ],
    links: [{ rel: "canonical", href: canonicalUrl }],
  };
}

export function docsNotFoundHead() {
  return {
    meta: [{ title: "Page not found | Chalk Docs" }, { name: "description", content: "The Chalk docs page you requested does not exist." }, { name: "robots", content: "noindex" }],
  };
}
