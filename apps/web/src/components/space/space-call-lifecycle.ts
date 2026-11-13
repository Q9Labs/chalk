import { reloadRejoinPresence, reloadRejoinStorageKey, sessionExit, writeReloadRejoin, type ClientFailure } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import type { createLocalSpaceClient } from "../../lib/local-space-client";
import { problemReporter } from "../../lib/problem-reports";
import type { EndedCall, ExitPhase } from "./entrance-machine";

type LocalSpaceClient = ReturnType<typeof createLocalSpaceClient>;
type Session = PublicSpaceAdmission["session"];

/** Releases the admission one tick after the call unmounts; a remount in the same tick (StrictMode) cancels it. */
function useDeferredRelease(release: () => Promise<void>) {
  const pendingRelease = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (pendingRelease.current !== undefined) {
      globalThis.clearTimeout(pendingRelease.current);
      pendingRelease.current = undefined;
    }
    return () => {
      pendingRelease.current = globalThis.setTimeout(() => {
        pendingRelease.current = undefined;
        void release().catch(() => undefined);
      }, 0);
    };
  }, [release]);
}

/** A tab that goes away while the call is live leaves a marker so the reload rejoins; without storage the admission is released. */
function usePageHideRejoin({ client, session, space, displayName, intentionallyLeft }: { readonly client: LocalSpaceClient; readonly session: Session; readonly space: string; readonly displayName: string; readonly intentionallyLeft: { readonly current: boolean } }) {
  useEffect(() => {
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (event.persisted || intentionallyLeft.current) return;
      const snapshot = client.getSnapshot();
      if (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") return;
      try {
        writeReloadRejoin(globalThis.sessionStorage, {
          ...session.reloadMarker(),
          space: globalThis.location.pathname.split("/").at(-1) ?? space,
          ...reloadRejoinPresence(snapshot, displayName),
        });
      } catch {
        // Without a recoverable tab marker, retain the existing release behavior.
        void session.leave({ keepalive: true }).catch(() => undefined);
      }
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [client, space, displayName, session, intentionallyLeft]);
}

type CallLifecycleInput = {
  readonly client: LocalSpaceClient;
  readonly session: Session;
  readonly credential: PublicSpaceAdmission["credential"];
  readonly tenantId: ReturnType<Session["reloadMarker"]>["tenantId"];
  readonly displayName: string;
  readonly spaceName?: string;
  readonly hostCanExtend: boolean;
  readonly onEnded: (call: EndedCall) => void;
};

/** How the call ends: one exit is reported to the page (once), and an admission is released when the call goes away. */
export function useCallLifecycle({ client, session, credential, tenantId, displayName, spaceName, hostCanExtend, onEnded }: CallLifecycleInput) {
  const release = useCallback(async () => {
    await client.close();
    await session.leave();
  }, [client, session]);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const intentionallyLeft = useRef(false);
  const endObserved = useRef(false);
  const releaseFromLifecycle = useCallback(
    (phase: ExitPhase, failure?: ClientFailure | null) => {
      if (endObserved.current) return;
      endObserved.current = true;
      intentionallyLeft.current = true;
      try {
        globalThis.sessionStorage.removeItem(reloadRejoinStorageKey);
      } catch {
        /* Storage may be disabled. */
      }
      const terminalProof = session.mediaProof();
      onEnded({
        phase,
        failure,
        release,
        hostCanExtend,
        tenantId,
        callName: spaceName,
        endReason: client.getSnapshot().connection.episodeEndReason,
        reportProblem: problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: () => terminalProof, connection: () => ({ status: phase, lastError: failure ?? null }) }),
        reportExpiresAt: session.mediaExpiresAt(),
      });
    },
    [client, onEnded, release, credential.apiBaseURL, tenantId, session, hostCanExtend, spaceName],
  );
  useEffect(() => {
    const exit = sessionExit(connection);
    if (exit) releaseFromLifecycle(exit, connection.status === "failed" ? connection.lastError : undefined);
  }, [connection, releaseFromLifecycle]);
  useDeferredRelease(release);
  usePageHideRejoin({ client, session, space: credential.space, displayName, intentionallyLeft });
  return {
    release,
    connection,
    onEpisodeEnded: () => releaseFromLifecycle("episode-ended"),
    onLeft: () => releaseFromLifecycle(sessionExit(client.getSnapshot().connection) ?? "left"),
    onJoined: () => {
      intentionallyLeft.current = false;
    },
  };
}
