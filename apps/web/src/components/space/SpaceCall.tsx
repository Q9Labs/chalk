import type { JoinOptions } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useMemo, useState } from "react";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import { createLocalSpaceClient } from "../../lib/local-space-client";
import { problemReporter, type ReportProblem } from "../../lib/problem-reports";
import { useTheme } from "../../lib/theme-context";
import type { EndedCall } from "./entrance-machine";
import { useCallLifecycle } from "./space-call-lifecycle";

// The call UI and media stack, which SpacePage loads only once the participant asks to join.
export { ReportProblemDialog, StatusSurface } from "@q9labsai/chalk-react";

/** A host can extend a call; a guest is pointed at signing up for longer ones. */
function timeLimitFor(hostCanExtend: boolean) {
  const signUp = { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") };
  return {
    message: hostCanExtend ? "The host can extend this call." : "Sign up free for calls up to 24 hours.",
    action: hostCanExtend ? undefined : signUp,
    endAction: hostCanExtend ? undefined : signUp,
  };
}

export function LocalSpace({
  admission,
  reportsAvailable,
  reportUnavailableReason,
  onOpenReportProblem,
  displayName,
  defaults,
  spaceName,
  inviteLink,
  onEnded,
}: {
  readonly admission: PublicSpaceAdmission;
  readonly reportsAvailable: boolean;
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
  const [homeError, setHomeError] = useState<string | null>(null);
  const tenantId = session.reloadMarker().tenantId;
  const { release, connection, onEpisodeEnded, onLeft, onJoined } = useCallLifecycle({ client, session, credential, tenantId, displayName, spaceName, hostCanExtend, onEnded });
  const reportProblem = useMemo(() => problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: session.mediaProof, connection: () => client.getSnapshot().connection }), [credential.apiBaseURL, tenantId, session, client]);
  return (
    <main className="h-full min-h-0 w-full overflow-hidden">
      {homeError ? <p role="alert">{homeError}</p> : null}
      <Chalk
        timeLimit={timeLimitFor(hostCanExtend)}
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
        onEpisodeEnded={onEpisodeEnded}
        onLeft={onLeft}
        onJoined={onJoined}
        onHome={() => {
          void release()
            .then(() => globalThis.location.assign("/"))
            .catch(() => setHomeError("Couldn’t leave the call. Try Home again."));
        }}
      />
    </main>
  );
}
