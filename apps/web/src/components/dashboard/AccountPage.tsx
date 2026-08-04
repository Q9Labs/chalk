import { useState } from "react";
import { useDashboardAccount } from "./DashboardAccount";

export function AccountPage() {
  const { account, signOut } = useDashboardAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out could not finish");
      setBusy(false);
    }
  }

  return (
    <div className="dashboard-page resource-page settings-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">Your dashboard identity</p>
          <h1>Account</h1>
          <p>Chalk sign-in stays separate from customer Users, Agents, Guests, Members, and Participants.</p>
        </div>
      </header>
      <section className="settings-panel">
        <div>
          <p className="eyebrow">Profile</p>
          <h2>{account.name}</h2>
          <p>{account.email}</p>
        </div>
        <dl>
          <div>
            <dt>Account ID</dt>
            <dd>{account.id}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(account.created_at).toLocaleDateString()}</dd>
          </div>
        </dl>
      </section>
      <section className="settings-panel settings-signout">
        <div>
          <h2>Sign out of this browser</h2>
          <p>Your server sign-in is revoked and the dashboard cookie is cleared.</p>
        </div>
        <button className="dashboard-button secondary" type="button" disabled={busy} onClick={handleSignOut}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
        {error ? <p className="auth-error">{error}</p> : null}
      </section>
    </div>
  );
}
