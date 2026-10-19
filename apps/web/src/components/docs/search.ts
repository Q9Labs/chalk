import { DOCS_GROUPS, DOCS_PAGES, type DocsPage } from "../../docs/manifest";
import { DOCS_SECTIONS } from "../../docs/search-index.generated";

export type DocsSearchResult = {
  readonly href: string;
  readonly title: string;
  /** The page or group the result belongs to. */
  readonly context: string;
  readonly excerpt: string;
};

type Entry = DocsSearchResult & { readonly haystack: string };

const SUGGESTED_HREFS = ["/docs#chalk-makes-live-work-durable", "/docs/quickstart#join-a-space-in-three-pieces", "/docs/quickstart#render-a-snapshot", "/docs/quickstart#leave-cleanly", "/docs/webhooks#receive-a-signed-event", "/docs/webhooks#rotate-a-signing-secret"];

const groupLabels = new Map<string, string>(DOCS_GROUPS.map((group) => [group.id, group.label]));
const pagesBySlug = new Map<string, DocsPage>(DOCS_PAGES.map((page) => [page.slug, page]));

const toEntry = (result: DocsSearchResult, ...extra: readonly string[]): Entry => ({
  ...result,
  haystack: [result.title, result.context, result.excerpt, ...extra].join(" ").toLocaleLowerCase(),
});

const pageOrder = new Map<string, number>(DOCS_PAGES.map((page, index) => [page.slug, index]));
const sectionEntries = [...DOCS_SECTIONS]
  .sort((a, b) => (pageOrder.get(a.slug) ?? 0) - (pageOrder.get(b.slug) ?? 0))
  .flatMap((section) => {
    const page = pagesBySlug.get(section.slug);
    if (!page) return [];
    return [toEntry({ href: `${page.href}#${section.anchor}`, title: section.heading, context: page.navLabel, excerpt: section.excerpt || page.description })];
  });

const pageEntries = DOCS_PAGES.map((page) => toEntry({ href: page.href, title: page.navLabel, context: groupLabels.get(page.groupId) ?? "", excerpt: page.description }, ...page.keywords));

// Sections come first, as in the design: a query usually names something inside a page.
const ENTRIES = [...sectionEntries, ...pageEntries];

const SUGGESTED_RESULTS: readonly DocsSearchResult[] = SUGGESTED_HREFS.flatMap((href) => ENTRIES.filter((entry) => entry.href === href));

/** Every word of the query must appear in the result's title, page, excerpt or keywords. */
export function searchDocs(query: string): readonly DocsSearchResult[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return SUGGESTED_RESULTS;
  return ENTRIES.filter((entry) => words.every((word) => entry.haystack.includes(word)));
}
