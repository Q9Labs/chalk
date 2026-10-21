import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { DashboardRequestError, errorMessage, loadSession, needsSignIn, signOut } from "../../lib/dashboard/client";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Lockup } from "../site/Lockup";
import { useSiteTheme } from "../site/theme";
import { ErrorPanel, Menu, MenuItem, Seg, useToast } from "./kit";

/** Sends the person to sign in, coming back to where they were. Stable, and does nothing once there. */
function useSignInRedirect(): () => void {
  const router = useRouter();
  return useCallback(() => {
    const returnTo = router.state.location.pathname;
    if (returnTo.startsWith("/dashboard/sign-in")) return;
    void router.navigate({ to: "/dashboard/sign-in", search: { returnTo } });
  }, [router]);
}

type Load<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "ready"; readonly data: T };

/** Loads a page; optional polling keeps ready data on screen, including after a failed refresh. */
export function useLoad<T>(load: () => Promise<T>, key: string, polling?: { interval: (data: T) => number | undefined; read: (data: T) => Promise<T | null>; visibility?: "status" }) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const toSignIn = useSignInRedirect();
  const latest = useRef({ load, polling });
  const ready = useRef<T | undefined>(undefined);
  const invalidate = useRef(() => {});
  const refresh = useRef<(options?: { force?: boolean; background?: boolean; status?: boolean }) => void>(() => {});
  latest.current = { load, polling };
  if (state.kind === "ready") ready.current = state.data;
  useEffect(() => {
    let current = true;
    let revision = 0;
    let pending = false;
    let failures = 0;
    let retryAt = 0;
    invalidate.current = () => {
      revision++;
      pending = false;
    };
    ready.current = undefined;
    setState({ kind: "loading" });
    refresh.current = ({ force = false, background = true, status = false } = {}) => {
      if (background && Date.now() < retryAt) return;
      if (pending && !force) return;
      pending = true;
      const request = ++revision;
      const read = async () => {
        if (status && latest.current.polling && ready.current !== undefined) {
          const data = await latest.current.polling.read(ready.current);
          if (!current || request !== revision) return;
          if (data !== null) return data;
        }
        return latest.current.load();
      };
      read().then(
        (data) => {
          if (!current || request !== revision || data === undefined) return;
          pending = false;
          failures = 0;
          retryAt = 0;
          ready.current = data;
          setState({ kind: "ready", data });
        },
        (error: unknown) => {
          if (!current || request !== revision) return;
          pending = false;
          failures = Math.min(failures + 1, 10);
          const interval = ready.current === undefined ? 5000 : (latest.current.polling?.interval(ready.current) ?? 5000);
          const delay = error instanceof DashboardRequestError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : Math.min(interval * 2 ** failures, 30000);
          retryAt = Date.now() + delay;
          const terminal = error instanceof DashboardRequestError && [403, 404, 410].includes(error.status);
          if (terminal) ready.current = undefined;
          if (needsSignIn(error)) toSignIn();
          else setState((value) => (background && !terminal && value.kind === "ready" ? value : { kind: "error", error }));
        },
      );
    };
    refresh.current();
    return () => {
      current = false;
      invalidate.current = () => {};
      refresh.current = () => {};
    };
  }, [key, toSignIn]);
  const interval = state.kind === "ready" ? polling?.interval(state.data) : undefined;
  const observes = polling !== undefined;
  useEffect(() => {
    if (!observes) return;
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") refresh.current({ status: true });
    };
    const becameVisible = () => {
      if (document.visibilityState === "visible") refresh.current({ force: true, status: latest.current.polling?.visibility === "status" });
    };
    const timer = interval === undefined ? undefined : window.setInterval(visibleRefresh, interval);
    document.addEventListener("visibilitychange", becameVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", becameVisible);
    };
  }, [interval, observes]);
  const reload = useCallback(() => refresh.current({ force: true, background: false }), []);
  const update = useCallback((change: (data: T) => T, options: { refresh?: boolean } = {}) => {
    invalidate.current();
    setState((value) => (value.kind === "ready" ? { kind: "ready", data: change(value.data) } : value));
    // Discard stale reads for every update; only writes need a fresh server read.
    if (options.refresh !== false && latest.current.polling) refresh.current({ force: true });
  }, []);
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
