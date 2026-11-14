import { reloadRejoinPresence, reloadRejoinStorageKey, sessionExit, writeReloadRejoin, type ClientFailure, type JoinOptions } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import { createLocalSpaceClient } from "../../lib/local-space-client";
import { problemReporter, type ReportProblem } from "../../lib/problem-reports";
import { useTheme } from "../../lib/theme-context";
import type { EndedCall, ExitPhase } from "./entrance-machine";

// The call UI and media stack, which SpacePage loads only once the participant asks to join.
export { ReportProblemDialog, StatusSurface } from "@q9labsai/chalk-react";

export function LocalSpace({
  admission,
  reportUnavailableReason,
  onOpenReportProblem,
  displayName,
  defaults,
  spaceName,
  inviteLink,
  onEnded,
}: {
  readonly admission: PublicSpaceAdmission;
  readonly reportUnavailableReason?: string;
  readonly onOpenReportProblem: (send: ReportProblem, diagnostics: string) => void;
  readonly displayName: string;
  readonly defaults: Pick<JoinOptions, "microphone" | "camera" | "microphoneDeviceId" | "cameraDeviceId" | "speakerDeviceId">;
  readonly inviteLink?: string;
  readonly spaceName?: string;
  readonly onEnded: (call: EndedCall) => void;
}) {
  const { mode, setPreference } = useTheme();
  const { session, credential, arrival } = admission;
  const hostCanExtend = (arrival.space?.maximum_episode_duration_seconds ?? 3600) > 3600;
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess: session.getAccess, connectionAccess: session.connectionAccess }), [credential, session]);
  const release = useCallback(async () => {
    await client.close();
    await session.leave();
  }, [client, session]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const tenantId = session.reloadMarker().tenantId;
  const reportProblem = useMemo(() => problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: session.mediaProof, connection: () => client.getSnapshot().connection }), [credential.apiBaseURL, tenantId, session, client]);
  const pendingRelease = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
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
  useEffect(() => {
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (event.persisted || intentionallyLeft.current) return;
      const snapshot = client.getSnapshot();
      if (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") return;
      try {
        writeReloadRejoin(globalThis.sessionStorage, {
          ...session.reloadMarker(),
          space: globalThis.location.pathname.split("/").at(-1) ?? credential.space,
          ...reloadRejoinPresence(snapshot, displayName),
        });
      } catch {
        // Without a recoverable tab marker, retain the existing release behavior.
        void session.leave({ keepalive: true }).catch(() => undefined);
      }
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [client, credential.space, displayName, session]);
  return (
    <main className="h-full min-h-0 w-full overflow-hidden">
      {homeError ? <p role="alert">{homeError}</p> : null}
      <Chalk
        timeLimit={{
          message: hostCanExtend ? "The host can extend this call." : "Sign up free for calls up to 24 hours.",
          action: hostCanExtend ? undefined : { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") },
          endAction: hostCanExtend ? undefined : { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") },
        }}
        theme={{ colorScheme: mode }}
        onColorSchemeChange={setPreference}
        client={client}
        onReportProblem={reportProblem}
        reportUnavailableReason={reportUnavailableReason}
        onOpenReportProblem={() => onOpenReportProblem(reportProblem, `Call: ${spaceName ?? "Call"}\nStatus: ${connection.status}`)}
        displayName={displayName}
        defaults={defaults}
        spaceName={spaceName}
        inviteLink={inviteLink}
        onEpisodeEnded={() => releaseFromLifecycle("episode-ended")}
        onLeft={() => {
          releaseFromLifecycle(sessionExit(client.getSnapshot().connection) ?? "left");
        }}
        onJoined={() => {
          intentionallyLeft.current = false;
        }}
        onHome={() => {
          void release()
            .then(() => globalThis.location.assign("/"))
            .catch(() => setHomeError("Couldn’t leave the call. Try Home again."));
        }}
      />
    </main>
  );
}
