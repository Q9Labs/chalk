/** The docs landing page lives in this file and is served at `/docs`. */
const DOCS_INDEX_FILE = "why-chalk";

export function slugOfFile(stem: string): string {
  return stem === DOCS_INDEX_FILE ? "" : stem;
}

export function hrefOfSlug(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}
