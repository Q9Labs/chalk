import { useEffect, useRef, useState, type FormEvent } from "react";
import { DashboardAPIError, updateTenantCORSAllowedOrigins } from "../../lib/dashboard-api";
import { useDashboardAccount } from "./DashboardAccount";

export function TenantSettingsPage() {
  const { current, updateCurrentTenant } = useDashboardAccount();
  const [origins, setOrigins] = useState(() => formatOrigins(current.tenant.cors_allowed_origins));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canEdit = current.access.role !== "observer";
  const currentTenantID = useRef(current.tenant.id);
  currentTenantID.current = current.tenant.id;

  useEffect(() => {
    setOrigins(formatOrigins(current.tenant.cors_allowed_origins));
    setError(null);
    setSaved(false);
  }, [current.tenant.id, current.tenant.cors_allowed_origins]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const submittedTenantID = current.tenant.id;
    try {
      const tenant = await updateTenantCORSAllowedOrigins(submittedTenantID, parseOrigins(origins));
      updateCurrentTenant(tenant);
      if (currentTenantID.current !== submittedTenantID) return;
      setOrigins(formatOrigins(tenant.cors_allowed_origins));
      setSaved(true);
    } catch (cause: unknown) {
      if (currentTenantID.current !== submittedTenantID) return;
      setError(cause instanceof DashboardAPIError ? cause.message : "The Tenant CORS policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dashboard-page resource-page settings-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">{current.tenant.name}</p>
          <h1>Tenant settings</h1>
          <p>Identity and deployment defaults for this customer boundary.</p>
        </div>
      </header>
      <section className="settings-panel">
        <div>
          <p className="eyebrow">Tenant identity</p>
          <h2>{current.tenant.name}</h2>
          <p>Tenant identity remains read-only. Cross-origin browser access can be managed below.</p>
        </div>
        <dl>
          <div>
            <dt>Home region</dt>
            <dd>{current.tenant.default_region ?? "Not set"}</dd>
          </div>
          <div>
            <dt>Your access</dt>
            <dd>{current.access.role}</dd>
          </div>
          <div>
            <dt>Tenant ID</dt>
            <dd>{current.tenant.id}</dd>
          </div>
        </dl>
      </section>
      <section className="settings-panel">
        <div>
          <p className="eyebrow">Browser access</p>
          <h2>Allowed origins</h2>
          <p>Requests to this Tenant’s API routes are allowed only from these exact browser origins.</p>
        </div>
        <form className="tenant-cors-form" onSubmit={(event) => void save(event)}>
          <label htmlFor="tenant-cors-origins">One origin per line</label>
          <textarea
            id="tenant-cors-origins"
            value={origins}
            onChange={(event) => {
              setOrigins(event.target.value);
              setSaved(false);
            }}
            placeholder={"https://app.example.com\nhttp://localhost:3070"}
            rows={7}
            disabled={!canEdit || saving}
            aria-describedby="tenant-cors-help tenant-cors-status"
          />
          <p id="tenant-cors-help" className="tenant-cors-help">
            Use HTTPS for hosted apps. HTTP is accepted only for localhost or loopback addresses, and each port is a separate origin. Wildcards are not accepted.
          </p>
          {error ? (
            <p id="tenant-cors-status" className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p id="tenant-cors-status" className="tenant-cors-success" role="status">
              Tenant CORS policy saved.
            </p>
          ) : null}
          {!canEdit ? (
            <p id="tenant-cors-status" className="tenant-cors-help">
              Observer access cannot change Tenant settings.
            </p>
          ) : null}
          <button className="dashboard-button primary" type="submit" disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save allowed origins"}
          </button>
        </form>
      </section>
    </div>
  );
}

function parseOrigins(value: string): string[] {
  return value
    .split("\n")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function formatOrigins(origins: readonly string[] | undefined): string {
  return (origins ?? []).join("\n");
}
