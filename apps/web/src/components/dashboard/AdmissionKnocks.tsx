import type { CallPageDTO } from "../../lib/dashboard/contracts";

export function AdmissionKnocks({ knocks, onDecision }: { readonly knocks: CallPageDTO["knocks"]; readonly onDecision: (handle: string, allow: boolean) => Promise<void> }) {
  if (!knocks.length) return null;
  return (
    <div className="list" aria-label="Asking to join" style={{ marginTop: 16 }}>
      {knocks.map((knock) => {
        const busy = knock.decisionState === "in_flight";
        return (
          <div className="orow" key={knock.handle}>
            <span>
              <b>{knock.name}</b> <span className="mu">asks to join</span>
              {knock.decisionState === "retryable" ? <span className="mu"> · That decision couldn’t be completed. Try again.</span> : null}
            </span>
            <span className="ract">
              {busy && !knock.decisionAction ? <span role="status">Finishing…</span> : null}
              <button type="button" className="btn gh sm" disabled={busy} onClick={() => void onDecision(knock.handle, false)}>
                {busy && knock.decisionAction === "deny" ? "Denying…" : "Deny"}
              </button>
              <button type="button" className="btn sec sm" disabled={busy} onClick={() => void onDecision(knock.handle, true)}>
                {busy && knock.decisionAction === "approve" ? "Letting in…" : "Let in"}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
