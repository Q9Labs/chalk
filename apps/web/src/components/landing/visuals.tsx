// Isometric-tilted floating UI mocks — the "coded visuals" layer.

const FUNNEL = [
  { stage: "Token", ms: 90, stick: "var(--chalk-blue)" },
  { stage: "Session", ms: 140, stick: "var(--chalk-green)" },
  { stage: "ICE", ms: 260, stick: "var(--chalk-yellow)" },
  { stage: "First frame", ms: 420, stick: "var(--chalk-pink)" },
];

const FUNNEL_SCALE = 1000;

export function LatencyVisual() {
  let elapsed = 0;
  const rows = FUNNEL.map((f) => {
    const start = elapsed;
    elapsed += f.ms;
    return { ...f, start };
  });

  return (
    <div className="cv-scene">
      <span className="cv-glow" aria-hidden="true" />
      <div className="cv-card cv-tilt cv-card-latency" aria-hidden="true">
        <div className="cv-head">
          <span className="cv-eyebrow">
            <span className="cv-dot" /> Join funnel · p50
          </span>
          <span className="cv-badge">under budget</span>
        </div>
        <div className="cv-metric">
          <span className="cv-metric-num">
            0.8<span className="cv-unit">s</span>
          </span>
          <span className="cv-metric-sub">click → first frame</span>
        </div>
        <div className="cv-funnel">
          {rows.map((r, i) => (
            <div className="cv-funnel-row" key={r.stage} style={{ "--d": `${i * 90}ms` } as React.CSSProperties}>
              <span className="cv-funnel-label">{r.stage}</span>
              <span className="cv-funnel-lane">
                <span
                  className="cv-funnel-bar"
                  style={
                    {
                      left: `${(r.start / FUNNEL_SCALE) * 100}%`,
                      width: `${(r.ms / FUNNEL_SCALE) * 100}%`,
                      background: r.stick,
                    } as React.CSSProperties
                  }
                />
              </span>
              <span className="cv-funnel-ms">{r.ms}</span>
            </div>
          ))}
        </div>
      </div>
      <span className="cv-chip cv-chip-hi" aria-hidden="true">
        <span className="cv-dot" /> sync&nbsp;<b>&lt;100ms</b>
      </span>
      <span className="cv-chip cv-chip-lo" aria-hidden="true">
        glass-to-glass&nbsp;<b>&lt;200ms</b>
      </span>
    </div>
  );
}

const LAYERS = [
  { tier: "Front doors", nodes: ["Meeting app", "SDK"], tone: "plain" },
  { tier: "Portable core", nodes: ["sync", "api", "identity"], tone: "core" },
  { tier: "Contracts", nodes: ["MediaPlane", "TokenSigner"], tone: "seam" },
  { tier: "Your infra", nodes: ["any SFU", "postgres", "redis"], tone: "plain" },
];

export function StackVisual() {
  return (
    <div className="cv-scene cv-scene-stack">
      <span className="cv-glow" aria-hidden="true" />
      <div className="cv-iso" aria-hidden="true">
        {LAYERS.map((l, i) => (
          <div className={`cv-plane cv-plane-${l.tone}`} key={l.tier} style={{ "--i": i, "--d": `${i * 110}ms` } as React.CSSProperties}>
            <span className="cv-plane-tier">{l.tier}</span>
            <span className="cv-plane-nodes">
              {l.nodes.map((n) => (
                <span className="cv-plane-node" key={n}>
                  {n}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
