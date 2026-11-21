import { useEffect, useRef, useState } from "react";

import { GitHubMark } from "./GitHubMark";
import { Icon } from "./Icon";
import { DASHBOARD_HREF, GITHUB_URL, SIGN_IN_HREF, START_CALL_HREF } from "./links";
import { Lockup } from "./Lockup";
import { ThemeButton } from "./theme";

/**
 * The site's top bar: the lockup, three links, the theme switch and both ways in.
 * On a page with its own Start a call (`pageCta`), the bar's Start a call stays a ghost pill while the page's button is on screen, so the viewport has one primary action.
 */
export function SiteNav({ pageCta = false }: { readonly pageCta?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const ctaInView = usePageCtaInView(pageCta);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  return (
    <header className="nav">
      <div className="ctn">
        <a href="/" aria-label="Chalk home">
          <Lockup />
        </a>
        <nav className="nl" aria-label="Site">
          <a href="/#product">Product</a>
          <a href="/docs">Docs</a>
          <a href={GITHUB_URL}>
            <GitHubMark />
            GitHub
          </a>
        </nav>
        <div className="nr">
          <ThemeButton />
          <a className="btn gh when-wide when-signed-out" href={SIGN_IN_HREF}>
            Sign in
          </a>
          <a className="btn gh when-wide when-signed-in" href={DASHBOARD_HREF}>
            Dashboard
          </a>
          <a className="btn pri nav-start" data-quiet={ctaInView || undefined} href={START_CALL_HREF}>
            Start a call
          </a>
          <button ref={menuButton} type="button" className="ib nav-menu" aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((open) => !open)}>
            <Icon name={menuOpen ? "x" : "menu"} />
          </button>
        </div>
      </div>
      {menuOpen ? <NavSheet onProduct={() => setMenuOpen(false)} /> : null}
    </header>
  );
}

function NavSheet({ onProduct }: { readonly onProduct: () => void }) {
  return (
    <nav className="navsheet" id="site-menu" aria-label="Site">
      <a href="/#product" onClick={onProduct}>
        Product
      </a>
      <a href="/docs">Docs</a>
      <a href={GITHUB_URL}>GitHub</a>
      <a className="when-signed-out" href={SIGN_IN_HREF}>
        Sign in
      </a>
      <a className="when-signed-in" href={DASHBOARD_HREF}>
        Dashboard
      </a>
    </nav>
  );
}

/** Whether any of the page's own Start a call buttons (`[data-call-cta]`) is on screen below the bar. */
function usePageCtaInView(enabled: boolean): boolean {
  const [inView, setInView] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    const targets = [...document.querySelectorAll("[data-call-cta]")];
    if (!targets.length || typeof IntersectionObserver === "undefined") {
      setInView(false);
      return;
    }
    const visible = new Set<Element>();
    // The bar covers the top 72px, so a button under it counts as off screen.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        setInView(visible.size > 0);
      },
      { rootMargin: "-72px 0px 0px 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);
  return inView;
}
