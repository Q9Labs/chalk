import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { DashboardRequestError, errorMessage, failureKind, loadSession, needsSignIn, signOut } from "../../lib/dashboard/client";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
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

/** A polling answer applied to the page's latest data, so a write made while the read was in flight is kept and no answer is dropped. */
export class Change<T> {
  constructor(readonly apply: (current: T) => T) {}
}

/** Loads a page; optional polling keeps ready data on screen, including after a failed refresh. */
export function useLoad<T>(load: () => Promise<T>, key: string, polling?: { interval: (data: T) => number | undefined; read: (data: T) => Promise<T | Change<T> | null>; visibility?: "status" }) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const toSignIn = useSignInRedirect();
  const latest = useRef({ load, polling });
  const ready = useRef<T | undefined>(undefined);
  const invalidate = useRef(() => {});
  const refresh = useRef<(options?: { force?: boolean; background?: boolean; status?: boolean }) => void>(() => {});
  const resumeAfter = useRef(0);
  latest.current = { load, polling };
  if (state.kind === "ready") ready.current = state.data;
  useEffect(() => {
    let current = true;
    // Full reads started: an answer from before the newest one is superseded by it.
    let loads = 0;
    // Writes made on the page: an answer built from older data can't overwrite one, but a Change applies on top.
    let writes = 0;
    let inFlight: { kind: "status" | "load"; loads: number; writes: number } | null = null;
    let stopped = false;
    let failures = 0;
    let retryAt = 0;
    invalidate.current = () => {
      writes++;
      if (inFlight?.kind !== "load") return;
      loads++;
      inFlight = null;
    };
    ready.current = undefined;
    setState({ kind: "loading" });
    refresh.current = ({ force = false, background = true, status = false } = {}) => {
      if (stopped || (background && Date.now() < retryAt) || (inFlight && !force)) return;
      const poll = status ? latest.current.polling : undefined;
      const from = ready.current;
      const request = poll && from !== undefined ? { kind: "status" as const, loads, writes } : { kind: "load" as const, loads: ++loads, writes };
      inFlight = request;
      const read = async (): Promise<{ data: T } | { change: Change<T> }> => {
        if (poll && from !== undefined) {
          const answer = await poll.read(from);
          if (answer instanceof Change) return { change: answer };
          if (answer !== null) return { data: answer };
          request.kind = "load";
          request.loads = ++loads;
        }
        return { data: await latest.current.load() };
      };
      read().then(
        (answer) => {
          if (!current) return;
          if (inFlight === request) inFlight = null;
          if (request.loads !== loads || ("data" in answer && request.kind === "status" && request.writes !== writes)) return;
          failures = 0;
          retryAt = 0;
          // The latest data moves at once, so the next read starts from this answer whenever React renders it.
          const data = "data" in answer ? answer.data : ready.current === undefined ? undefined : answer.change.apply(ready.current);
          if (data === undefined || data === ready.current) return;
          ready.current = data;
          setState({ kind: "ready", data });
        },
        (error: unknown) => {
          if (!current) return;
          if (inFlight === request) inFlight = null;
          if (request.loads !== loads) return;
          const kind = failureKind(error);
          if (kind === "sign-in") {
            // Nothing else can be read until the person signs in again.
            stopped = true;
            toSignIn();
            return;
          }
          failures = Math.min(failures + 1, 10);
          const interval = ready.current === undefined ? 5000 : (latest.current.polling?.interval(ready.current) ?? 5000);
          const delay = error instanceof DashboardRequestError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : Math.min(interval * 2 ** failures, 30000);
          retryAt = Date.now() + delay;
          const terminal = kind === "terminal";
          if (terminal) ready.current = undefined;
          setState((value) => (background && !terminal && value.kind === "ready" ? value : { kind: "error", error }));
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
    const timer = interval === undefined ? undefined : window.setInterval(visibleRefresh, interval);
    const becameVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (latest.current.polling?.visibility !== "status") return refresh.current({ force: true });
      // A status page reads only at its paced rate and one read at a time: a running tick picks up within one period,
      // and an idle page reads at most once per period. A resume never cuts off a read in flight.
      if (timer !== undefined || Date.now() < resumeAfter.current) return;
      resumeAfter.current = Date.now() + 5000;
      refresh.current({ status: true });
    };
    document.addEventListener("visibilitychange", becameVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", becameVisible);
    };
  }, [interval, observes]);
  const reload = useCallback(() => refresh.current({ force: true, background: false }), []);
  const update = useCallback((change: (data: T) => T, options: { refresh?: boolean } = {}) => {
    invalidate.current();
    if (ready.current !== undefined) {
      const data = change(ready.current);
      ready.current = data;
      setState({ kind: "ready", data });
    }
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
