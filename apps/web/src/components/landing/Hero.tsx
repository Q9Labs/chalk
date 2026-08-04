export function SiteNav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a href="/" className="nav-logo" aria-label="Chalk home">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
        </a>
        <nav className="nav-links" aria-label="Main navigation">
          <a href="#sdk">SDK</a>
          <a href="#performance">Performance</a>
          <a href="#self-host">Self-host</a>
          <a href="#features">Features</a>
        </nav>
        <a href="/sdk-preview" className="btn btn-primary nav-cta">
          View SDK preview
        </a>
      </div>
    </header>
  );
}

function TechnologyMark({ technology }: { technology: "typescript" | "react" | "react-native" | "cloudflare" }) {
  if (technology === "typescript") {
    return (
      <span className="hero-tech-mark hero-tech-typescript" role="img" aria-label="TypeScript">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <rect width="48" height="48" rx="6" />
          <path d="M8 22h25v5h-9v17h-6V27H8zm26 8c-3.8 0-6.4 2.1-6.4 5.2 0 3.4 2.5 4.6 5.5 5.6 2 .7 2.6 1.1 2.6 2 0 .8-.7 1.3-2.2 1.3-1.9 0-3.8-.7-5.3-1.9v4.7c1.7.8 3.7 1.2 5.7 1.2 4.2 0 6.9-2.1 6.9-5.5 0-3.2-1.9-4.6-5.4-5.8-2.1-.7-2.9-1.1-2.9-2 0-.7.7-1.2 2-1.2 1.7 0 3.4.5 4.8 1.4v-4.4a12 12 0 0 0-5.3-.6Z" />
        </svg>
      </span>
    );
  }

  if (technology === "cloudflare") {
    return (
      <span className="hero-tech-mark hero-tech-cloudflare" role="img" aria-label="Cloudflare">
        <svg viewBox="0 0 64 42" aria-hidden="true">
          <path d="M26.2 36.8h30.7c1.8 0 3.2-1.4 3.2-3.2 0-1.5-1.1-2.8-2.6-3.1a11.3 11.3 0 0 0-21-4.9 8.9 8.9 0 0 0-14.1 7.2c0 1.5.4 2.8 1 4Z" />
          <path d="M5.4 36.8h15.4a12.5 12.5 0 0 1-.7-4c0-2.2.6-4.3 1.6-6.1a9.2 9.2 0 0 0-16.3 5.8c-2 .2-3.5 1.8-3.5 3.8 0 .2 0 .3.1.5h3.4Z" />
        </svg>
      </span>
    );
  }

  const isNative = technology === "react-native";
  return (
    <span className={`hero-tech-mark hero-tech-react${isNative ? " hero-tech-react-native" : ""}`} role="img" aria-label={isNative ? "React Native" : "React"}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        {isNative ? <rect x="14" y="5" width="36" height="54" rx="7" className="hero-tech-device" /> : null}
        <circle cx="32" cy="32" r="4.5" className="hero-tech-react-core" />
        <ellipse cx="32" cy="32" rx="25" ry="9.5" />
        <ellipse cx="32" cy="32" rx="25" ry="9.5" transform="rotate(60 32 32)" />
        <ellipse cx="32" cy="32" rx="25" ry="9.5" transform="rotate(120 32 32)" />
      </svg>
    </span>
  );
}

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-inner">
        <div className="hero-copy">
          <h1>
            Real-time Spaces.
            <span className="hero-highlight">Your way.</span>
          </h1>
          <p className="hero-sub">Open-source real-time collaboration infrastructure for TypeScript, React, and React Native.</p>
          <div className="hero-ctas">
            <a href="/sdk-preview" className="btn btn-primary">
              View SDK preview
            </a>
            <a href="#sdk" className="btn btn-secondary">
              Explore the SDKs
            </a>
          </div>
        </div>

        <figure className="hero-product">
          <div className="hero-product-wash" aria-hidden="true" />
          <img src="/images/marketing/chalk-speaker-view-20260801.webp" width={1586} height={992} alt="Chalk Space interface with an active speaker, Participant filmstrip, and media controls." />
        </figure>
      </div>

      <div className="container hero-proof" aria-label="Technologies used by Chalk">
        <TechnologyMark technology="typescript" />
        <TechnologyMark technology="react" />
        <TechnologyMark technology="react-native" />
        <TechnologyMark technology="cloudflare" />
      </div>
    </section>
  );
}
