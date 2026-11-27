import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { act, errorMessage, failureKind, readPage, signOut } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { ConnectLoading, ConnectShell } from "./ConnectStates";
import { useLoad, useSession } from "./use-dashboard";

export function HandoverPage({ handoverId }: { readonly handoverId: string }) {
  const { state, reload } = useLoad(() => readPage("handover", { handoverId }), `handover:${handoverId}`);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { profile } = useSession();
  const navigate = useNavigate();

  if (state.kind === "loading") return <ConnectLoading />;
  if (state.kind === "error")
    return (
      <ConnectShell app={null} title="Chalk couldn’t load this handover">
        <p>{errorMessage(state.error)}</p>
        {failureKind(state.error) === "transient" ? (
          <button type="button" className="btn pri lg" onClick={reload}>
            Try again
          </button>
        ) : null}
      </ConnectShell>
    );
  const handover = state.data;
  const unavailable = handover.status !== "pending" || !handover.recipientMatches;
  const title = done ? "Tenant handed over" : unavailable ? "This handover is unavailable" : "Accept this Tenant?";

  async function accept() {
    setBusy(true);
    setFailure(null);
    try {
      await act("handover", { action: "accept-handover", handoverId });
      setDone(true);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    await signOut();
    void navigate({ to: "/dashboard/sign-in", search: { returnTo: `/dashboard/handover/${handoverId}` } });
  }

  return (
    <ConnectShell app={null} title={title}>
      {done ? (
        <>
          <p role="status">The Tenant, its Spaces, recordings and transcripts are now in your Chalk account.</p>
          <div className="sib">
            <Link className="btn pri lg" to="/dashboard">
              Open your dashboard
            </Link>
          </div>
        </>
      ) : unavailable ? (
        <>
          <p>
            {!handover.recipientMatches
              ? "This handover is for another Chalk account."
              : handover.status === "accepted"
                ? "This handover was already accepted."
                : handover.status === "canceled"
                  ? "This handover was cancelled. Ask whoever sent this link for a new one."
                  : "This handover expired. Ask whoever sent this link for a new one."}
          </p>
          {profile ? (
            <p className="cwho">
              Signed in as <b>{profile.email}</b>
              <button type="button" onClick={() => void switchAccount()}>
                Switch account
              </button>
            </p>
          ) : null}
          <div className="sib">
            <Link className="btn sec lg" to="/dashboard">
              Go to your dashboard
            </Link>
          </div>
        </>
      ) : (
        <>
          <p>Accepting moves this Tenant to your Chalk account. Its Spaces, recordings and transcripts stay intact. The service that created it loses access.</p>
          {profile ? (
            <p className="cwho">
              Signed in as <b>{profile.email}</b>
              <button type="button" disabled={busy} onClick={() => void switchAccount()}>
                Switch account
              </button>
            </p>
          ) : null}
          {failure ? (
            <div className="alert" role="alert">
              <Icon name="alert" />
              <div>
                <b>Chalk couldn’t accept the handover</b>
                {failure}
              </div>
            </div>
          ) : null}
          <div className="sib">
            <button type="button" className="btn pri lg" disabled={busy} aria-busy={busy || undefined} onClick={() => void accept()}>
              {busy ? "Accepting…" : "Accept handover"}
            </button>
            <Link className="btn gh lg" to="/dashboard">
              Not now
            </Link>
          </div>
          <p className="sifine">This offer expires {new Date(handover.expiresAt).toLocaleString()}.</p>
        </>
      )}
    </ConnectShell>
  );
}
