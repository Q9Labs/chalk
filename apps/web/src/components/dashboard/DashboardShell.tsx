import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useDashboardAccount } from "./DashboardAccount";
import { NewSpaceDialog } from "./NewSpaceDialog";

const primaryNavigation = [
  { to: "/home", label: "Home", icon: "home" },
  { to: "/spaces", label: "Spaces", icon: "spaces" },
  { to: "/episodes", label: "Episodes", icon: "episodes" },
  { to: "/artifacts", label: "Artifacts", icon: "artifacts" },
  { to: "/people", label: "People", icon: "people" },
] as const;

const utilityNavigation = [
  { to: "/developer", label: "Developer", icon: "developer" },
  { to: "/activity", label: "Activity", icon: "activity" },
] as const;

export function DashboardShell() {
  const [createOpen, setCreateOpen] = useState(false);
  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { account, current, tenants, selectTenant } = useDashboardAccount();
  const initials = account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand-row">
          <Link to="/home" className="dashboard-brand" aria-label="Chalk home">
            <img src="/brand/chalk/chalk-logo.svg" alt="" />
            <span>Chalk</span>
          </Link>
          <span className="dashboard-preview-label">Preview</span>
        </div>

        <div className="tenant-switcher-wrap">
          <button className="tenant-switcher" type="button" aria-label="Switch Tenant" aria-expanded={tenantMenuOpen} onClick={() => setTenantMenuOpen((open) => !open)}>
            <span className="tenant-mark">{current.tenant.name.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{current.tenant.name}</strong>
              <small>Tenant</small>
            </span>
            <Icon name="chevrons" />
          </button>
          {tenantMenuOpen ? (
            <div className="tenant-menu">
              <p>Your Tenants</p>
              {tenants.map((item) => (
                <button
                  type="button"
                  className={item.tenant.id === current.tenant.id ? "is-selected" : ""}
                  key={item.tenant.id}
                  onClick={() => {
                    selectTenant(item.tenant.id);
                    setTenantMenuOpen(false);
                  }}
                >
                  <span>{item.tenant.name.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{item.tenant.name}</strong>
                    <small>{item.access.role}</small>
                  </span>
                </button>
              ))}
              <Link to="/tenant" onClick={() => setTenantMenuOpen(false)}>
                Manage current Tenant
              </Link>
            </div>
          ) : null}
        </div>

        <button className="dashboard-create-button" type="button" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" />
          New Space
          <kbd>N</kbd>
        </button>

        <nav className="dashboard-nav" aria-label="Product">
          {primaryNavigation.map((item) => (
            <DashboardLink key={item.to} {...item} pathname={pathname} />
          ))}
        </nav>

        <nav className="dashboard-nav dashboard-nav-utility" aria-label="Tools">
          <p>Tools</p>
          {utilityNavigation.map((item) => (
            <DashboardLink key={item.to} {...item} pathname={pathname} />
          ))}
        </nav>

        <div className="dashboard-sidebar-footer">
          <Link to="/tenant" className={pathname === "/tenant" ? "is-active" : ""}>
            <Icon name="settings" />
            Tenant settings
          </Link>
          <Link to="/account" className="account-switcher">
            <span className="avatar">{initials}</span>
            <span>
              <strong>{account.name}</strong>
              <small>{account.email}</small>
            </span>
            <Icon name="dots" />
          </Link>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-mobile-header">
          <Link to="/home" className="dashboard-brand">
            <span>Chalk</span>
          </Link>
          <button type="button" onClick={() => setCreateOpen(true)}>
            New Space
          </button>
        </header>
        <Outlet />
      </main>

      <NewSpaceDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function DashboardLink({ to, label, icon, pathname }: { to: string; label: string; icon: string; pathname: string }) {
  return (
    <Link to={to} className={pathname === to ? "is-active" : ""}>
      <Icon name={icon} />
      {label}
    </Link>
  );
}

export function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5M9 21v-7h6v7" />
      </>
    ),
    spaces: (
      <>
        <rect x="3" y="4" width="7" height="7" rx="1" />
        <rect x="14" y="4" width="7" height="7" rx="1" />
        <rect x="3" y="15" width="7" height="6" rx="1" />
        <rect x="14" y="15" width="7" height="6" rx="1" />
      </>
    ),
    episodes: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8 6 4-6 4Z" />
      </>
    ),
    artifacts: (
      <>
        <path d="M6 3h9l4 4v14H6Z" />
        <path d="M14 3v5h5M9 13h6M9 17h6" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20v-2a5.5 5.5 0 0 1 11 0v2M16 5.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 3.5 4.8V20" />
      </>
    ),
    developer: (
      <>
        <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    chevrons: (
      <>
        <path d="m8 9 4-4 4 4M16 15l-4 4-4-4" />
      </>
    ),
    dots: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M14 7l5 5-5 5" />
      </>
    ),
  };

  return (
    <svg className="dashboard-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
