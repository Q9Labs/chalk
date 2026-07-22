import { ChalkSession, type ChalkSessionStore } from "@q9labsai/chalk-client";
import { ChalkProvider, PreJoinLobby, SessionMeetingRoom, type PreJoinSettings } from "@q9labsai/chalk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "../lib/chalk-access";

export const Route = createFileRoute("/room")({ component: LocalRoomPage });

type ActiveSession = {
  readonly displayName: string;
  readonly session: ChalkSessionStore;
};

function LocalRoomPage() {
  const initialName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "Hasan", []);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [isCreating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const join = async (settings: PreJoinSettings) => {
    setCreating(true);
    setError("");
    try {
      const browserSession = await createLocalBrowserSession(settings.displayName, meetingInviteToken());
      if (browserSession.inviteToken) setMeetingInviteToken(browserSession.inviteToken);
      const session = new ChalkSession({
        access: createLocalAccessProvider(),
        apiBaseURL: browserSession.apiBaseURL,
        syncURL: browserSession.syncURL,
        initialMicrophoneEnabled: settings.microphoneEnabled,
        initialCameraEnabled: settings.cameraEnabled,
      });
      setActive({ displayName: settings.displayName, session });
    } catch (cause) {
      setError(message(cause, "Unable to create the browser session"));
    } finally {
      setCreating(false);
    }
  };

  if (!active) {
    return <PreJoinLobby roomName="Chalk meeting" logoUrl="/brand/chalk/chalk-logo.svg" defaultDisplayName={initialName} isJoining={isCreating} error={error} onJoin={join} />;
  }

  return (
    <ChalkProvider session={active.session}>
      <LiveRoom displayName={active.displayName} session={active.session} onLeave={() => setActive(null)} />
    </ChalkProvider>
  );
}

function LiveRoom({ displayName, session, onLeave }: { readonly displayName: string; readonly session: ChalkSessionStore; readonly onLeave: () => void }) {
  const [leaveError, setLeaveError] = useState("");
  useEffect(() => {
    mountedSessions.set(session, true);
    return () => {
      mountedSessions.delete(session);
      queueMicrotask(() => {
        if (mountedSessions.get(session)) return;
        void session.leave().catch(() => undefined);
      });
    };
  }, [session]);

  const leave = async () => {
    setLeaveError("");
    try {
      await cleanupLocalBrowserSession();
      clearMeetingInviteToken();
      onLeave();
    } catch (cause) {
      setLeaveError(message(cause, "Unable to leave the meeting"));
    }
  };

  return (
    <>
      <SessionMeetingRoom roomName="Chalk meeting" displayName={displayName} meetingLink={globalThis.location?.href} onLeave={leave} />
      {leaveError ? (
        <div role="alert" className="fixed bottom-24 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-lg">
          {leaveError}
        </div>
      ) : null}
    </>
  );
}

const mountedSessions = new WeakMap<ChalkSessionStore, true>();

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
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
