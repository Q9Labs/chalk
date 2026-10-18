import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { errorMessage, loadSession, needsSignIn, signOut } from "../../lib/dashboard/client";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Lockup } from "../site/Lockup";
import { useSiteTheme } from "../site/theme";
import { ErrorPanel, Menu, MenuItem, Seg, useToast } from "./kit";

/** Sends the person to sign in, coming back to where they were. */
function useSignInRedirect(): () => void {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return useCallback(() => void navigate({ to: "/dashboard/sign-in", search: { returnTo: pathname } }), [navigate, pathname]);
}

type Load<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "ready"; readonly data: T };

/** Loads one page's data when `key` changes. A session that can't be refreshed goes to sign-in. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const toSignIn = useSignInRedirect();
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    latest.current().then(
      (data) => current && setState({ kind: "ready", data }),
      (error: unknown) => {
        if (!current) return;
        if (needsSignIn(error)) toSignIn();
        else setState({ kind: "error", error });
      },
    );
    return () => {
      current = false;
    };
  }, [key, attempt, toSignIn]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const update = useCallback((change: (data: T) => T) => setState((value) => (value.kind === "ready" ? { kind: "ready", data: change(value.data) } : value)), []);
  return { state, reload, update };
}

/** The signed-in person, or the failure that stopped the session check. Sends a signed-out person to sign in. */
export function useSession() {
  const [profile, setProfile] = useState<ProfileDTO | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const toSignIn = useSignInRedirect();
  useEffect(() => {
    let current = true;
    setFailure(null);
    loadSession().then(
      (session) => current && setProfile(session.profile),
      (error: unknown) => {
        if (!current) return;
        if (needsSignIn(error)) toSignIn();
        else setFailure(error);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, toSignIn]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { profile, failure, retry };
}

/** The signed-in dashboard: checks the session, then draws the top bar around the page. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const { profile, failure, retry } = useSession();
  return (
    <div className="app">
      <TopBar profile={profile} />
      <main className="main">
        {profile ? (
          children
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
  const developer = pathname.startsWith("/dashboard/developer");
  return (
    <header className="topb">
      <Link to="/dashboard" aria-label="Chalk, Home">
        <Lockup />
      </Link>
      <nav className="ttabs" aria-label="Dashboard">
        <Link to="/dashboard" activeOptions={{ exact: true }} aria-current={developer ? undefined : "page"}>
          Home
        </Link>
        <Link to="/dashboard/developer" aria-current={developer ? "page" : undefined}>
          Developer
        </Link>
      </nav>
      <div className="acct">{profile ? <AccountMenu profile={profile} /> : null}</div>
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
