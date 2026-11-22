import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { Lockup } from "../site/Lockup";
import { AppPair } from "./AppLogo";
import { Sk } from "./kit";

/** Every state of the connect flow sits in this one standalone layout, outside the dashboard frame. */
export function ConnectShell({ app, broken, title, children }: { readonly app: string | null; readonly broken?: boolean; readonly title: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <header className="sihead">
        <a href="/" aria-label="Chalk home">
          <Lockup />
        </a>
      </header>
      <main className="si">
        <div className="sibox cbox">
          {/* Without an app there is nothing to pair, and the lockup above already names Chalk. */}
          {app ? <AppPair name={app} broken={broken} /> : null}
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
    <ConnectShell app={null} title="Start from the app">
      <p>Open Chalk from the app you want to connect. In Claude or ChatGPT, add Chalk as a connector and it brings you here.</p>
      <ToDashboard />
    </ConnectShell>
  );
}

function ToDashboard() {
  return (
    <div className="sib fit">
      <Link to="/dashboard" className="btn sec lg">
        Go to your dashboard
      </Link>
    </div>
  );
}

export function ConnectLoading() {
  return (
    <ConnectShell app={null} title={<Sk width="240px" height={28} />}>
      <Sk width="100%" height={120} />
    </ConnectShell>
  );
}

/** A transient failure offers a retry; any other means the request is gone. */
export function ConnectUnavailable({ error, transient, reload }: { readonly error: unknown; readonly transient: boolean; readonly reload: () => void }) {
  if (transient)
    return (
      <ConnectShell app={null} title="Chalk couldn’t load this request">
        <p>{errorMessage(error)}</p>
        <div className="sib">
          <button type="button" className="btn pri lg" onClick={reload}>
            Try again
          </button>
        </div>
      </ConnectShell>
    );
  return (
    <ConnectShell app={null} title="This connection request expired">
      <p>Requests last a few minutes and work once. Go back to the app and connect Chalk again.</p>
      <ToDashboard />
    </ConnectShell>
  );
}

export type Decided = { readonly outcome: "approved" | "denied"; readonly url: string };

export function ConnectDecided({ decided, clientName, redirectHost }: { readonly decided: Decided; readonly clientName: string; readonly redirectHost: string }) {
  const approved = decided.outcome === "approved";
  return (
    <ConnectShell app={clientName} broken={!approved} title={approved ? `Connecting ${clientName}` : `${clientName} wasn’t connected`}>
      <p role="status">{approved ? `Taking you back to ${redirectHost}…` : `You cancelled, so ${clientName} has no access to your Chalk account. Taking you back to ${redirectHost}…`}</p>
      <div className="sib">
        <a className="btn sec lg" href={decided.url}>
          Continue to {redirectHost}
        </a>
      </div>
    </ConnectShell>
  );
}
