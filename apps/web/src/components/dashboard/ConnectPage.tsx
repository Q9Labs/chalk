import { useState } from "react";

import { act, errorMessage } from "../../lib/dashboard/client";
import { readPage } from "../../lib/dashboard/client";
import { useLoad } from "./AppShell";
import { ErrorPanel, Sk } from "./kit";

type Scope = "chalk:read" | "chalk:manage";

const ACCESS: Readonly<Record<Scope, string>> = {
  "chalk:read": "See your Spaces, Episodes, Recordings, Transcriptions and Webhooks",
  "chalk:manage": "See and change your Spaces, Episodes, Recordings, Transcriptions and Webhooks",
};

/** The OAuth consent screen. An MCP app (Claude, ChatGPT) sent the person here to connect to their Chalk account. */
export function ConnectPage({ request }: { readonly request: string }) {
  const { state, reload } = useLoad(() => readPage("connect", { request }), `connect:${request}`);
  const [scope, setScope] = useState<Scope>("chalk:read");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (state.kind === "loading")
    return (
      <div className="wrap">
        <Sk width="260px" height={24} />
      </div>
    );
  if (state.kind === "error") {
    return (
      <div className="wrap">
        <ErrorPanel title="This connection request has expired" detail={errorMessage(state.error)} onRetry={reload} />
        <p className="ohelp">Go back to the app and start the connection again.</p>
      </div>
    );
  }
  const { clientName, redirectHost, requestedScope } = state.data;

  function decide(kind: "approve" | "deny") {
    setBusy(kind);
    setFailure(null);
    const action = kind === "approve" ? ({ action: "approve-connection", request, scope } as const) : ({ action: "deny-connection", request } as const);
    act("connect", action).then(
      (result) => window.location.assign(result.redirectUrl),
      (error: unknown) => {
        setBusy(null);
        setFailure(errorMessage(error));
      },
    );
  }

  return (
    <main className="si">
      <div className="sibox">
        <h1>Connect {clientName} to Chalk?</h1>
        <p>
          {clientName} wants to use your Chalk account. Approving sends you back to <b>{redirectHost}</b>. You can disconnect it any time under Developer.
        </p>
        <fieldset className="cscope">
          <legend>Access to give</legend>
          <label>
            <input type="radio" name="scope" checked={scope === "chalk:read"} onChange={() => setScope("chalk:read")} />
            <span>
              <b>Read only</b>
              {ACCESS["chalk:read"]}.
            </span>
          </label>
          {requestedScope === "chalk:manage" ? (
            <label>
              <input type="radio" name="scope" checked={scope === "chalk:manage"} onChange={() => setScope("chalk:manage")} />
              <span>
                <b>Read and change</b>
                {ACCESS["chalk:manage"]}.
              </span>
            </label>
          ) : null}
        </fieldset>
        <p className="sifine">It never gets your API keys, signing keys, members or account settings.</p>
        {failure ? (
          <div className="alert" role="alert">
            <div>{failure}</div>
          </div>
        ) : null}
        <div className="sib">
          <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === "approve" ? true : undefined} onClick={() => decide("approve")}>
            Connect {clientName}
          </button>
          <button type="button" className="btn gh" disabled={busy !== null} onClick={() => decide("deny")}>
            Cancel
          </button>
        </div>
      </div>
    </main>
  );
}
