import { useState } from "react";
import { episodeDebuggerPath } from "./reference";

export function EpisodeDiagnosticsLauncher({ enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__ }: { readonly enabled?: boolean }) {
  const [reference, setReference] = useState("");
  if (!enabled) return null;
  const path = episodeDebuggerPath(reference);

  return (
    <section className="contract-state episode-debugger-launcher" aria-labelledby="episode-debugger-heading">
      <div>
        <p className="eyebrow">Alpha tooling</p>
        <h2 id="episode-debugger-heading">Episode Debugger</h2>
        <p>Follow live diagnostics, operations, issues, and traces for one Episode.</p>
      </div>
      <label htmlFor="episode-diagnostic-reference">
        <span>Diagnostic reference</span>
        <input id="episode-diagnostic-reference" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Paste a chalkdiag:v1 reference" spellCheck={false} autoComplete="off" />
      </label>
      {path ? (
        <a className="dashboard-button secondary" href={path}>
          Open Episode Debugger
        </a>
      ) : (
        <button className="dashboard-button secondary" type="button" disabled>
          Open Episode Debugger
        </button>
      )}
      <p className="fixture-note">You can also open an Episode from Episodes and choose Open Episode Debugger. Chalk carries its reference for you.</p>
    </section>
  );
}
