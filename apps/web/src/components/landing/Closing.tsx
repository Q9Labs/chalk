import { Chalked } from "./Chalked";

const FEATURES = [
  { title: "Meeting core", body: "Room, session, admission, role, and lifecycle boundaries are implemented.", stick: "var(--chalk-green)" },
  { title: "Realtime sync", body: "Sync v3 provides durable control state, bounded recovery, and reconnect semantics.", stick: "var(--chalk-yellow)" },
  { title: "Media adapters", body: "Cloudflare web and React Native RealtimeKit adapters are implemented.", stick: "var(--chalk-blue)" },
  { title: "Whiteboard", body: "The React collaboration package ships today; web-app and native rendering remain open.", stick: "var(--chalk-pink)" },
  { title: "Recording", body: "Control-plane contracts exist; real capture and render pools are not yet qualified.", stick: "var(--chalk-blue)" },
  { title: "Transcription", body: "Dispatcher and artifact flows exist; complete managed-path proof remains open.", stick: "var(--chalk-pink)" },
  { title: "Webhooks", body: "Versioned events, signatures, retries, fixtures, and consumer helpers are implemented.", stick: "var(--chalk-green)" },
  { title: "Operations", body: "Local telemetry and health contracts exist; managed operations are not yet qualified.", stick: "var(--chalk-yellow)" },
];

export function FeatureGrid() {
  return (
    <section className="section features" id="features">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Implementation status</p>
          <h2>
            Built foundations. <Chalked>Open product work.</Chalked>
          </h2>
          <p className="lede">Chalk has substantial infrastructure and SDK coverage, but a component or API boundary does not imply a complete hosted flow.</p>
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
            <p>Explore the current React component surface and the architecture being assembled around it.</p>
            <div className="close-ctas">
              <a href="/sdk-preview" className="btn btn-light">
                View SDK preview
              </a>
              <a href="#sdk" className="btn btn-ghost" style={{ color: "#eef2ea", borderColor: "rgba(255,255,255,0.28)" }}>
                Explore the SDKs
              </a>
            </div>
          </div>
        </div>
      </section>
      <footer className="footer">
        <div className="container footer-inner">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
          <span>© 2026 Q9 Labs</span>
          <span>Under active development</span>
        </div>
      </footer>
    </>
  );
}
