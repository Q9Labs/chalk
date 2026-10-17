import { Logo } from "@q9labsai/chalk-react";

import { Illustration } from "./Illustration";

const FOOTER_COLUMNS = [
  {
    id: "product",
    title: "Product",
    links: [
      { href: "#product", label: "Two ways in" },
      { href: "#spaces", label: "Spaces and Episodes" },
      { href: "#speed", label: "Speed" },
      { href: "#platform", label: "What ships today" },
    ],
  },
  {
    id: "developers",
    title: "Developers",
    links: [
      { href: "/docs", label: "Documentation" },
      { href: "/docs/quickstart", label: "SDK quickstart" },
      { href: "#self-host", label: "Self-host" },
    ],
  },
] as const;

export function Closing() {
  return (
    <>
      <footer className="footer">
        <Illustration className="footer-illustration" src="/images/landing/chalk-flow-closing-20260818.webp" width={1774} height={887} priority />
        <div className="container">
          <div className="footer-top">
            <div className="footer-brand">
              <a href="/" className="footer-logo" aria-label="Chalk home">
                <Logo accessibilityLabel={null} color="currentColor" height={28} variant="wordmark" />
              </a>
              <p className="footer-tagline">A Space that outlasts the call, for your team or for the product you are building.</p>
            </div>

            {FOOTER_COLUMNS.map((column) => (
              <nav className="footer-col" key={column.id} aria-labelledby={`footer-${column.id}`}>
                <h3 id={`footer-${column.id}`}>{column.title}</h3>
                <ul>
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <a href={link.href}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>

          <div className="footer-legal">
            <span>© 2026 Q9 Labs</span>
            <nav aria-label="Legal">
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
            </nav>
          </div>
        </div>
      </footer>
    </>
  );
}
