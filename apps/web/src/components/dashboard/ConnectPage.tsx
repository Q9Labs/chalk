import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { act, errorMessage, failureKind, readPage, signOut } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { ConnectDecided, ConnectLoading, ConnectShell, ConnectUnavailable, type Decided } from "./ConnectStates";
import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { useLoad, useSession } from "./use-dashboard";
import { Seg } from "./kit";

type Scope = "chalk:read" | "chalk:manage";

const OUTSIDE_ACCESS = "API keys, signing keys, members and account settings";

function Permissions({ clientName, manage }: { readonly clientName: string; readonly manage: boolean }) {
  return (
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
  );
}

type ConsentProps = {
  readonly clientName: string;
  readonly redirectHost: string;
  readonly tenantName: string | null;
  readonly canManage: boolean;
  readonly scope: Scope;
  readonly onScope: (scope: Scope) => void;
  readonly profile: ProfileDTO | null;
  readonly busy: "approve" | "deny" | null;
  readonly failure: string | null;
  readonly onDecide: (kind: "approve" | "deny") => void;
  readonly onSwitch: () => void;
};

function Consent({ clientName, redirectHost, tenantName, canManage, scope, onScope, profile, busy, failure, onDecide, onSwitch }: ConsentProps) {
  return (
    <ConnectShell app={clientName} title={`Connect ${clientName} to Chalk`}>
      <p>{clientName} wants to use your Chalk account.</p>
      {profile ? (
        <p className="cwho">
          Signed in as <b>{profile.email}</b>
          {tenantName ? ` · ${tenantName}` : null}
          <button type="button" disabled={busy !== null} onClick={onSwitch}>
            Switch account
          </button>
        </p>
      ) : null}
      {canManage ? (
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
            onChange={onScope}
          />
        </div>
      ) : null}
      <Permissions clientName={clientName} manage={scope === "chalk:manage"} />
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
        <button type="button" className="btn pri lg" disabled={busy !== null} aria-busy={busy === "approve" ? true : undefined} onClick={() => onDecide("approve")}>
          {busy === "approve" ? `Connecting ${clientName}…` : `Connect ${clientName}`}
        </button>
        <button type="button" className="btn gh lg" disabled={busy !== null} aria-busy={busy === "deny" ? true : undefined} onClick={() => onDecide("deny")}>
          Cancel
        </button>
      </div>
      <p className="sifine">
        Approving takes you back to <b>{redirectHost}</b>. You can disconnect {clientName} any time under Developer.
      </p>
    </ConnectShell>
  );
}

/** The OAuth consent screen. An MCP app (Claude, ChatGPT) sent the person here to connect to their Chalk account. */
export function ConnectPage({ request }: { readonly request: string }) {
  const { state, reload } = useLoad(() => readPage("connect", { request }), `connect:${request}`);
  const [scope, setScope] = useState<Scope>("chalk:read");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { profile } = useSession();
  const navigate = useNavigate();
  const [decided, setDecided] = useState<Decided | null>(null);

  if (state.kind === "loading") return <ConnectLoading />;
  if (state.kind === "error") return <ConnectUnavailable error={state.error} transient={failureKind(state.error) === "transient"} reload={reload} />;
  const { clientName, redirectHost, requestedScope, tenantName } = state.data;
  if (decided) return <ConnectDecided decided={decided} clientName={clientName} redirectHost={redirectHost} />;

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

  // Signing out sends the person to sign in with the same request, so they come back to this page as the other account.
  async function switchAccount() {
    try {
      await signOut();
      void navigate({ to: "/dashboard/sign-in", search: { returnTo: `/dashboard/connect?request=${request}` } });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  return <Consent clientName={clientName} redirectHost={redirectHost} tenantName={tenantName} canManage={requestedScope === "chalk:manage"} scope={scope} onScope={setScope} profile={profile} busy={busy} failure={failure} onDecide={decide} onSwitch={() => void switchAccount()} />;
}
