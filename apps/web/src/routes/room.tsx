import { ChalkSession, type ChalkSessionJoinTraceEvent } from "@q9labsai/chalk-client";
import { VideoConference, type PreJoinSettings } from "@q9labsai/chalk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { JoinTracePanel } from "../components/observability/JoinTracePanel";
import { cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "../lib/chalk-access";

export const Route = createFileRoute("/room")({ component: LocalRoomPage });

function LocalRoomPage() {
  const initialName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "Hasan", []);
  const [meetingLink, setMeetingLink] = useState(() => globalThis.location?.href);
  const [showTrace, setShowTrace] = useState(() => new URLSearchParams(globalThis.location?.search ?? "").get("trace") === "1");
  const [traceEvents, setTraceEvents] = useState<readonly ChalkSessionJoinTraceEvent[]>([]);

  const createSession = async (settings: PreJoinSettings) => {
    if (showTrace) setTraceEvents([]);
    const browserSession = await createLocalBrowserSession(settings.displayName, meetingInviteToken());
    if (browserSession.inviteToken) {
      setMeetingInviteToken(browserSession.inviteToken);
      setMeetingLink(globalThis.location?.href);
    }

    return new ChalkSession({
      access: createLocalAccessProvider(),
      apiBaseURL: browserSession.apiBaseURL,
      syncURL: browserSession.syncURL,
      initialMicrophoneEnabled: settings.microphoneEnabled,
      initialCameraEnabled: settings.cameraEnabled,
      diagnostics: showTrace
        ? {
            onEvent: (event) => {
              if (event.event === "join_span") setTraceEvents((current) => [...current, event as ChalkSessionJoinTraceEvent]);
            },
          }
        : undefined,
    });
  };

  const meeting = (
    <VideoConference
      roomId="local-room"
      roomName="Chalk meeting"
      logoUrl="/brand/chalk/chalk-logo.svg"
      meetingLink={meetingLink}
      userName={initialName}
      createSession={createSession}
      initialJoinSettings={showTrace ? { microphoneEnabled: false, cameraEnabled: false } : undefined}
      onLeave={async () => {
        await cleanupLocalBrowserSession();
        clearMeetingInviteToken();
      }}
    />
  );

  return (
    <div className="chalk-room-trace-shell">
      {meeting}
      {showTrace ? (
        <JoinTracePanel events={traceEvents} onClose={() => setShowTrace(false)} />
      ) : (
        <button type="button" className="chalk-join-trace-launcher" onClick={() => setShowTrace(true)}>
          Show join trace
        </button>
      )}
    </div>
  );
}

function meetingInviteToken(): string | undefined {
  const hash = globalThis.location?.hash;
  if (!hash) return undefined;
  return new URLSearchParams(hash.slice(1)).get("meeting") ?? undefined;
}

function setMeetingInviteToken(inviteToken: string): void {
  if (!globalThis.location || !globalThis.history) return;
  const url = new URL(globalThis.location.href);
  url.hash = new URLSearchParams({ meeting: inviteToken }).toString();
  globalThis.history.replaceState(globalThis.history.state, "", url);
}

function clearMeetingInviteToken(): void {
  if (!globalThis.location || !globalThis.history) return;
  const url = new URL(globalThis.location.href);
  url.hash = "";
  globalThis.history.replaceState(globalThis.history.state, "", url);
}
