import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";

import { Icon } from "./Icon";
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
      { href: "/sdk-preview", label: "SDK preview" },
      { href: "#self-host", label: "Self-host" },
      { href: "/status", label: "Status" },
    ],
  },
  {
    id: "account",
    title: "Account",
    links: [
      { href: "/sign-up", label: "Create an account" },
      { href: "/sign-in", label: "Sign in" },
      { href: "/home", label: "Dashboard" },
    ],
  },
] as const;

export function Closing() {
  return (
    <>
      <section className="closing">
        <Illustration className="closing-illustration" src="/images/landing/chalk-flow-closing-20260818.webp" width={1774} height={887} priority />
        <div className="container closing-content">
          <div className="closing-copy">
            <h2>
              Give every conversation <span className="muted">a place to live.</span>
            </h2>
            <p>Create a Space in about a minute. Bring your own infrastructure whenever you are ready.</p>
            <div className="closing-actions">
              <a href="/sign-up" className="btn btn-primary btn-lg">
                Create an account
                <Icon glyph={ArrowRight02Icon} size={17} weight={2.2} />
              </a>
              <a href="/sdk-preview" className="btn btn-secondary btn-lg">
                Explore the SDK
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <Illustration className="footer-illustration" src="/images/landing/chalk-flow-closing-20260818.webp" width={1774} height={887} priority />
        <div className="container">
          <div className="footer-top">
            <div className="footer-brand">
              <a href="/" className="footer-logo" aria-label="Chalk home">
                <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
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
