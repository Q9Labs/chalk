import type { DocsGroup, DocsPage } from "../../docs/manifest";

export function searchDocsPages(pages: readonly DocsPage[], groups: readonly DocsGroup[], query: string): DocsPage[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return pages.slice(0, 8);

  const labels = new Map(groups.map((group) => [group.id, group.label]));
  return pages.filter((page) => {
    const groupLabel = labels.get(page.groupId) ?? "";
    const haystack = [page.title, page.description, groupLabel, ...page.keywords].join(" ").toLocaleLowerCase();
    return haystack.includes(normalized);
  });
}
