const FEATURES = [
  { title: "Space core", body: "Space, Episode, admission, roles, and lifecycle boundaries.", tone: "green" },
  { title: "Realtime sync", body: "Durable control state, bounded recovery, and reconnect semantics.", tone: "yellow" },
  { title: "Media adapters", body: "Cloudflare web and React Native RealtimeKit adapters.", tone: "blue" },
  { title: "Whiteboard", body: "A shared React collaboration package with app rendering still in progress.", tone: "pink" },
  { title: "Recording", body: "Control-plane contracts with capture qualification still open.", tone: "blue" },
  { title: "Transcription", body: "Dispatcher and artifact flows with managed-path proof still open.", tone: "pink" },
  { title: "Webhooks", body: "Versioned events, signatures, retries, fixtures, and consumer helpers.", tone: "green" },
  { title: "Operations", body: "Local telemetry and health contracts with managed operations still open.", tone: "yellow" },
];

export function FeatureGrid() {
  return (
    <section className="section features" id="features">
      <div className="container features-layout">
        <header className="section-head">
          <h2>The parts that make a real-time product.</h2>
          <p>Chalk has substantial SDK and infrastructure coverage. Hosted-product completeness is tracked separately from the existence of a component or API.</p>
        </header>
        <div className="feature-list">
          {FEATURES.map((feature) => (
            <article className={`feature feature-${feature.tone}`} key={feature.title}>
              <div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <>
      <section className="closing">
        <div className="container closing-inner">
          <div>
            <h2>Build the Space your product needs.</h2>
            <p>Explore the current React surface and the architecture around it.</p>
          </div>
          <div className="closing-actions">
            <a href="/sdk-preview" className="btn btn-primary">
              View SDK preview
            </a>
            <a href="#sdk" className="btn btn-secondary">
              Explore the SDKs
            </a>
          </div>
        </div>
      </section>
      <footer className="footer">
        <div className="container footer-inner">
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
          <nav className="footer-links" aria-label="Footer navigation">
            <a href="#sdk">SDK</a>
            <a href="#performance">Performance</a>
            <a href="#self-host">Self-host</a>
          </nav>
          <span>© 2026 Q9 Labs · Under active development</span>
        </div>
      </footer>
    </>
  );
}
