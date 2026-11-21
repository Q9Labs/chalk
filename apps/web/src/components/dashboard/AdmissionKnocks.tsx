import { useEffect } from "react";

import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { entrySender } from "../../lib/boot-beacon";
import { Avatar } from "../site/Avatar";

export function AdmissionKnocks({ knocks, onDecision, spaceId }: { readonly knocks: CallPageDTO["knocks"]; readonly onDecision: (handle: string, allow: boolean) => Promise<void>; readonly spaceId?: string }) {
  useEffect(() => {
    if (!knocks.length) return;
    const shown = entrySender().surface("dashboard.knocks", { knock_count: knocks.length, ...(spaceId !== undefined ? { space_id: spaceId } : {}) });
    return () => shown.dismiss();
  }, [knocks.length, spaceId]);
  if (!knocks.length) return null;
  return (
    <div className="list" aria-label="Asking to join" style={{ marginTop: "var(--space-4)" }}>
      {knocks.map((knock) => {
        const busy = knock.decisionState === "in_flight";
        return (
          <div className="row knock" key={knock.handle}>
            <Avatar name={knock.name} size={36} />
            <span className="rt">
              <b>{knock.name}</b>
              {knock.decisionState === "retryable" ? <span className="err">That didn’t go through. Try again.</span> : <span>Waiting to be let in</span>}
            </span>
            <span className="ract">
              {busy && !knock.decisionAction ? <span role="status">Finishing…</span> : null}
              <button type="button" className="btn gh sm" disabled={busy} onClick={() => void onDecision(knock.handle, false)}>
                {busy && knock.decisionAction === "deny" ? "Denying…" : "Deny"}
              </button>
              <button type="button" className="btn pri sm" disabled={busy} onClick={() => void onDecision(knock.handle, true)}>
                {busy && knock.decisionAction === "approve" ? "Letting in…" : "Let in"}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
