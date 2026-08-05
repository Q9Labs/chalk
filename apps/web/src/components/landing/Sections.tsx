const STATS = [
  {
    num: "<1s",
    what: "Click to media",
    how: "First-frame target at p50.",
  },
  {
    num: "<100ms",
    what: "Control signal",
    how: "Sync-plane target at p95.",
  },
  {
    num: "<200ms",
    what: "Glass to glass",
    how: "Same-region media target.",
  },
];

const STACK = [
  {
    title: "Space surfaces",
    body: "React and React Native components for Entrance, Space, Participants, chat, and controls.",
    tone: "blue",
  },
  {
    title: "Portable core",
    body: "Episode, admission, roles, sync, telemetry, and provider-neutral media boundaries.",
    tone: "green",
  },
  {
    title: "Your infrastructure",
    body: "A Go control plane, durable realtime sync, Postgres authority, and your own token keys.",
    tone: "yellow",
  },
];

export function FrontDoors() {
  return (
    <section className="section product-story" id="sdk">
      <div className="container">
        <header className="section-head section-head-wide">
          <h2>One real-time core. Use it your way.</h2>
          <p>The TypeScript client owns the hard real-time boundaries. React and React Native turn that core into product-ready Space surfaces.</p>
        </header>

        <div className="entry-list">
          <article className="entry-row entry-row-blue">
            <span className="entry-index">01</span>
            <div>
              <h3>Start with the SDKs</h3>
              <p>Bring Chalk into an existing product and keep control of identity, Space creation, and the surrounding experience.</p>
            </div>
            <code>pnpm add @q9labsai/chalk-react</code>
          </article>
          <article className="entry-row entry-row-green">
            <span className="entry-index">02</span>
            <div>
              <h3>Shape the whole Space</h3>
              <p>Compose Entrance, the media stage, Participant tools, whiteboard, chat, and diagnostics without replacing the real-time core.</p>
            </div>
            {import.meta.env.DEV ? <a href="/sdk-preview">Open the component preview</a> : null}
          </article>
        </div>
      </div>
    </section>
  );
}

export function PerfBudget() {
  return (
    <section className="section performance" id="performance">
      <div className="container">
        <header className="section-head performance-head">
          <h2>Fast is a written spec.</h2>
          <p>These are engineering targets from Chalk's north-star design, not published production guarantees.</p>
        </header>
        <ul className="performance-grid">
          {STATS.map((stat) => (
            <li key={stat.what}>
              <strong>{stat.num}</strong>
              <div>
                <b>{stat.what}</b>
                <span>{stat.how}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function SelfHost() {
  return (
    <section className="section stack" id="self-host">
      <div className="container stack-layout">
        <header className="section-head">
          <h2>Keep the core. Swap the boundaries.</h2>
          <p>Chalk keeps product surfaces separate from realtime control and media providers, so infrastructure choices do not leak through every component.</p>
          <p className="stack-note">The app tier is available in source. Complete Cloudflare-free media hosting still requires a future SFU adapter.</p>
        </header>

        <ol className="stack-map">
          {STACK.map((layer, index) => (
            <li className={`stack-layer stack-layer-${layer.tone}`} key={layer.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{layer.title}</h3>
                <p>{layer.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
