const STATS = [
  { id: "join", num: "<1s", what: "Click to media", how: "First frame at p50." },
  { id: "control", num: "<100ms", what: "Control signal", how: "Sync plane at p95." },
  { id: "glass", num: "<200ms", what: "Glass to glass", how: "Same-region media." },
] as const;

export function Performance() {
  return (
    <section className="band" id="speed">
      <div className="container">
        <header className="sec-head">
          <h2>
            Every step on the way in <span className="muted">has a number it has to beat.</span>
          </h2>
          <p>Latency is a design constraint here, not something measured after the fact. These are the three that sit between pressing a button and seeing a face.</p>
        </header>

        <ul className="speed-stats">
          {STATS.map((stat) => (
            <li key={stat.id} className="speed-stat card">
              <strong>{stat.num}</strong>
              <b>{stat.what}</b>
              <span className="speed-stat-how">{stat.how}</span>
            </li>
          ))}
        </ul>

        <p className="fine-print speed-note">These are the budgets Chalk designs against. They are not a published service level agreement.</p>
      </div>
    </section>
  );
}
