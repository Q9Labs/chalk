import { reloadRejoinStorageKey, writeReloadRejoin, type ClientFailure } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PreparedPublicSpace, PublicSpaceCredential, SpaceAccessCleanupOptions } from "../../lib/chalk-access";
import { createLocalSpaceClient, createLocalSpaceRelease } from "../../lib/local-space-client";
import { problemReporter, type ReportProblem } from "../../lib/problem-reports";
import { useTheme } from "../../lib/theme-context";
import type { ExitPhase, SpaceEntryAccess } from "./SpacePage";

// The call UI and media stack, which SpacePage loads only once the participant asks to join.
export { ReportProblemDialog, StatusSurface } from "@q9labsai/chalk-react";

export function LocalSpace({
  reportCredential,
  reportCredentialExpiresAt,
  reportsAvailable,
  reportUnavailableReason,
  onOpenReportProblem,
  reloadMarker,
  credential,
  hostCanExtend,
  displayName,
  defaults,
  getAccess,
  connectionAccess,
  onFinish,
  spaceName,
  inviteLink,
  onTerminal,
}: {
  readonly reportCredential: () => string;
  readonly reportCredentialExpiresAt: () => number;
  readonly reportsAvailable: boolean;
  readonly reportUnavailableReason?: string;
  readonly onOpenReportProblem: (send: ReportProblem, diagnostics: string) => void;
  readonly reloadMarker: SpaceEntryAccess["reloadMarker"];
  readonly credential: PublicSpaceCredential;
  readonly hostCanExtend: boolean;
  readonly displayName: string;
  readonly defaults: {
    readonly microphone: boolean;
    readonly camera: boolean;
  };
  readonly getAccess: PreparedPublicSpace["getAccess"];
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly inviteLink?: string;
  readonly onFinish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
  readonly spaceName?: string;
  readonly onTerminal: (phase: ExitPhase, cleanup: () => Promise<void>, failure?: ClientFailure | null, reportProblem?: ReportProblem, reportExpiresAt?: number, endReason?: string) => void;
}) {
  const { mode, setPreference } = useTheme();
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess, connectionAccess }), [connectionAccess, credential, getAccess]);
  const release = useMemo(() => createLocalSpaceRelease(client, () => onFinish()), [client, onFinish]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const tenantId = reloadMarker().tenantId;
  const reportProblem = useMemo(() => problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: reportCredential, connection: () => client.getSnapshot().connection }), [credential.apiBaseURL, tenantId, reportCredential, client]);
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
      const terminalProof = reportCredential();
      onTerminal(phase, release, failure, problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: () => terminalProof, connection: () => ({ status: phase, lastError: failure ?? null }) }), reportCredentialExpiresAt(), client.getSnapshot().connection.episodeEndReason);
    },
    [client, onTerminal, release, credential.apiBaseURL, tenantId, reportCredential, reportCredentialExpiresAt],
  );
  useEffect(() => {
    if (connection.episodeEnded) releaseFromLifecycle("episode-ended");
    else if (connection.removedByHost) releaseFromLifecycle("removed");
    else if (connection.status === "failed") releaseFromLifecycle(connection.lastError?.code === "episode.ended" ? "episode-ended" : "failed", connection.lastError);
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
          ...reloadMarker(),
          space: globalThis.location.pathname.split("/").at(-1) ?? credential.space,
          displayName: snapshot.self.displayName ?? displayName,
          microphone: snapshot.media.local.microphone.state === "enabled",
          camera: snapshot.media.local.camera.state === "enabled",
        });
      } catch {
        // Without a recoverable tab marker, retain the existing release behavior.
        void onFinish({ keepalive: true }).catch(() => undefined);
      }
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [client, credential.space, displayName, onFinish, reloadMarker]);
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
        onReportProblem={reportsAvailable ? reportProblem : undefined}
        reportUnavailableReason={reportUnavailableReason}
        onOpenReportProblem={() => onOpenReportProblem(reportProblem, `Call: ${spaceName ?? "Call"}\nStatus: ${connection.status}`)}
        displayName={displayName}
        defaults={defaults}
        spaceName={spaceName}
        inviteLink={inviteLink}
        onEpisodeEnded={() => releaseFromLifecycle("episode-ended")}
        onLeft={() => {
          const latest = client.getSnapshot().connection;
          releaseFromLifecycle(latest.episodeEnded ? "episode-ended" : latest.removedByHost ? "removed" : "left");
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
