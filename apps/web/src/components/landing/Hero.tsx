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
        <a href="/new" className="btn btn-primary">
          Start a meeting
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
          <p className="sub">Chalk is one video core with two front doors — a meeting app that works out of the box, and an SDK that drops into your product. Run it managed in our cloud, or self-host the whole thing.</p>
          <div className="hero-ctas">
            <a href="/new" className="btn btn-primary">
              Start a meeting
            </a>
            <a href="#sdk" className="btn btn-ghost">
              Embed the SDK
            </a>
          </div>
          <p className="hero-note">Guests join from a link — no account, no install.</p>
        </div>
        <div className="hero-visual">
          <div className="hero-shot">
            <span className="hero-shot-glow" aria-hidden="true" />
            <img className="hero-shot-img" src="/images/marketing/hero-2.png" width={2560} height={1476} alt="A live Chalk meeting: the host presenting to a shared room, with call controls and a recording timer." />
            <span className="hero-chip" aria-hidden="true">
              <span className="hero-chip-dot" />
              Joined in 0.8s — no install
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
