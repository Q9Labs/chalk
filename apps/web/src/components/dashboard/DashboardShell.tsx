import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Logo } from "@q9labsai/chalk-react";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@q9labsai/chalk-ui";
import { useDashboardAccount } from "./DashboardAccount";
import { DashboardSidebar } from "./DashboardSidebar";
import { NewSpaceDialog } from "./NewSpaceDialog";

export function DashboardShell() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { current } = useDashboardAccount();

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

  return (
    <SidebarProvider className="dashboard-shell">
      <a className="dashboard-skip-link" href="#dashboard-content">
        Skip to dashboard content
      </a>

      <DashboardSidebar pathname={pathname} onCreateSpace={() => setCreateOpen(true)} />

      <SidebarInset id="dashboard-content">
        <DashboardMobileHeader onCreateSpace={() => setCreateOpen(true)} />
        <Outlet />
      </SidebarInset>

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
    </SidebarProvider>
  );
}

/** Only mounts below the sidebar's drawer breakpoint, where the rail is unavailable. */
function DashboardMobileHeader({ onCreateSpace }: { onCreateSpace: () => void }) {
  const { isMobile } = useSidebar();
  if (!isMobile) return null;

  return (
    <header className="dashboard-mobile-header">
      <SidebarTrigger className="dashboard-mobile-menu" />
      <Link to="/home" className="dashboard-brand">
        <Logo accessibilityLabel={null} color="currentColor" height={22} motion="orbit-burst" variant="mark" />
        <span>Chalk</span>
      </Link>
      <button className="dashboard-mobile-create" type="button" onClick={onCreateSpace}>
        New Space
      </button>
    </header>
  );
}

export function ResourcePageHeader({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <header className="dashboard-page-header resource-heading">
      <div>
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
