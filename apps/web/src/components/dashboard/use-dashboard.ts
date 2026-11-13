import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileDTO } from "../../lib/dashboard/contracts";
import { loadSession, needsSignIn } from "../../lib/dashboard/client";
import { LoadMachine, type Load, type Polling } from "./load-machine";

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

export function useLoad<T>(load: () => Promise<T>, key: string, polling?: Polling<T>) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const toSignIn = useSignInRedirect();
  const latest = useRef({ load, polling });
  const ready = useRef<T | undefined>(undefined);
  const machine = useRef<LoadMachine<T> | undefined>(undefined);
  const resumeAfter = useRef(0);
  latest.current = { load, polling };
  if (state.kind === "ready") ready.current = state.data;
  useEffect(() => {
    const next = new LoadMachine<T>({ ready, load: () => latest.current.load(), polling: () => latest.current.polling, emit: setState, signIn: toSignIn });
    machine.current = next;
    next.start();
    return () => next.dispose();
  }, [key, toSignIn]);
  const interval = state.kind === "ready" ? polling?.interval(state.data) : undefined;
  const observes = polling !== undefined;
  useEffect(() => {
    if (!observes) return;
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") machine.current?.refresh({ status: true });
    };
    const timer = interval === undefined ? undefined : window.setInterval(visibleRefresh, interval);
    const becameVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (latest.current.polling?.visibility !== "status") return machine.current?.refresh({ force: true });
      // A status page reads only at its paced rate and one read at a time: a running tick picks up within one period,
      // and an idle page reads at most once per period. A resume never cuts off a read in flight.
      if (timer !== undefined || Date.now() < resumeAfter.current) return;
      resumeAfter.current = Date.now() + 5000;
      machine.current?.refresh({ status: true });
    };
    document.addEventListener("visibilitychange", becameVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", becameVisible);
    };
  }, [interval, observes]);
  const reload = useCallback(() => machine.current?.refresh({ force: true, background: false }), []);
  const update = useCallback((change: (data: T) => T, options: { refresh?: boolean } = {}) => {
    machine.current?.invalidate();
    if (ready.current !== undefined) {
      const data = change(ready.current);
      ready.current = data;
      setState({ kind: "ready", data });
    }
    // Discard stale reads for every update; only writes need a fresh server read.
    if (options.refresh !== false && latest.current.polling) machine.current?.refresh({ force: true });
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
