import { canExtendCall, reloadRejoinPresence, reloadRejoinStorageKey, sessionExit, writeReloadRejoin, type ClientFailure, type JoinOptions } from "@q9labsai/chalk-client";
import { Chalk, ReportProblemDialog, StatusSurface, reportDiagnostics, statusFailure } from "@q9labsai/chalk-react";
import { callAnnotation } from "../../lib/screen-annotation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { publicAPIBaseURL, type PublicSpaceAdmission } from "../../lib/chalk-access";
import { accountWouldAllowLonger, signUpOffer } from "../../lib/call-policy";
import { createLocalSpaceClient } from "../../lib/local-space-client";
import { onPageFailure } from "../../lib/chunkReload";
import { CallErrorBoundary } from "./CallErrorBoundary";
import { problemReporter, type ReportProblem } from "../../lib/send-problem-report";
import { reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired } from "../../lib/problem-reports";
import { useTheme } from "../../lib/theme-context";
import type { EndedCall, ExitPhase } from "./entrance-machine";

// The call UI and media stack, which SpacePage loads only once the participant asks to join.
export { ReportProblemDialog, reportDiagnostics, StatusSurface, statusFailure } from "@q9labsai/chalk-react";

export function LocalSpace({
  admission,
  onOpenReportProblem,
  displayName,
  defaults,
  spaceName,
  inviteLink,
  onEnded,
}: {
  readonly admission: PublicSpaceAdmission;
  readonly onOpenReportProblem: (send: ReportProblem, diagnostics: string) => void;
  readonly displayName: string;
  readonly defaults: Pick<JoinOptions, "microphone" | "camera" | "microphoneDeviceId" | "cameraDeviceId" | "speakerDeviceId">;
  readonly inviteLink?: string;
  readonly spaceName?: string;
  readonly onEnded: (call: EndedCall) => void;
}) {
  const { mode, setPreference } = useTheme();
  const { session, credential, arrival } = admission;
  const maximumSeconds = arrival.space?.maximum_episode_duration_seconds;
  const offerSignUp = accountWouldAllowLonger(maximumSeconds);
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess: session.getAccess, connectionAccess: session.connectionAccess }), [credential, session]);
  const signUp = { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") };
  const release = useCallback(async () => {
    await client.close();
    await session.leave();
  }, [client, session]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const tenantId = session.reloadMarker().tenantId;
  const subscribeReportAccess = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const reportAccessExpiry = useCallback(() => session.mediaExpiresAt(), [session]);
  const reportExpiresAt = useSyncExternalStore(subscribeReportAccess, reportAccessExpiry, reportAccessExpiry);
  const reportExpired = useReportCredentialExpired(reportExpiresAt);
  const reportsAvailable = useProblemReports(credential.apiBaseURL, tenantId);
  const annotation = useMemo(() => callAnnotation({ apiBaseUrl: credential.apiBaseURL, tenantId, mediaProof: session.mediaProof, client }), [credential.apiBaseURL, tenantId, session, client]);
  const reportProblem = useMemo(() => problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: session.mediaProof, connection: () => client.getSnapshot().connection, telemetry: client.telemetry }), [credential.apiBaseURL, tenantId, session, client]);
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
        offerSignUp,
        tenantId,
        callName: spaceName,
        endReason: client.getSnapshot().connection.episodeEndReason,
        reportProblem: problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: () => terminalProof, connection: () => ({ status: phase, lastError: failure ?? null }), telemetry: client.telemetry }),
        reportExpiresAt: session.mediaExpiresAt(),
      });
    },
    [client, onEnded, release, credential.apiBaseURL, tenantId, session, offerSignUp, spaceName],
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
  useEffect(() => onPageFailure((cause) => client.telemetry.renderCrashed(cause)), [client]);
  return (
    <main className="h-full min-h-0 w-full overflow-hidden">
      <CallErrorBoundary
        onCrash={() => {
          client.telemetry.renderCrashed("render_error");
          void release().catch(() => undefined);
        }}
      >
        {homeError ? <p role="alert">{homeError}</p> : null}
        <Chalk
          screenAnnotation={annotation}
          timeLimit={{
            message: offerSignUp ? signUpOffer() : canExtendCall(connection.episode, maximumSeconds) ? "The host can extend this call." : "This is the longest this call can run.",
            action: offerSignUp ? signUp : undefined,
            endAction: offerSignUp ? signUp : undefined,
          }}
          theme={{ colorScheme: mode }}
          onColorSchemeChange={setPreference}
          client={client}
          onReportProblem={reportsAvailable ? reportProblem : undefined}
          reportUnavailableReason={reportExpired ? reportCredentialExpiredReason : undefined}
          onOpenReportProblem={() => onOpenReportProblem(reportProblem, reportDiagnostics(spaceName ?? "Call", connection))}
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
      </CallErrorBoundary>
    </main>
  );
}

export function EndedStatusSurface({
  call,
  endAction,
  theme,
  rejoinDisabled,
  onRejoin,
  onHome,
  onOpenReportProblem,
}: {
  readonly call: EndedCall;
  readonly endAction?: ComponentProps<typeof StatusSurface>["endAction"];
  readonly theme?: ComponentProps<typeof StatusSurface>["theme"];
  readonly rejoinDisabled: boolean;
  readonly onRejoin: () => void;
  readonly onHome: () => void;
  readonly onOpenReportProblem: () => void;
}) {
  const reportExpired = useReportCredentialExpired(call.reportExpiresAt);
  const reportsAvailable = useProblemReports(publicAPIBaseURL(), call.tenantId);
  return (
    <StatusSurface
      phase={call.phase}
      episodeEndReason={call.endReason}
      endAction={endAction}
      callName={call.callName}
      {...statusFailure(call.failure)}
      theme={theme}
      onReportProblem={reportsAvailable && call.reportProblem && !reportExpired ? onOpenReportProblem : undefined}
      rejoinDisabled={rejoinDisabled}
      onRejoin={onRejoin}
      onHome={onHome}
    />
  );
}

export function SpaceReportProblemDialog({
  tenantId,
  reportExpiresAt,
  reportSession,
  ...props
}: Omit<ComponentProps<typeof ReportProblemDialog>, "unavailableReason"> & {
  readonly tenantId: string | undefined;
  readonly reportExpiresAt: number | undefined;
  readonly reportSession?: PublicSpaceAdmission["session"];
}) {
  const subscribeReportSession = useCallback((listener: () => void) => reportSession?.subscribe(listener) ?? (() => undefined), [reportSession]);
  const liveReportExpiresAt = useSyncExternalStore(
    subscribeReportSession,
    () => reportSession?.mediaExpiresAt(),
    () => reportSession?.mediaExpiresAt(),
  );
  const reportExpired = useReportCredentialExpired(reportSession ? liveReportExpiresAt : reportExpiresAt);
  const reportsAvailable = useProblemReports(publicAPIBaseURL(), tenantId, props.open);
  return <ReportProblemDialog {...props} unavailableReason={reportExpired ? reportCredentialExpiredReason : !reportsAvailable ? "Reporting is temporarily unavailable. Your draft is kept here." : undefined} />;
}
