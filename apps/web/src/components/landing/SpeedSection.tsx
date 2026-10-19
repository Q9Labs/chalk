const BUDGETS = [
  { value: "<1s", title: "Click to first frame", line: "At p50. Under 2.5 s at p95." },
  { value: "<100ms", title: "Mute, hands and chat", line: "Each signal at p95, in the same region." },
  { value: "<200ms", title: "Camera to screen", line: "Glass to glass, in the same region." },
] as const;

export function SpeedSection() {
  return (
    <section className="band" id="speed" aria-labelledby="speed-title">
      <div className="ctn">
        <h2 className="h2" id="speed-title">
          Every step on the way in has a number to beat.
        </h2>
        <p className="sub">Speed is designed in, not measured afterwards. These three sit between pressing Join and seeing a face.</p>
        <div className="stats">
          {BUDGETS.map((budget) => (
            <div key={budget.title} className="stat">
              <strong>{budget.value}</strong>
              <b>{budget.title}</b>
              <span>{budget.line}</span>
            </div>
          ))}
        </div>
        <p className="fine">These are the budgets Chalk is designed against. They aren’t a service level agreement.</p>
      </div>
    </section>
  );
}
