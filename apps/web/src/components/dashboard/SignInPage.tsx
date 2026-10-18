import { useState } from "react";

import { signInURL, type Provider } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { Lockup } from "../site/Lockup";

const PROVIDERS: readonly (readonly [Provider, string, string])[] = [
  ["google", "g", "Google"],
  ["apple", "a", "Apple"],
];

/** Google and Apple only. Signing in the first time creates the account. */
export function SignInPage({ returnTo, failed }: { readonly returnTo?: string; readonly failed?: Provider }) {
  const [busy, setBusy] = useState<Provider | null>(null);
  function start(provider: Provider) {
    setBusy(provider);
    window.location.assign(signInURL(provider, returnTo));
  }
  const busyName = PROVIDERS.find(([provider]) => provider === busy)?.[2];
  const failedName = PROVIDERS.find(([provider]) => provider === failed)?.[2];
  const other = PROVIDERS.find(([provider]) => provider !== failed)?.[2];
  return (
    <>
      <header className="sihead">
        <a href="/" aria-label="Chalk home">
          <Lockup />
        </a>
      </header>
      <main className="si">
        <div className="sibox">
          <h1>Sign in to Chalk</h1>
          <p>New here? Signing in creates your account.</p>
          {failedName && !busy ? (
            <div className="alert" role="alert">
              <Icon name="alert" />
              <div>
                <b>{failedName} sign-in didn’t finish</b>
                You’re not signed in, and nothing was created. Try again, or continue with {other}.
              </div>
            </div>
          ) : null}
          <div className="sib">
            {PROVIDERS.map(([provider, className, name]) => (
              <button key={provider} type="button" className={`pbtn ${className}`} disabled={busy !== null} aria-busy={busy === provider ? true : undefined} onClick={() => start(provider)}>
                <span className="pl">{provider === "google" ? <GoogleLogo /> : <AppleLogo />}</span>
                Continue with {name}
                {busy === provider ? <span className="spin" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          {busyName ? (
            <p className="siwait" role="status">
              <span className="spin" aria-hidden="true" />
              Taking you to {busyName}…
            </p>
          ) : null}
          <p className="sifine">
            By continuing, you agree to the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy Policy</a>.
          </p>
        </div>
        <p className="sinote">
          <Icon name="link" />
          <span>To join a call, open its link. You don’t need an account.</span>
        </p>
      </main>
    </>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 814 1000" width="16" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
      />
    </svg>
  );
}
