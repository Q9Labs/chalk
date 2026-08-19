import { DOCS_GROUPS, DOCS_PAGES, type DocsPage } from "../../docs/manifest";

type DocsSidebarProps = {
  currentSlug: string;
  mobile?: boolean;
  onNavigate?: () => void;
};

export function DocsSidebar({ currentSlug, mobile = false, onNavigate }: DocsSidebarProps) {
  return (
    <aside className={mobile ? "docs-sidebar docs-sidebar-mobile" : "docs-sidebar"} aria-label="Documentation navigation">
      <div className="docs-sidebar-scroll">
        <p className="docs-sidebar-title">Documentation</p>
        {DOCS_GROUPS.map((group) => {
          const pages = DOCS_PAGES.filter((page) => page.groupId === group.id);
          if (!pages.length) return null;
          return (
            <section className="docs-sidebar-group" key={group.id}>
              <h2>{group.label}</h2>
              <nav aria-label={group.label}>
                {pages.map((page) => (
                  <SidebarLink key={page.slug} page={page} currentSlug={currentSlug} onNavigate={onNavigate} />
                ))}
              </nav>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function SidebarLink({ currentSlug, onNavigate, page }: { currentSlug: string; onNavigate?: () => void; page: DocsPage }) {
  const active = page.slug === currentSlug;
  return (
    <a className={active ? "docs-sidebar-link is-active" : "docs-sidebar-link"} href={page.href} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      {page.navLabel}
    </a>
  );
}
