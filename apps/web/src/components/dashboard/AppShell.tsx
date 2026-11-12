import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { errorMessage, signOut } from "../../lib/dashboard/client";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Lockup } from "../site/Lockup";
import { useSiteTheme } from "../site/theme";
import { ErrorPanel, Menu, MenuItem, Seg, useToast } from "./kit";
import { useSession } from "./use-dashboard";

/** The signed-in dashboard: checks the session, then draws the top bar around the page. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const { profile, failure, retry } = useSession();
  return (
    <div className="app">
      <TopBar profile={profile} />
      <main className="main">
        {profile ? (
          <>
            <div className="wrap">
              <PrivacyNotice />
            </div>
            {children}
          </>
        ) : failure ? (
          <div className="wrap">
            <ErrorPanel title="Couldn’t open your dashboard" detail={errorMessage(failure)} onRetry={retry} />
          </div>
        ) : null}
      </main>
    </div>
  );
}

function TopBar({ profile }: { readonly profile: ProfileDTO | null }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = pathname.startsWith("/dashboard/developer") ? "developer" : pathname.startsWith("/dashboard/apps") ? "apps" : pathname.startsWith("/dashboard/sessions") || pathname.includes("/session/") ? "sessions" : pathname.startsWith("/dashboard/recordings") ? "recordings" : "home";
  return (
    <header className="topb">
      <Link to="/dashboard" activeOptions={{ exact: true }} aria-label="Chalk, Home">
        <Lockup />
      </Link>
      <nav className="ttabs" aria-label="Dashboard">
        <Link to="/dashboard" activeOptions={{ exact: true }} aria-label="Home" aria-current={section === "home" ? "page" : undefined}>
          <Icon name="home" size={16} />
          <span>Home</span>
        </Link>
        <Link to="/dashboard/sessions" aria-label="Sessions" aria-current={section === "sessions" ? "page" : undefined}>
          <Icon name="calendar" size={16} />
          <span>Sessions</span>
        </Link>
        <Link to="/dashboard/recordings" aria-label="Recordings" aria-current={section === "recordings" ? "page" : undefined}>
          <Icon name="film" size={16} />
          <span>Recordings</span>
        </Link>
        <Link to="/dashboard/apps" aria-label="AI apps" aria-current={section === "apps" ? "page" : undefined}>
          <Icon name="grid" size={16} />
          <span>AI apps</span>
        </Link>
        <Link to="/dashboard/developer" aria-label="Developer" aria-current={section === "developer" ? "page" : undefined}>
          <Icon name="code" size={16} />
          <span>Developer</span>
        </Link>
      </nav>
      <div className="acct">
        <Link to="/docs" className="docs">
          <Icon name="book" size={16} />
          Docs
        </Link>
        {profile ? <AccountMenu profile={profile} /> : null}
      </div>
    </header>
  );
}

function AccountMenu({ profile }: { readonly profile: ProfileDTO }) {
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const toast = useToast();
  async function leave() {
    try {
      await signOut();
      void navigate({ to: "/dashboard/sign-in" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  return (
    <Menu
      label={`Account: ${profile.name}`}
      trigger={({ open, toggle }) => (
        <button type="button" className="avb" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${profile.name}`} onClick={toggle}>
          <Avatar name={profile.name} size={32} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="mhd">
            <Avatar name={profile.name} size={36} />
            <div>
              <b>{profile.name}</b>
              <small>{profile.email}</small>
            </div>
          </div>
          <div className="msep" />
          <div className="mrow" role="group" aria-labelledby="appearance-label">
            <span id="appearance-label">
              <Icon name={theme === "dark" ? "moon" : "sun"} />
              Appearance
            </span>
            <Seg
              small
              labelledBy="appearance-label"
              options={[
                ["dark", "Dark"],
                ["light", "Light"],
              ]}
              value={theme}
              onChange={setTheme}
            />
          </div>
          <div className="msep" />
          <MenuItem
            icon="logout"
            onSelect={() => {
              close();
              void leave();
            }}
          >
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
