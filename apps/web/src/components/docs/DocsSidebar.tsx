import { DOCS_GROUPS, DOCS_PAGES } from "../../docs/manifest";

export function DocsSidebar({ currentSlug, onNavigate }: { readonly currentSlug: string; readonly onNavigate?: () => void }) {
  return DOCS_GROUPS.map((group) => (
    <div className="dgrp" key={group.id}>
      <h3 id={`docs-group-${group.id}`}>{group.label}</h3>
      <ul aria-labelledby={`docs-group-${group.id}`}>
        {DOCS_PAGES.filter((page) => page.groupId === group.id).map((page) => (
          <li key={page.slug}>
            <a href={page.href} aria-current={page.slug === currentSlug ? "page" : undefined} onClick={onNavigate}>
              {page.navLabel}
            </a>
          </li>
        ))}
      </ul>
    </div>
  ));
}
