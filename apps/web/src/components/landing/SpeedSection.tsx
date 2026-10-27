import { useEffect, useRef, useState } from "react";

import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Dither } from "./Dither";

const BUDGETS = [
  { value: "<1s", line: "Click to first frame, at p50. Under 2.5 s at p95." },
  { value: "<100ms", line: "Mute, hands and chat, at p95 in the same region." },
  { value: "<200ms", line: "Camera to screen, glass to glass in the same region." },
] as const;

export function SpeedSection() {
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  function join() {
    if (running) return;
    setProgress(0);
    setRunning(true);
    const start = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function tick(now: number) {
      const value = Math.min(1, (now - start) / 840);
      setProgress(reduced && value < 1 ? 0 : value);
      if (value < 1) frame.current = requestAnimationFrame(tick);
      else setRunning(false);
    }
    frame.current = requestAnimationFrame(tick);
  }
  const done = progress === 1;
  return (
    <section className="band" id="speed" aria-labelledby="speed-title">
      <div className="ctn split dpanel">
        <Dither kind="speed" />
        <div className="spd-l">
          <h2 className="h2" id="speed-title">
            Press Join. You’re in.
          </h2>
          <p className="sub">No installs and no waiting room. The way in is designed to feel instant, so the first thing anyone sees is a face.</p>
          <ul className="budgets">
            {BUDGETS.map((budget) => (
              <li key={budget.value}>
                <strong>{budget.value}</strong>
                <span>{budget.line}</span>
              </li>
            ))}
          </ul>
          <p className="fine">These are the budgets Chalk is designed against. They aren’t a service level agreement.</p>
        </div>
        <div className={`jsim${done ? " done" : ""}`} data-art="">
          <div className="js-url mono">
            <Icon name="check" />
            chalkmeet.com/abc-defg-hij
          </div>
          <div className="js-body">
            <div className="js-stage">
              {!done ? (
                <div className="js-form">
                  <b>Ready to join?</b>
                  <span className="js-name">
                    <Avatar name="Ari Cohen" size={28} />
                    Ari
                  </span>
                  <button type="button" className="btn pri js-go" disabled={running} onClick={join}>
                    {running ? "Joining…" : "Join call"}
                  </button>
                </div>
              ) : (
                <div className="js-in">
                  <div className="js-faces">
                    {["Lena Vogel", "Omar Farouk", "June Park", "Ari Cohen"].map((name) => (
                      <div className="js-f" key={name}>
                        <Avatar name={name} size={64} tile />
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn replay" onClick={join}>
                    Replay
                  </button>
                </div>
              )}
            </div>
            <div className="js-meter">
              <span className="js-t num">{(progress * 0.84).toFixed(2)} s</span>
              <span className="js-bar" aria-hidden="true">
                <i style={{ width: `${progress * 100}%` }} />
              </span>
              <span className="js-s mu" role="status">
                {done ? "First frame at 0.84 s. This is the p50 budget, replayed." : running ? "Joining…" : "Press Join to try it"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
