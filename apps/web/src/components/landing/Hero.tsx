import { Chalked } from "./Chalked";
import { CameraIcon, HandIcon, LeaveIcon, MicIcon, MicOffIcon, ScreenIcon, SmileIcon } from "./icons";

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
          <p className="sub">
            Chalk is one video core with two front doors — a meeting app that works out of the box, and an SDK that
            drops into your product. Run it managed in our cloud, or self-host the whole thing.
          </p>
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
          <MeetingMock />
        </div>
      </div>
    </section>
  );
}

function MeetingMock() {
  return (
    <div className="mock" aria-hidden="true">
      <div className="mock-window">
        <div className="mock-bar">
          <span>
            <span className="mock-live" />
            chalk.new/design-crit
          </span>
          <span className="mock-rec">
            <span className="mock-rec-dot" />
            REC 24:31
          </span>
        </div>
        <div className="mock-grid">
          <div className="tile tile-green tile-speaking">
            <span className="avatar">A</span>
            <span className="tag">
              <MicIcon /> Amara
            </span>
          </div>
          <div className="tile tile-yellow">
            <span className="avatar">J</span>
            <span className="tag tag-muted">
              <MicOffIcon /> Jonas
            </span>
          </div>
          <div className="tile tile-blue">
            <span className="avatar">P</span>
            <span className="hand-badge">✋</span>
            <span className="tag">
              <MicIcon /> Priya
            </span>
          </div>
          <div className="tile tile-off">
            <span className="avatar">S</span>
            <span className="tag">
              <MicIcon /> Sam
            </span>
          </div>
        </div>
        <div className="mock-dock">
          <span className="dock-btn">
            <MicIcon />
          </span>
          <span className="dock-btn">
            <CameraIcon />
          </span>
          <span className="dock-btn">
            <ScreenIcon />
          </span>
          <span className="dock-btn">
            <HandIcon />
          </span>
          <span className="dock-btn">
            <SmileIcon />
          </span>
          <span className="dock-btn dock-btn-danger">
            <LeaveIcon />
          </span>
        </div>
      </div>
      <div className="mock-toast">✋ Priya raised a hand</div>
    </div>
  );
}
