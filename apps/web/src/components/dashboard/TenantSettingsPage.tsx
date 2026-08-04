import { useDashboardAccount } from "./DashboardAccount";

export function TenantSettingsPage() {
  const { current } = useDashboardAccount();
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
          <p>Settings remain read-only until the capability and recent-auth contract lands.</p>
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
    </div>
  );
}
