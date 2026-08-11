import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useDashboardAccount } from "./DashboardAccount";
import { NewSpaceDialog } from "./NewSpaceDialog";

const primaryNavigation = [
  { to: "/home", label: "Overview", icon: "home" },
  { to: "/spaces", label: "Spaces", icon: "spaces" },
  { to: "/episodes", label: "Episodes", icon: "episodes" },
] as const;

const utilityNavigation = [{ to: "/developer", label: "Developer", icon: "developer" }] as const;

export function DashboardShell() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { account, current, tenants, selectTenant } = useDashboardAccount();
  const initials = account.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  useEffect(() => {
    const openCreateDialog = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey || (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']"))) return;
      event.preventDefault();
      setCreateOpen(true);
    };
    window.addEventListener("keydown", openCreateDialog);
    return () => window.removeEventListener("keydown", openCreateDialog);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <div className="dashboard-shell">
      <a className="dashboard-skip-link" href="#dashboard-content">
        Skip to dashboard content
      </a>
      <aside className={`dashboard-sidebar${mobileNavOpen ? " is-open" : ""}`} aria-label="Dashboard navigation">
        <div className="dashboard-brand-row">
          <Link to="/home" className="dashboard-brand" aria-label="Chalk home">
            <img src="/brand/chalk/chalk-logo.svg" alt="" />
            <span>Chalk</span>
          </Link>
          <button className="dashboard-sidebar-close" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>
            ×
          </button>
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

        <nav className="dashboard-nav" aria-label="Workspace">
          <p>Workspace</p>
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

      {mobileNavOpen ? <button className="dashboard-sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} /> : null}

      <main className="dashboard-main" id="dashboard-content">
        <header className="dashboard-mobile-header">
          <button className="dashboard-mobile-menu" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}>
            <Icon name="menu" />
          </button>
          <Link to="/home" className="dashboard-brand">
            <span>Chalk</span>
          </Link>
          <button className="dashboard-mobile-create" type="button" onClick={() => setCreateOpen(true)}>
            New Space
          </button>
        </header>
        <Outlet />
      </main>

      <NewSpaceDialog
        open={createOpen}
        tenantID={current.tenant.id}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          window.dispatchEvent(new Event("chalk:spaces-refresh"));
          void navigate({ to: "/spaces" });
        }}
      />
    </div>
  );
}

function DashboardLink({ to, label, icon, pathname }: { to: string; label: string; icon: string; pathname: string }) {
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link to={to} className={active ? "is-active" : ""} aria-current={active ? "page" : undefined}>
      <Icon name={icon} />
      {label}
    </Link>
  );
}

export function ResourcePageHeader({ eyebrow, title, description, actionLabel, onAction }: { eyebrow: string; title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <header className="dashboard-page-header resource-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <button className="dashboard-button primary" type="button" onClick={onAction}>
        <Icon name="plus" />
        {actionLabel}
      </button>
    </header>
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
    menu: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
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
