import { Chalked } from "./Chalked";

export function SiteNav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a href="/" className="nav-logo" aria-label="Chalk home">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#sdk">SDK</a>
          <a href="#performance">Performance</a>
          <a href="#self-host">Self-host</a>
          <a href="#features">Features</a>
        </nav>
        <a href="/sdk-preview" className="btn btn-primary">
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
          <p className="eyebrow">Real-time video platform</p>
          <h1>
            Video calls. <Chalked>Your call.</Chalked>
          </h1>
          <p className="sub">Chalk is an open-source video-conferencing stack under active development: a Go control plane, durable realtime sync, Cloudflare media adapters, and TypeScript, React, and React Native SDKs.</p>
          <div className="hero-ctas">
            <a href="/sdk-preview" className="btn btn-primary">
              View SDK preview
            </a>
            <a href="#sdk" className="btn btn-ghost">
              Explore the SDKs
            </a>
          </div>
          <p className="hero-note">Core meeting infrastructure is implemented; the hosted web product is not yet complete.</p>
        </div>
        <div className="hero-visual">
          <div className="hero-shot">
            <span className="hero-shot-glow" aria-hidden="true" />
            <img className="hero-shot-img" src="/images/marketing/hero-2.png" width={2560} height={1476} alt="Chalk meeting interface concept showing a shared room and call controls." />
            <span className="hero-chip" aria-hidden="true">
              <span className="hero-chip-dot" />
              Product preview
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
