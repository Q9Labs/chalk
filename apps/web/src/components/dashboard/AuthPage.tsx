import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { DashboardAPIError, listAllAccountTenants, loginAccount, registerAccount } from "../../lib/dashboard-api";

export function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signingUp = mode === "sign-up";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      if (signingUp) {
        await registerAccount({ name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") });
      } else {
        await loginAccount({ email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") });
      }
      const tenants = await listAllAccountTenants();
      await navigate({ to: tenants.length === 0 ? "/onboarding" : "/home", replace: true });
    } catch (cause) {
      setError(cause instanceof DashboardAPIError ? cause.message : "Chalk could not complete sign-in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="account-entry">
      <section className="account-entry-story" aria-label="Chalk introduction">
        <Link to="/" className="account-entry-brand">
          Chalk
        </Link>
        <div>
          <p className="eyebrow">A place for shared work</p>
          <h1>{signingUp ? "Start with a Space, not a setup maze." : "Pick up where the work left off."}</h1>
          <p>Bring people together live, then keep the Episodes and Artifacts that matter.</p>
        </div>
        <p className="account-entry-footnote">General collaboration first. Developer tools when you need them.</p>
      </section>
      <section className="account-entry-form-wrap">
        <form className="account-entry-form" onSubmit={submit}>
          <p className="eyebrow">{signingUp ? "Create your Account" : "Welcome back"}</p>
          <h2>{signingUp ? "Bring the work into focus." : "Sign in to Chalk."}</h2>
          <a className="google-auth-button" href="/api/auth/google/start?return_to=/home">
            Continue with Google
          </a>
          <div className="auth-divider">
            <span>or use email</span>
          </div>
          {signingUp ? (
            <label>
              Your name
              <input name="name" autoComplete="name" required minLength={2} />
            </label>
          ) : null}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={signingUp ? "new-password" : "current-password"} required minLength={8} />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="dashboard-button primary" type="submit" disabled={busy}>
            {busy ? "Working…" : signingUp ? "Create Account" : "Sign in"}
          </button>
          <p className="auth-switch">
            {signingUp ? "Already have an Account?" : "New to Chalk?"} <Link to={signingUp ? "/sign-in" : "/sign-up"}>{signingUp ? "Sign in" : "Create one"}</Link>
          </p>
        </form>
      </section>
    </main>
  );
}
