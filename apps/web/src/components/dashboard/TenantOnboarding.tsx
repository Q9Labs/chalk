import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { DashboardAPIError, getAccount, listAllAccountTenants, listRegions, onboardTenant, type DashboardAccount, type Region } from "../../lib/dashboard-api";

export function TenantOnboarding() {
  const navigate = useNavigate();
  const [account, setAccount] = useState<DashboardAccount | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getAccount(), listAllAccountTenants(), listRegions()])
      .then(([nextAccount, tenants, nextRegions]) => {
        if (!active) return;
        if (tenants.length > 0) {
          void navigate({ to: "/home", replace: true });
          return;
        }
        setAccount(nextAccount);
        setRegions(nextRegions);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DashboardAPIError && cause.status === 401) void navigate({ to: "/sign-in", replace: true });
        else setError(cause instanceof Error ? cause.message : "Onboarding could not load");
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const result = await onboardTenant({ name: String(data.get("name") ?? ""), default_region: String(data.get("region") ?? "") });
      window.localStorage.setItem("chalk.tenant-hint", result.tenant.id);
      await navigate({ to: "/home", replace: true });
    } catch (cause) {
      setError(cause instanceof DashboardAPIError ? cause.message : "Tenant creation could not finish");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="tenant-onboarding">
      <header>
        <span className="tenant-onboarding-step">01 / 02</span>
        <span>{account ? `Signed in as ${account.email}` : "Checking your Account…"}</span>
      </header>
      <section>
        <div className="onboarding-copy">
          <p className="eyebrow">Your first Tenant</p>
          <h1>Name the boundary around your work.</h1>
          <p>A Tenant keeps your Spaces, access, and product defaults together. You can add more later.</p>
          <div className="onboarding-next">
            <span>Next</span>
            <strong>Create your first Space</strong>
          </div>
        </div>
        <form className="onboarding-card" onSubmit={submit}>
          <label>
            Tenant name
            <input name="name" required minLength={2} placeholder="Acme studio" autoFocus />
          </label>
          <label>
            Home region
            <select name="region" required defaultValue="">
              <option value="" disabled>
                Choose the closest region
              </option>
              {regions.map((region) => (
                <option value={region.code} key={region.code}>
                  {region.name}
                </option>
              ))}
            </select>
          </label>
          <p className="onboarding-help">The region sets the default for new Spaces. Tenant settings can change it later.</p>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="dashboard-button primary" type="submit" disabled={busy || !account}>
            {busy ? "Creating Tenant…" : "Create Tenant"}
          </button>
        </form>
      </section>
    </main>
  );
}
