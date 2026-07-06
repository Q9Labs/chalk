import { Link } from "@tanstack/react-router";
import {
  ArrowIcon,
  BoardIcon,
  BoltIcon,
  CheckIcon,
  RecordIcon,
  ShieldIcon,
  UsersIcon,
} from "./icons";

const FEATURES = [
  { icon: BoardIcon, term: "Live whiteboard", detail: "Draw, annotate, and solve together on an infinite shared canvas." },
  { icon: UsersIcon, term: "Breakout rooms", detail: "Split into small groups and pull everyone back in a tap." },
  { icon: RecordIcon, term: "Recording", detail: "Capture every lesson in high fidelity for students to revisit." },
  { icon: ShieldIcon, term: "Private by default", detail: "Encrypted rooms, teacher controls, and no data sold. Ever." },
] as const;

const CANVAS_POINTS = [
  "An infinite canvas that never runs out of room",
  "Hand the pen to any student, live",
  "Every stroke appears in real time",
] as const;

const STATS = [
  { value: "42ms", label: "Median round-trip latency" },
  { value: "120+", label: "Edge locations worldwide" },
  { value: "99.99%", label: "Uptime during class hours" },
  { value: "250", label: "Students per live room" },
] as const;

const LOGOS = ["Northgate High", "Meridian College", "Bright Tutors", "Cedar Academy", "Studyhall"];

export function Landing() {
  return (
    <div className="lp">
      <div className="lp__glow" aria-hidden />

      <header className="lp__nav">
        <div className="lp__wrap lp__nav-row">
          <span className="lp__brand">
            <i className="lp__brand-dot" />
            Chalk
          </span>
          <nav className="lp__nav-links">
            <a href="#features">Product</a>
            <Link to="/whiteboard">Whiteboard</Link>
            <Link to="/status">Status</Link>
          </nav>
          <Link to="/new" className="lp__btn lp__btn--primary lp__btn--sm">
            Start a meeting
          </Link>
        </div>
      </header>

      <main>
        <section className="lp__wrap lp__hero">
          <span className="lp__badge">
            <i className="lp__pulse" />
            Ultra-low latency · under 100ms
          </span>
          <h1 className="lp__h1">
            The classroom that runs in <span className="lp__accent">real time</span>.
          </h1>
          <p className="lp__sub">
            Chalk is fast, focused video for classes, tutoring, and office hours. Share a link and
            you're live — no lag, no downloads, no accounts.
          </p>
          <div className="lp__actions">
            <Link to="/new" className="lp__btn lp__btn--primary">
              Start a meeting <ArrowIcon width={18} height={18} />
            </Link>
            <Link to="/whiteboard" className="lp__btn lp__btn--ghost">
              Open a whiteboard
            </Link>
          </div>
          <p className="lp__microtrust">Free to start · Works in any browser</p>

          <figure className="lp__mock">
            <div className="lp__mock-bar">
              <span className="lp__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="lp__mock-title">Period 4 · Biology</span>
              <span className="lp__mock-pill">
                <i className="lp__pulse" /> 42ms
              </span>
            </div>
            <div className="lp__mock-tiles">
              <div className="lp__tile lp__tile--main">
                <span className="lp__tile-name">Ms. Rivera</span>
                <span className="lp__tile-tag">Presenting</span>
              </div>
              <div className="lp__tile">
                <span className="lp__tile-name">Amara</span>
              </div>
              <div className="lp__tile">
                <span className="lp__tile-name">Diego</span>
              </div>
              <div className="lp__tile lp__tile--more">
                <span>+18</span>
              </div>
            </div>
          </figure>
        </section>

        <section className="lp__wrap lp__logos">
          <p>Trusted in classrooms, lecture halls, and study groups</p>
          <div className="lp__logos-row">
            {LOGOS.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        </section>

        <section className="lp__wrap lp__section" id="features">
          <div className="lp__sechead">
            <span className="lp__eyebrow">Features</span>
            <h2 className="lp__h2">Everything a class needs — and it stays out of the way.</h2>
            <p className="lp__lead">
              The essentials, rebuilt for real-time teaching. Nothing to configure, nothing between
              you and your students.
            </p>
          </div>

          <div className="lp__grid">
            <article className="lp__card lp__card--hero">
              <span className="lp__chip lp__chip--onDark">
                <BoltIcon />
              </span>
              <h3>Ultra-low latency</h3>
              <p>
                Under 100ms round-trip across a global edge network, so a raised hand and a “go
                ahead” land in the same beat — not a satellite call.
              </p>
            </article>

            {FEATURES.map(({ icon: Icon, term, detail }) => (
              <article className="lp__card" key={term}>
                <span className="lp__chip">
                  <Icon />
                </span>
                <h3>{term}</h3>
                <p>{detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp__wrap lp__section lp__split">
          <div className="lp__split-copy">
            <span className="lp__eyebrow">Shared canvas</span>
            <h2 className="lp__h2">Draw it out, together and live.</h2>
            <p className="lp__lead">
              Sketch a diagram and your class sees each stroke as you make it. Hand the pen to a
              student and let them show their work — no lag between the idea and the ink.
            </p>
            <ul className="lp__checks">
              {CANVAS_POINTS.map((p) => (
                <li key={p}>
                  <CheckIcon width={18} height={18} />
                  {p}
                </li>
              ))}
            </ul>
            <Link to="/whiteboard" className="lp__textlink">
              Open a whiteboard <ArrowIcon width={16} height={16} />
            </Link>
          </div>

          <figure className="lp__canvas" aria-hidden>
            <div className="lp__canvas-bar">
              <span className="lp__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="lp__mock-title">Untitled board</span>
            </div>
            <svg viewBox="0 0 320 210" className="lp__canvas-art">
              <path d="M28 150 C 70 60, 120 60, 150 130 S 230 190, 292 96" className="s-ink" />
              <path d="M40 60 h120" className="s-ink" />
              <circle cx="235" cy="150" r="26" className="s-green" />
              <path d="M222 150 l9 9 16 -18" className="s-green" />
              <rect x="30" y="90" width="60" height="34" rx="6" className="s-faint" />
            </svg>
          </figure>
        </section>

        <section className="lp__wrap lp__section lp__stats-wrap">
          <div className="lp__stats">
            {STATS.map(({ value, label }) => (
              <div className="lp__stat" key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="lp__wrap lp__quote">
          <span className="lp__quote-mark" aria-hidden>
            &ldquo;
          </span>
          <blockquote>My students stopped saying “you cut out.”</blockquote>
          <div className="lp__cite">
            <span className="lp__avatar" aria-hidden />
            <span>
              <b>Dr. Lena Park</b>
              <i>Lecturer, Meridian College</i>
            </span>
          </div>
        </section>

        <section className="lp__wrap lp__section">
          <div className="lp__cta-band">
            <h2>Start your next class in one click.</h2>
            <p>No accounts to wrangle, no installs to chase. Open a room, share the link, teach.</p>
            <Link to="/new" className="lp__btn lp__btn--white">
              Start a meeting <ArrowIcon width={18} height={18} />
            </Link>
            <p className="lp__cta-note">Free · No download · Any browser</p>
          </div>
        </section>
      </main>

      <footer className="lp__footer">
        <div className="lp__wrap lp__footer-grid">
          <div className="lp__footer-brand">
            <span className="lp__brand">
              <i className="lp__brand-dot" />
              Chalk
            </span>
            <p>Real-time video for teaching.</p>
          </div>
          <div className="lp__footer-col">
            <h4>Product</h4>
            <Link to="/new">New meeting</Link>
            <Link to="/whiteboard">Whiteboard</Link>
            <Link to="/status">Status</Link>
          </div>
          <div className="lp__footer-col">
            <h4>Legal</h4>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </div>
        <div className="lp__wrap lp__footer-base">
          <span>© {new Date().getFullYear()} Chalk</span>
        </div>
      </footer>
    </div>
  );
}
