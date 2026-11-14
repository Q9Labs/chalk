import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { DashboardRequestError, failureKind, loadSession, needsSignIn } from "../../lib/dashboard/client";
import { backoffMs } from "../../lib/backoff";

function useSignInRedirect(): () => void {
  const router = useRouter();
  return useCallback(() => {
    const { pathname, searchStr } = router.state.location;
    // The connect page is the only dashboard page whose query must survive sign-in.
    const returnTo = pathname === "/dashboard/connect" ? pathname + searchStr : pathname;
    if (returnTo.startsWith("/dashboard/sign-in")) return;
    void router.navigate({ to: "/dashboard/sign-in", search: { returnTo } });
  }, [router]);
}

type Load<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "ready"; readonly data: T };

export class Change<T> {
  constructor(readonly apply: (current: T) => T) {}
}

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
          const delay = error instanceof DashboardRequestError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : backoffMs(failures + 1, interval, 30000);
          retryAt = Date.now() + delay;
          // A failed background read keeps ready data on screen. Any other failure replaces it, so a later update can't
          // bring the old data back over the error.
          if (background && kind === "transient" && ready.current !== undefined) return;
          ready.current = undefined;
          setState({ kind: "error", error });
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
