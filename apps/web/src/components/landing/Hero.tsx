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

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-inner">
        <div className="hero-copy">
          <h1>
            Video calls.
            <span className="hero-highlight">Your call.</span>
          </h1>
          <p className="hero-sub">Open-source video infrastructure for TypeScript, React, and React Native.</p>
          <div className="hero-ctas">
            <a href="/sdk-preview" className="btn btn-primary">
              View SDK preview
            </a>
            <a href="#sdk" className="btn btn-secondary">
              Explore the SDKs
            </a>
          </div>
          <p className="hero-note">The meeting core and SDK surfaces are implemented. The hosted product remains under active development.</p>
        </div>

        <figure className="hero-product">
          <div className="hero-product-wash" aria-hidden="true" />
          <img src="/images/marketing/chalk-speaker-view-20260801.webp" width={1586} height={992} alt="Chalk speaker-view meeting interface with an active speaker, participant filmstrip, and call controls." />
        </figure>
      </div>

      <div className="container hero-proof" aria-label="Supported product surfaces">
        <span>Web</span>
        <span>React</span>
        <span>React Native</span>
        <span>Open source</span>
      </div>
    </section>
  );
}
