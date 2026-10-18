import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { DOCS_GROUPS, findDocsPage } from "../../docs/manifest";
import { Icon } from "../site/Icon";
import { SiteRoot } from "../site/theme";
import { trapDialogFocus } from "./dialog-focus";
import { DocsHeader } from "./DocsHeader";
import { DocsSidebar } from "./DocsSidebar";
import { SearchDialog } from "./SearchDialog";

export function DocsShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuClose = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const currentSlug = docsSlugFromPath(pathname);
  const page = findDocsPage(currentSlug);
  const group = DOCS_GROUPS.find((candidate) => candidate.id === page?.groupId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable='true']");
      if ((event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
        event.preventDefault();
        setMenuOpen(false);
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const nav = sidebar.current;
    const current = nav?.querySelector<HTMLElement>("[aria-current='page']");
    if (!nav || !current || current.offsetTop + current.offsetHeight <= nav.clientHeight) return;
    nav.scrollTop = current.offsetTop - nav.clientHeight / 2;
  }, [currentSlug]);

  useEffect(() => {
    if (!menuOpen) return;
    menuClose.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!searchOpen && !menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen, searchOpen]);

  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }

  return (
    <SiteRoot>
      <DocsHeader onSearchOpen={() => setSearchOpen(true)} />
      <div className="dbar">
        <button ref={menuButton} type="button" aria-expanded={menuOpen} aria-controls="docs-menu" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
          Menu
        </button>
        {page ? (
          <span className="mu">
            {group?.label} › {page.navLabel}
          </span>
        ) : null}
      </div>
      <div className="dgrid">
        <nav ref={sidebar} className="dside" aria-label="Docs">
          <DocsSidebar currentSlug={currentSlug} />
        </nav>
        <main className="dmain">
          <Outlet />
        </main>
      </div>
      {menuOpen ? (
        <div
          className="dsheet"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMenu();
          }}
        >
          <div id="docs-menu" role="dialog" aria-modal="true" aria-label="Docs menu" onKeyDown={trapDialogFocus}>
            <button ref={menuClose} type="button" className="ib x" aria-label="Close menu" onClick={closeMenu}>
              <Icon name="x" />
            </button>
            <DocsSidebar currentSlug={currentSlug} onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      ) : null}
      {searchOpen ? <SearchDialog onClose={() => setSearchOpen(false)} /> : null}
    </SiteRoot>
  );
}

function docsSlugFromPath(pathname: string): string {
  const prefix = "/docs";
  if (pathname === prefix || pathname === `${prefix}/`) return "";
  return pathname.slice(`${prefix}/`.length).replace(/\/$/, "");
}
