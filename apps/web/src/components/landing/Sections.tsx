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
    <section className="section product-story" id="product">
      <div className="container">
        <header className="section-head section-head-wide">
          <h2>Start with the product. Go deeper when you need to.</h2>
          <p>Use Chalk to manage and create Spaces, join a Space from an invite, or bring dependable collaboration into your own product.</p>
        </header>

        <div className="entry-list">
          <article className="entry-row entry-row-blue">
            <span className="entry-index">01</span>
            <div>
              <h3>Manage and create</h3>
              <p>Create an Account, choose a Tenant, and manage durable Spaces from the Dashboard.</p>
            </div>
            <div className="entry-row-actions">
              <a className="entry-action-primary" href="/sign-up">
                Create an Account
              </a>
              <a href="/home">Open Dashboard</a>
            </div>
          </article>
          <article className="entry-row entry-row-green">
            <span className="entry-index">02</span>
            <div>
              <h3>Join a Space</h3>
              <p>Paste an invite link to enter the current Episode as a Participant, with the Space keeping its durable context around you.</p>
            </div>
            <a href="#join-space">Paste an invite link</a>
          </article>
          <article className="entry-row entry-row-yellow">
            <span className="entry-index">03</span>
            <div>
              <h3>Build your product</h3>
              <p>When you are ready to shape every surface, use the SDK as a secondary route with the same Space and Episode model.</p>
            </div>
            <a href="/sdk-preview">Explore the SDK</a>
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
