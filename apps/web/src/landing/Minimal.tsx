import { Link } from "@tanstack/react-router";

const POINTS = [
  { term: "Under 100ms", detail: "Real-time, so conversation stays natural." },
  { term: "Shared whiteboard", detail: "Draw and solve together, live." },
  { term: "Any browser", detail: "Nothing to install for you or your students." },
] as const;

export function Minimal() {
  return (
    <div className="mn">
      <div className="mn__wrap">
        <header className="mn__bar">
          <span className="mn__brand">Chalk</span>
          <nav className="mn__nav">
            <Link to="/whiteboard">Whiteboard</Link>
            <Link to="/status">Status</Link>
          </nav>
        </header>

        <main className="mn__main">
          <h1 className="mn__h1">Real-time video for teaching.</h1>
          <p className="mn__sub">
            Chalk is simple, low-latency video for classes, tutoring, and office hours — no
            downloads, no accounts, just a link.
          </p>
          <div className="mn__actions">
            <Link to="/new" className="mn__cta">
              Start a meeting
            </Link>
            <Link to="/whiteboard" className="mn__link">
              Open a whiteboard →
            </Link>
          </div>

          <ul className="mn__points">
            {POINTS.map(({ term, detail }) => (
              <li className="mn__point" key={term}>
                <strong>{term}</strong>
                <span>{detail}</span>
              </li>
            ))}
          </ul>
        </main>

        <footer className="mn__foot">
          <span>© {new Date().getFullYear()} Chalk</span>
          <nav>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/status">Status</Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
