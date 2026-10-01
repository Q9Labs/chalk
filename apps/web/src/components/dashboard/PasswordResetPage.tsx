import { Link, useNavigate } from "@tanstack/react-router";
import { Logo } from "@q9labsai/chalk-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { completePasswordReset, DashboardAPIError, requestPasswordReset } from "../../lib/dashboard-api";

const REQUEST_CONFIRMATION = "If an Account exists for that email, we sent a reset link";

function AccountEntryFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="account-entry">
      <section className="account-entry-story" aria-label="Chalk introduction">
        <Link to="/" className="account-entry-brand" aria-label="Chalk home">
          <Logo accessibilityLabel={null} color="currentColor" height={34} motion="orbit-burst" variant="wordmark" />
        </Link>
        <div>
          <p className="eyebrow">Return to your work</p>
          <h1>Recover your Account securely.</h1>
          <p>Reset your password, then pick up where the work left off.</p>
        </div>
        <p className="account-entry-footnote">Reset links expire after 30 minutes and work once.</p>
      </section>
      <section className="account-entry-form-wrap">{children}</section>
    </main>
  );
}

export function RequestPasswordResetPage() {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      await requestPasswordReset(String(data.get("email") ?? ""));
      setSubmitted(true);
    } catch {
      setError("The reset link could not be requested. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountEntryFrame>
      <form className="account-entry-form" onSubmit={submit}>
        <p className="eyebrow">Password reset</p>
        <h2>Find your Account.</h2>
        {submitted ? (
          <p className="auth-success" role="status">
            {REQUEST_CONFIRMATION}
          </p>
        ) : (
          <>
            <p className="auth-guidance">Enter the email used for your Chalk Account.</p>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            {error ? (
              <p className="auth-error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="dashboard-button primary" type="submit" disabled={busy}>
              {busy ? "Sending reset link…" : "Send reset link"}
            </button>
          </>
        )}
        <p className="auth-switch">
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      </form>
    </AccountEntryFrame>
  );
}

export function CompletePasswordResetPage({ token }: { token: string | null }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      await completePasswordReset({ token, password: String(data.get("password") ?? "") });
      await navigate({ to: "/sign-in", replace: true });
    } catch (cause) {
      if (cause instanceof DashboardAPIError && cause.code === "access.invalid_password") {
        setError("Use at least 8 characters. If your password is long, try a shorter one.");
      } else {
        setError(cause instanceof DashboardAPIError ? cause.message : "This reset link could not be used. Request a new link.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AccountEntryFrame>
      <form className="account-entry-form" onSubmit={submit}>
        <p className="eyebrow">Password reset</p>
        <h2>Choose a new password.</h2>
        {token === null ? (
          <p role="status">Reading reset link…</p>
        ) : token ? (
          <>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" required minLength={8} />
              <span>Use at least 8 characters.</span>
            </label>
            {error ? (
              <p className="auth-error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="dashboard-button primary" type="submit" disabled={busy}>
              {busy ? "Resetting password…" : "Reset password"}
            </button>
          </>
        ) : (
          <p className="auth-error" role="alert">
            This reset link could not be used. Request a new link.
          </p>
        )}
        <p className="auth-switch">
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      </form>
    </AccountEntryFrame>
  );
}
