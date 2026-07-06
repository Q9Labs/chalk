import { Link } from "@tanstack/react-router";
import { BoardIcon, BoltIcon, RecordIcon, ScreenIcon, ShieldIcon, UsersIcon } from "./icons";

const FEATURES = [
  { icon: BoltIcon, term: "Ultra-low latency", detail: "Under 100ms round-trip, so conversation stays natural." },
  { icon: BoardIcon, term: "Live whiteboard", detail: "Draw, annotate, and solve together in real time." },
  { icon: UsersIcon, term: "Breakout rooms", detail: "Split into small groups and regroup in a tap." },
  { icon: RecordIcon, term: "Recording", detail: "Capture every lesson for students to revisit." },
  { icon: ScreenIcon, term: "Screen share", detail: "Share slides, code, or a browser tab instantly." },
  { icon: ShieldIcon, term: "Private by default", detail: "Encrypted rooms, teacher controls, no data sold." },
] as const;

const CASES = ["Lectures", "Tutoring", "Office hours", "Seminars", "Study groups", "Language classes"];

export function Minimal() {
  return (
    <div className="mn">
      <div className="mn__wrap">
        <header className="mn__bar">
          <span className="mn__brand">Chalk</span>
          <nav className="mn__nav">
            <a href="#features">Product</a>
            <Link to="/whiteboard">Whiteboard</Link>
            <Link to="/status">Status</Link>
            <Link to="/new" className="mn__cta mn__cta--sm">
              Start a meeting
            </Link>
          </nav>
        </header>
      </div>

      <section className="mn__wrap mn__hero">
        <h1 className="mn__h1">Real-time video, built for teaching.</h1>
        <p className="mn__sub">
          Chalk is fast, focused video for classes, tutoring, and office hours. Share a link and
          you're live — no downloads, no accounts.
        </p>
        <div className="mn__actions">
          <Link to="/new" className="mn__cta">
            Start a meeting
          </Link>
          <Link to="/whiteboard" className="mn__textlink">
            Open a whiteboard →
          </Link>
        </div>

        <figure className="mn__frame" aria-hidden>
          <div className="mn__frame-bar">
            <span className="mn__dots">
              <i />
              <i />
              <i />
            </span>
            <span className="mn__frame-title">Period 4 · Biology</span>
            <span className="mn__pill">
              <i className="mn__live" /> 42ms
            </span>
          </div>
          <div className="mn__tiles">
            <div className="mn__tile mn__tile--main">
              <span>Ms. Rivera</span>
            </div>
            <div className="mn__tile">
              <span>Amara</span>
            </div>
            <div className="mn__tile">
              <span>Diego</span>
            </div>
            <div className="mn__tile mn__tile--more">
              <span>+18</span>
            </div>
          </div>
        </figure>
      </section>

      <section className="mn__wrap mn__section" id="features">
        <div className="mn__sechead">
          <h2 className="mn__h2">Everything a class needs.</h2>
          <p className="mn__lead">The essentials, done well — nothing to configure, nothing in the way.</p>
        </div>
        <ul className="mn__features">
          {FEATURES.map(({ icon: Icon, term, detail }) => (
            <li className="mn__feature" key={term}>
              <Icon className="mn__ficon" />
              <strong>{term}</strong>
              <span>{detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mn__wrap">
        <div className="mn__cases">
          {CASES.map((c, i) => (
            <span key={c}>
              {c}
              {i < CASES.length - 1 && <i aria-hidden>·</i>}
            </span>
          ))}
        </div>
      </div>

      <section className="mn__wrap mn__section">
        <div className="mn__cband">
          <h2 className="mn__h2">Your next class is one click away.</h2>
          <p className="mn__lead">Open a room, share the link, start teaching.</p>
          <Link to="/new" className="mn__cta">
            Start a meeting
          </Link>
          <p className="mn__note">Free to start · Works in any browser</p>
        </div>
      </section>

      <footer className="mn__wrap mn__foot">
        <span className="mn__brand">Chalk</span>
        <nav>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/status">Status</Link>
        </nav>
        <span className="mn__copy">© {new Date().getFullYear()} Chalk</span>
      </footer>
    </div>
  );
}
