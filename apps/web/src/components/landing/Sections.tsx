import { Chalked } from "./Chalked";
import { LatencyVisual, StackVisual } from "./visuals";

export function FrontDoors() {
  return (
    <section className="section doors" id="sdk">
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Product direction</p>
          <h2>
            One core. <Chalked>Two front doors.</Chalked>
          </h2>
          <p className="lede">The managed TypeScript and React web integration is implemented today; the first-party hosted app is still being completed.</p>
        </div>
        <div className="doors-grid">
          <div className="door">
            <h3>The app</h3>
            <p>The repository includes a mobile join flow and a local web proof room. Public room creation, the hosted meeting experience, and several collaboration flows are still open work.</p>
            <div className="door-shot" aria-hidden="true">
              <img src="/images/marketing/hero-1.png" width={2560} height={1476} alt="" loading="lazy" />
            </div>
            <div className="room-pill" aria-hidden="true">
              <span>Hosted room flow</span>
              <span className="room-copy">In progress</span>
            </div>
            <a href="/sdk-preview" className="door-link">
              View the current preview →
            </a>
          </div>
          <div className="door door-board">
            <h3>The SDKs</h3>
            <p>The TypeScript client owns API, media, sync, telemetry, and server-only webhook behavior. React provides presentational meeting components, while React Native adds provider, hooks, and native meeting surfaces.</p>
            <div className="codeboard">
              <code className="codeboard-install">npm install @q9labsai/chalk-react</code>
              <pre>
                <code>
                  <span className="tok-kw">import</span> {"{ "}
                  <span className="tok-cmp">VideoGrid</span>
                  {" }"} <span className="tok-kw">from</span> <span className="tok-str">"@q9labsai/chalk-react/composite"</span>;{"\n\n"}
                  <span className="tok-kw">export function</span> <span className="tok-cmp">MeetingStage</span>
                  {"({ participants }) {\n"}
                  {"  "}
                  <span className="tok-kw">return</span> {" <"}
                  <span className="tok-cmp">VideoGrid</span> <span className="tok-prop">participants</span>
                  {"={participants} />;\n}"}
                </code>
              </pre>
            </div>
            <p className="tok-dim" style={{ fontSize: 13.5 }}>
              TypeScript, React, and React Native are implemented today. Swift, Kotlin, Python, and Go remain future generation targets.
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
    what: "Click to media target",
    how: "The design budget targets first frame in under one second at p50; this is a target, not a published production measurement.",
  },
  {
    num: "<100ms",
    what: "Control signal target",
    how: "The design budget targets sub-100ms p95 for sync-plane signals; production qualification is still outstanding.",
  },
  {
    num: "<200ms",
    what: "Glass-to-glass target",
    how: "The design budget targets sub-200ms same-region media latency and sub-500ms new-track rendering.",
  },
];

export function PerfBudget() {
  return (
    <section className="section perf" id="performance">
      <div className="container perf-layout">
        <div className="perf-copy">
          <div className="section-head">
            <p className="eyebrow">Performance budget</p>
            <h2>
              Fast is a <Chalked>written spec</Chalked>, not a vibe.
            </h2>
            <p className="lede">These are engineering targets from the north-star design, not observed production guarantees.</p>
          </div>
          <ul className="perf-stats">
            {STATS.map((s) => (
              <li className="perf-stat" key={s.what}>
                <span className="num">{s.num}</span>
                <span className="perf-stat-text">
                  <b>{s.what}</b>
                  <span>{s.how}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="perf-media">
          <LatencyVisual />
        </div>
      </div>
    </section>
  );
}

const STACK = [
  {
    title: "App-tier self-host source",
    body: "The API, sync service, and standard Postgres authority are in the repository. Repeatable production deployment qualification is still open work.",
    stick: "var(--chalk-green)",
  },
  {
    title: "Swappable media plane",
    body: "Cloudflare sits behind a provider-neutral contract. A Cloudflare-free SFU adapter is designed but not implemented yet.",
    stick: "var(--chalk-blue)",
  },
  {
    title: "Your identity, your tokens",
    body: "You sign participant tokens with your own rotatable keys. Anonymous joining is first-class — auth is an upgrade, never a gate.",
    stick: "var(--chalk-yellow)",
  },
];

export function SelfHost() {
  return (
    <section className="section stack" id="self-host">
      <div className="container stack-layout">
        <div className="stack-copy">
          <div className="section-head">
            <p className="eyebrow">Own your stack</p>
            <h2>
              Portable boundaries, <Chalked>built in.</Chalked>
            </h2>
            <p className="lede">The portability boundaries exist in code, but full self-hosting still depends on a future non-Cloudflare media adapter.</p>
          </div>
          <ul className="stack-points">
            {STACK.map((c) => (
              <li className="stack-point" key={c.title} style={{ "--f-stick": c.stick } as React.CSSProperties}>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="stack-media">
          <StackVisual />
        </div>
      </div>
    </section>
  );
}
