import { Logo } from "@q9labsai/chalk-react";
import { useState } from "react";

const NAV_LINKS = [
  { href: "#product", label: "Product" },
  { href: "#spaces", label: "Spaces" },
  { href: "#speed", label: "Speed" },
  { href: "#self-host", label: "Self-host" },
  { href: "#platform", label: "Platform" },
  { href: "/docs", label: "Docs" },
] as const;

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      {open ? (
        <>
          <path d="M6 6 18 18" />
          <path d="M18 6 6 18" />
        </>
      ) : (
        <>
          <path d="M4 8h16" />
          <path d="M4 16h16" />
        </>
      )}
    </svg>
  );
}

export function SiteNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="nav" data-menu-open={menuOpen ? "true" : "false"}>
      <div className="container nav-inner">
        <a href="/" className="nav-logo" aria-label="Chalk home">
          <Logo accessibilityLabel={null} color="currentColor" height={26} variant="wordmark" />
        </a>

        <nav className="nav-links" aria-label="Product navigation">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav-actions">
          <button type="button" className="nav-menu-toggle" aria-expanded={menuOpen} aria-controls="nav-menu" onClick={() => setMenuOpen((open) => !open)}>
            <MenuIcon open={menuOpen} />
            <span className="visually-hidden">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
      </div>

      {/* Labelled apart from the desktop nav above: only one of the two is ever
          in the accessibility tree, but two landmarks sharing a name is the
          kind of thing that only stays true by accident. */}
      <nav className="nav-menu" id="nav-menu" aria-label="Site navigation" hidden={!menuOpen}>
        <div className="container nav-menu-inner">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={closeMenu}>
              {link.label}
            </a>
          ))}
          <a href="/docs/spaces-and-episodes" onClick={closeMenu}>
            Spaces and Episodes
          </a>
        </div>
      </nav>
    </header>
  );
}
