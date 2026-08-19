export const SITE_ORIGIN = "https://chalkmeet.com";
export const SITE_NAME = "Chalk";
export const SOCIAL_IMAGE_URL = `${SITE_ORIGIN}/images/social/chalk-og-product-20260819.png`;

type PublicSiteHeadInput = {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly imageAlt: string;
};

export function buildPublicSiteHead({ path, title, description, imageAlt }: PublicSiteHeadInput) {
  const canonicalUrl = new URL(path, SITE_ORIGIN).toString();

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "en_US" },
      { property: "og:url", content: canonicalUrl },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:image", content: SOCIAL_IMAGE_URL },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: imageAlt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: SOCIAL_IMAGE_URL },
      { name: "twitter:image:alt", content: imageAlt },
    ],
    links: [{ rel: "canonical", href: canonicalUrl }],
  };
}
