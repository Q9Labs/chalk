import type { SpaceClient } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
import { VideoConference, type PreJoinSettings } from "@q9labsai/chalk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "../lib/chalk-access";

export const Route = createFileRoute("/room")({ component: LocalRoomPage });

function LocalRoomPage() {
  const initialName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "Hasan", []);
  const [meetingLink, setMeetingLink] = useState(() => globalThis.location?.href);

  const createSession = async (settings: PreJoinSettings): Promise<SpaceClient> => {
    const browserSession = await createLocalBrowserSession(settings.displayName, meetingInviteToken());
    if (browserSession.inviteToken) {
      setMeetingInviteToken(browserSession.inviteToken);
      setMeetingLink(globalThis.location?.href);
    }

    return createSpaceClientForPlatform(
      {
        space: "local-space",
        getAccess: createLocalAccessProvider(),
        baseUrl: browserSession.apiBaseURL,
      },
      {
        syncUrl: browserSession.syncURL,
        initialMicrophoneEnabled: settings.microphoneEnabled,
        initialCameraEnabled: settings.cameraEnabled,
      },
    );
  };

  return (
    <VideoConference
      roomId="local-room"
      roomName="Chalk meeting"
      logoUrl="/brand/chalk/chalk-logo.svg"
      meetingLink={meetingLink}
      userName={initialName}
      createSession={createSession}
      onLeave={async () => {
        await cleanupLocalBrowserSession();
        clearMeetingInviteToken();
      }}
    />
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
