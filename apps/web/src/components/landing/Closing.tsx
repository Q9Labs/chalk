import { Chalked } from "./Chalked";

const FEATURES = [
  { title: "Recordings", body: "Host-controlled, durably stored, shareable by link.", stick: "var(--chalk-green)" },
  { title: "Transcription", body: "Live captions that persist, full transcripts after the call.", stick: "var(--chalk-yellow)" },
  { title: "Chat & files", body: "Durable room chat with attachments and read state.", stick: "var(--chalk-blue)" },
  { title: "Whiteboard", body: "Draw together with per-person grants and saved snapshots.", stick: "var(--chalk-pink)" },
  { title: "Lobby & roles", body: "Waiting room, capability-based roles, host succession.", stick: "var(--chalk-blue)" },
  { title: "Reactions & presence", body: "Hand raise, reactions, active speaker — all near-instant.", stick: "var(--chalk-pink)" },
  { title: "Webhooks", body: "Signed deliveries with retries and full delivery history.", stick: "var(--chalk-green)" },
  { title: "Status & diagnostics", body: "Public status page and deep client-side diagnostics.", stick: "var(--chalk-yellow)" },
];

export function FeatureGrid() {
  return (
    <section className="section features" id="features">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Batteries included</p>
          <h2>
            The whole <Chalked>meeting surface</Chalked>.
          </h2>
          <p className="lede">Everything a real meeting needs, in the app and through the SDK.</p>
        </div>
        <div className="features-grid">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title} style={{ "--f-stick": f.stick } as React.CSSProperties}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <>
      <section className="close">
        <div className="container">
          <div className="close-panel">
            <h2>
              Pick up <Chalked>Chalk</Chalked>.
            </h2>
            <p>Start a meeting in your browser right now, or put one inside your product this week. Either door leads to the same fast, durable core.</p>
            <div className="close-ctas">
              <a href="/new" className="btn btn-light">
                Start a meeting
              </a>
              <a href="#sdk" className="btn btn-ghost" style={{ color: "#eef2ea", borderColor: "rgba(255,255,255,0.28)" }}>
                Embed the SDK
              </a>
            </div>
          </div>
        </div>
      </section>
      <footer className="footer">
        <div className="container footer-inner">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
          <span>© 2026 Q9 Labs</span>
          <nav className="footer-links" aria-label="Legal">
            <a href="/status">Status</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
