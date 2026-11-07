import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { act, errorMessage, failureKind, readPage } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { Lockup } from "../site/Lockup";
import { AppPair } from "./AppLogo";
import { useLoad } from "./AppShell";
import { Seg, Sk } from "./kit";

type Scope = "chalk:read" | "chalk:manage";

const OUTSIDE_ACCESS = "API keys, signing keys, members and account settings";

/** Every state of the connect flow sits in this one standalone layout, outside the dashboard frame. */
function ConnectShell({ app, broken, title, children }: { readonly app: string | null; readonly broken?: boolean; readonly title: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <header className="sihead">
        <a href="/" aria-label="Chalk home">
          <Lockup />
        </a>
      </header>
      <main className="si">
        <div className="sibox cbox">
          <AppPair name={app} broken={broken} />
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </>
  );
}

/** The connect page without a request: the person opened it directly instead of from the app. */
export function ConnectMissing() {
  return (
    <ConnectShell app={null} broken title="Start from the app">
      <p>Open Chalk from the app you want to connect. In Claude or ChatGPT, add Chalk as a connector and it brings you here.</p>
      <ToDashboard />
    </ConnectShell>
  );
}

function ToDashboard() {
  return (
    <div className="sib">
      <Link to="/dashboard" className="btn sec">
        Go to your dashboard
      </Link>
    </div>
  );
}

/** The OAuth consent screen. An MCP app (Claude, ChatGPT) sent the person here to connect to their Chalk account. */
export function ConnectPage({ request }: { readonly request: string }) {
  const { state, reload } = useLoad(() => readPage("connect", { request }), `connect:${request}`);
  const [scope, setScope] = useState<Scope>("chalk:read");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [decided, setDecided] = useState<{ readonly outcome: "approved" | "denied"; readonly url: string } | null>(null);

  if (state.kind === "loading")
    return (
      <ConnectShell app={null} title={<Sk width="240px" height={28} />}>
        <Sk width="100%" height={120} />
      </ConnectShell>
    );
  if (state.kind === "error") {
    if (failureKind(state.error) === "transient")
      return (
        <ConnectShell app={null} broken title="Chalk couldn’t load this request">
          <p>{errorMessage(state.error)}</p>
          <div className="sib">
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          </div>
        </ConnectShell>
      );
    return (
      <ConnectShell app={null} broken title="This connection request expired">
        <p>Requests last a few minutes and work once. Go back to the app and connect Chalk again.</p>
        <ToDashboard />
      </ConnectShell>
    );
  }
  const { clientName, redirectHost, requestedScope } = state.data;

  if (decided) {
    const approved = decided.outcome === "approved";
    return (
      <ConnectShell app={clientName} broken={!approved} title={approved ? `Connecting ${clientName}` : `${clientName} wasn’t connected`}>
        <p role="status">{approved ? `Taking you back to ${redirectHost}…` : `You cancelled, so ${clientName} has no access to your Chalk account. Taking you back to ${redirectHost}…`}</p>
        <div className="sib">
          <a className="btn sec" href={decided.url}>
            Continue to {redirectHost}
          </a>
        </div>
      </ConnectShell>
    );
  }

  function decide(kind: "approve" | "deny") {
    setBusy(kind);
    setFailure(null);
    const action = kind === "approve" ? ({ action: "approve-connection", request, scope } as const) : ({ action: "deny-connection", request } as const);
    act("connect", action).then(
      (result) => {
        setDecided({ outcome: kind === "approve" ? "approved" : "denied", url: result.redirectUrl });
        window.location.assign(result.redirectUrl);
      },
      (error: unknown) => {
        setBusy(null);
        setFailure(errorMessage(error));
      },
    );
  }

  const manage = scope === "chalk:manage";
  return (
    <ConnectShell app={clientName} title={`Connect ${clientName} to Chalk`}>
      <p>{clientName} wants to use your Chalk account.</p>
      {requestedScope === "chalk:manage" ? (
        <div className="cacc">
          <span id="connect-access" className="lbl">
            Access
          </span>
          <Seg
            labelledBy="connect-access"
            options={[
              ["chalk:read", "Read only"],
              ["chalk:manage", "Read and change"],
            ]}
            value={scope}
            onChange={setScope}
          />
        </div>
      ) : null}
      <ul className="cperm" aria-label={`What ${clientName} can do`}>
        <li>
          <Icon name="check" />
          <span>{manage ? "See and change your Spaces, Episodes, Recordings, Transcriptions and Webhooks" : "See your Spaces, Episodes, Recordings, Transcriptions and Webhooks"}</span>
        </li>
        {manage ? null : (
          <li className="no">
            <Icon name="lock" />
            <span>Can’t change anything</span>
          </li>
        )}
        <li className="no">
          <Icon name="lock" />
          <span>Never sees your {OUTSIDE_ACCESS}</span>
        </li>
      </ul>
      {failure ? (
        <div className="alert" role="alert">
          <Icon name="alert" />
          <div>
            <b>Chalk couldn’t connect {clientName}</b>
            {failure}
          </div>
        </div>
      ) : null}
      <div className="sib">
        <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === "approve" ? true : undefined} onClick={() => decide("approve")}>
          {busy === "approve" ? `Connecting ${clientName}…` : `Connect ${clientName}`}
        </button>
        <button type="button" className="btn gh" disabled={busy !== null} aria-busy={busy === "deny" ? true : undefined} onClick={() => decide("deny")}>
          Cancel
        </button>
      </div>
      <p className="sifine">
        Approving takes you back to <b>{redirectHost}</b>. You can disconnect {clientName} any time under Developer.
      </p>
    </ConnectShell>
  );
}
