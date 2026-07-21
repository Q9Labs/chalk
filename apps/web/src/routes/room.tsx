import { ChalkSession, type ChalkSessionStore } from "@q9labsai/chalk-client";
import { ChalkProvider, PreJoinLobby, SessionMeetingRoom, type PreJoinSettings } from "@q9labsai/chalk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { beaconLocalBrowserSessionCleanup, cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "../lib/chalk-access";

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
      const browserSession = await createLocalBrowserSession(settings.displayName);
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
  useEffect(() => {
    const cleanup = () => beaconLocalBrowserSessionCleanup();
    globalThis.addEventListener?.("pagehide", cleanup, { once: true });
    return () => globalThis.removeEventListener?.("pagehide", cleanup);
  }, []);

  useEffect(() => {
    mountedSessions.set(session, true);
    return () => {
      mountedSessions.delete(session);
      queueMicrotask(() => {
        if (mountedSessions.get(session)) return;
        void session
          .leave()
          .catch(() => undefined)
          .finally(() => cleanupLocalBrowserSession().catch(() => undefined));
      });
    };
  }, [session]);

  const leave = async () => {
    await cleanupLocalBrowserSession().catch(() => undefined);
    onLeave();
  };

  return <SessionMeetingRoom roomName="Chalk meeting" displayName={displayName} meetingLink={globalThis.location?.href} onLeave={leave} />;
}

const mountedSessions = new WeakMap<ChalkSessionStore, true>();

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
