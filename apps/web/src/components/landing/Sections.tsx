import { Chalked } from "./Chalked";

export function FrontDoors() {
  return (
    <section className="section doors" id="sdk">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Two front doors</p>
          <h2>
            Use it as an app. <Chalked>Ship it</Chalked> as a feature.
          </h2>
          <p className="lede">The same core powers both — nothing about the embedded experience is second-class.</p>
        </div>
        <div className="doors-grid">
          <div className="door">
            <h3>The app</h3>
            <p>
              Spin up a room, share the link, and you're meeting. Lobby, roles, recordings, transcripts, chat, and
              whiteboard are all there on day one — no setup, no downloads for guests.
            </p>
            <div className="room-pill" aria-hidden="true">
              <span>chalk.new/standup</span>
              <span className="room-copy">Copy link</span>
            </div>
            <a href="/new" className="door-link">
              Start a meeting →
            </a>
          </div>
          <div className="door door-board">
            <h3>The SDK</h3>
            <p>
              Drop a full meeting experience into your product with one component, themed to match. Identity comes from
              tokens you sign — your users never leave your app.
            </p>
            <div className="codeboard">
              <code className="codeboard-install">npm install @q9labsai/chalk-react</code>
              <pre>
                <code>
                  <span className="tok-kw">import</span> {"{ "}
                  <span className="tok-cmp">VideoConference</span>
                  {" }"} <span className="tok-kw">from</span> <span className="tok-str">"@q9labsai/chalk-react"</span>;
                  {"\n\n"}
                  <span className="tok-kw">export function</span> <span className="tok-cmp">Meet</span>
                  {"({ token }) {\n"}
                  {"  "}
                  <span className="tok-kw">return</span> {"<"}
                  <span className="tok-cmp">VideoConference</span> <span className="tok-prop">token</span>
                  {"={token} "}
                  <span className="tok-prop">theme</span>
                  {"={{ "}
                  <span className="tok-prop">accentColor</span>
                  {": "}
                  <span className="tok-str">"#3e7647"</span>
                  {" }} />;\n}"}
                </code>
              </pre>
            </div>
            <p className="tok-dim" style={{ fontSize: 13.5 }}>
              React today — Swift, Kotlin, Python, and Go are generated from the same schema, so no language is
              second-class.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

const STATS = [
  {
    num: "<1s",
    what: "Click to media flowing",
    how: "The join funnel is the money path: token check, session, ICE — first frame in under a second at p50.",
  },
  {
    num: "<100ms",
    what: "Every control signal",
    how: "Mute, hand raise, reactions, chat, active speaker — sync-plane state lands in under 100ms at p95.",
  },
  {
    num: "<200ms",
    what: "Glass to glass",
    how: "Media latency same-region, camera to screen. A newly published track renders for others in under 500ms.",
  },
];

export function PerfBudget() {
  return (
    <section className="section perf" id="performance">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Performance budget</p>
          <h2>
            Fast is a <Chalked>written spec</Chalked>, not a vibe.
          </h2>
          <p className="lede">
            Chalk is built against a performance budget with numbers attached. Designs that miss it don't ship.
          </p>
        </div>
        <div className="perf-grid">
          {STATS.map((s) => (
            <div className="perf-stat" key={s.what}>
              <div className="num">{s.num}</div>
              <p className="what">{s.what}</p>
              <p className="how">{s.how}</p>
            </div>
          ))}
        </div>
        <p className="perf-foot">
          The budget covers the whole surface — join funnel, sync plane, media plane, and API reads — and correctness
          still gates first: sync never trades robustness for speed.
        </p>
      </div>
    </section>
  );
}

const STACK = [
  {
    title: "Managed or self-hosted",
    body: "Run on Chalk's cloud, or host the app tier yourself — API, sync, Redis, and standard Postgres. The portable core depends on nothing proprietary.",
    chips: ["postgres", "redis", "your-infra"],
  },
  {
    title: "Swappable media plane",
    body: "The SFU sits behind one contract, and provider details never leak into your data. Swap the media engine without touching the rest of the system.",
    chips: ["MediaPlane", "cloudflare-sfu", "bring-your-own"],
  },
  {
    title: "Your identity, your tokens",
    body: "You sign participant tokens with your own rotatable keys, asserting who joins and what they can do. Anonymous joining is first-class — auth is an upgrade, never a gate.",
    chips: ["signed-tokens", "key-rotation", "anonymous-first"],
  },
];

export function SelfHost() {
  return (
    <section className="section stack" id="self-host">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Own your stack</p>
          <h2>
            No lock-in, <Chalked>by construction</Chalked>.
          </h2>
          <p className="lede">
            Flexibility isn't a roadmap item — the architecture is built so nothing can hold your deployment hostage.
          </p>
        </div>
        <div className="stack-grid">
          {STACK.map((c) => (
            <div className="stack-card" key={c.title}>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <div className="chips">
                {c.chips.map((chip) => (
                  <span className="chip" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
