import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { acceptTenantInvitation, DashboardAPIError, getAccount, logoutAccount } from "../../lib/dashboard-api";
import { tenantHintKey } from "./DashboardAccount";

const TOKEN_STORAGE_KEY = "chalk.invitation-token";
const ACCEPT_PATH = "/invitations/accept";

type AcceptState = { kind: "working" } | { kind: "missing" } | { kind: "expired"; message: string } | { kind: "wrong-account"; message: string } | { kind: "failed"; message: string };

/** The token arrives in the URL fragment, which browsers never send to a server. It moves to sessionStorage so a sign-in round trip keeps it. */
function takeToken(): string | null {
  const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromFragment) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromFragment);
    window.history.replaceState(null, "", window.location.pathname);
    return fromFragment;
  }
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function AcceptInvitationPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<AcceptState>({ kind: "working" });
  const [signingOut, setSigningOut] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeToken();
    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    void (async () => {
      try {
        await getAccount();
        const membership = await acceptTenantInvitation(token);
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        window.localStorage.setItem(tenantHintKey, membership.tenant_id);
        await navigate({ to: "/home", replace: true });
      } catch (cause: unknown) {
        if (!(cause instanceof DashboardAPIError)) {
          setState({ kind: "failed", message: "Chalk could not reach the invitation service. Try again." });
        } else if (cause.status === 401) {
          await navigate({ to: "/sign-in", search: { next: ACCEPT_PATH }, replace: true });
        } else if (cause.status === 410) {
          window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          setState({ kind: "expired", message: cause.message });
        } else if (cause.status === 403) {
          setState({ kind: "wrong-account", message: cause.message });
        } else {
          setState({ kind: "failed", message: cause.message });
        }
      }
    })();
  }, [navigate]);

  async function switchAccount() {
    setSigningOut(true);
    try {
      await logoutAccount();
      await navigate({ to: "/sign-in", search: { next: ACCEPT_PATH }, replace: true });
    } catch {
      setSigningOut(false);
      setState({ kind: "failed", message: "Chalk could not sign you out. Try again." });
    }
  }

  return (
    <main className="dashboard-gate-state" aria-live="polite">
      {state.kind === "working" ? (
        <>
          <span className="dashboard-loading-mark">C</span>
          <p>Joining the Tenant…</p>
        </>
      ) : null}
      {state.kind === "missing" ? (
        <>
          <p className="eyebrow">Invitation</p>
          <h1>This link is missing its invitation.</h1>
          <p>Open the full link from your invitation email, or ask an Owner to send a new one.</p>
        </>
      ) : null}
      {state.kind === "expired" ? (
        <>
          <p className="eyebrow">Invitation unavailable</p>
          <h1>This invitation no longer works.</h1>
          <p>{state.message}</p>
          <p>Ask a Tenant admin to send you a new invitation.</p>
        </>
      ) : null}
      {state.kind === "wrong-account" ? (
        <>
          <p className="eyebrow">Different Account</p>
          <h1>This invitation is for another email.</h1>
          <p>{state.message}</p>
          <p>Sign out, then sign in or sign up with the email address the invitation was sent to.</p>
          <button type="button" className="dashboard-button primary" onClick={() => void switchAccount()} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out and switch Account"}
          </button>
        </>
      ) : null}
      {state.kind === "failed" ? (
        <>
          <p className="eyebrow">Invitation</p>
          <h1>We could not accept this invitation.</h1>
          <p role="alert">{state.message}</p>
          <button type="button" className="dashboard-button secondary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </>
      ) : null}
    </main>
  );
}
