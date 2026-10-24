export const SITE_ORIGIN = "https://chalkmeet.com";

// Vite exposes the build's public URL as `import.meta.env`; the docs prerender script runs under tsx, where only `process.env` has it.
const appUrl = new URL((import.meta.env ?? process.env).VITE_PUBLIC_APP_URL || SITE_ORIGIN);

/** Nightly builds keep canonical URLs on production but carry their own icons and share image. */
export const IS_NIGHTLY = appUrl.hostname.startsWith("nightly.");
export const BRAND_DIR = IS_NIGHTLY ? "/brand/chalk/nightly" : "/brand/chalk";
export const FAVICON_ICO = IS_NIGHTLY ? `${BRAND_DIR}/favicon.ico` : "/favicon.ico";
// Absolute, and on the deploy's own origin, so a nightly link never depends on production having shipped the file yet.
export const SOCIAL_IMAGE_URL = `${appUrl.origin}/images/social/chalk-og${IS_NIGHTLY ? "-nightly" : ""}-20261024.png`;

const SITE_NAME = "Chalk";

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
