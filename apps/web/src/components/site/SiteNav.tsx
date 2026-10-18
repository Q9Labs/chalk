import { useEffect, useState } from "react";

import { GitHubMark } from "./GitHubMark";
import { Icon } from "./Icon";
import { GITHUB_URL, SIGN_IN_HREF, START_CALL_HREF } from "./links";
import { Lockup } from "./Lockup";
import { ThemeButton } from "./theme";

/** The site's top bar: the lockup, three links, the theme switch and both ways in. */
export function SiteNav() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);
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
          <a className="btn gh when-wide" href={SIGN_IN_HREF}>
            Sign in
          </a>
          <a className="btn pri" href={START_CALL_HREF}>
            Start a call
          </a>
          <button type="button" className="ib nav-menu" aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((open) => !open)}>
            <Icon name={menuOpen ? "x" : "menu"} />
          </button>
        </div>
      </div>
      {menuOpen ? (
        <nav className="navsheet" id="site-menu" aria-label="Site">
          <a href="/#product" onClick={closeMenu}>
            Product
          </a>
          <a href="/docs">Docs</a>
          <a href={GITHUB_URL}>GitHub</a>
          <a href={SIGN_IN_HREF}>Sign in</a>
        </nav>
      ) : null}
    </header>
  );
}
