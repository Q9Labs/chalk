import { Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { DocsFooter } from "./DocsFooter";
import { DocsHeader } from "./DocsHeader";
import { DocsSidebar } from "./DocsSidebar";
import { SearchDialog } from "./SearchDialog";
import { trapDialogFocus } from "./dialog-focus";

export function DocsShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const currentSlug = docsSlugFromPath(pathname);

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isTyping = target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        if (mobileNavOpen) closeMobileNav();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMobileNav, mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const frame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!searchOpen && !mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavOpen, searchOpen]);

  return (
    <div className="docs-site">
      <DocsHeader
        menuButtonRef={menuButtonRef}
        mobileNavOpen={mobileNavOpen}
        onMenuToggle={() => {
          if (mobileNavOpen) closeMobileNav();
          else setMobileNavOpen(true);
        }}
        onSearchOpen={() => setSearchOpen(true)}
      />
      <div className="docs-content-frame">
        <DocsSidebar currentSlug={currentSlug} />
        <main className="docs-main">
          <Outlet />
        </main>
      </div>
      <DocsFooter />
      {mobileNavOpen ? (
        <div
          className="docs-mobile-navigation-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMobileNav();
          }}
        >
          <div id="docs-mobile-navigation" className="docs-mobile-navigation" role="dialog" aria-modal="true" aria-label="Documentation navigation" onKeyDown={trapDialogFocus}>
            <div className="docs-mobile-navigation-heading">
              <strong>Documentation</strong>
              <button ref={mobileCloseButtonRef} type="button" onClick={closeMobileNav}>
                Close
              </button>
            </div>
            <DocsSidebar currentSlug={currentSlug} mobile onNavigate={closeMobileNav} />
          </div>
        </div>
      ) : null}
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function docsSlugFromPath(pathname: string): string {
  const prefix = "/docs";
  if (pathname === prefix || pathname === `${prefix}/`) return "";
  return pathname.slice(`${prefix}/`.length).replace(/\/$/, "");
}
