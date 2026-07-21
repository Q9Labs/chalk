import { ChalkSession, type ChalkParticipant, type ChalkRemoteMedia, type ChalkSessionStore } from "@q9labsai/chalk-client";
import { ChalkProvider, useChalkActions, useChalkSession, useChalkSnapshot, useLocalMedia, useParticipants, useRemoteMedia } from "@q9labsai/chalk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { beaconLocalBrowserSessionCleanup, cleanupLocalBrowserSession, createLocalAccessProvider, createLocalBrowserSession } from "../lib/chalk-access";

export const Route = createFileRoute("/room")({ component: LocalRoomPage });

type ActiveSession = {
  readonly displayName: string;
  readonly session: ChalkSessionStore;
};

function LocalRoomPage() {
  const initialName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "Hasan", []);
  const [displayName, setDisplayName] = useState(initialName);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [isCreating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const join = async () => {
    setCreating(true);
    setError("");
    try {
      const browserSession = await createLocalBrowserSession(displayName.trim() || "Guest");
      const session = new ChalkSession({
        access: createLocalAccessProvider(),
        apiBaseURL: browserSession.apiBaseURL,
        syncURL: browserSession.syncURL,
      });
      setActive({ displayName: displayName.trim() || "Guest", session });
    } catch (cause) {
      setError(message(cause, "Unable to create the local browser session"));
    } finally {
      setCreating(false);
    }
  };

  if (active) {
    return (
      <ChalkProvider session={active.session}>
        <LiveRoom displayName={active.displayName} onLeave={() => setActive(null)} />
      </ChalkProvider>
    );
  }

  return (
    <main className="min-h-screen bg-[#09090b] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 py-4 md:px-7">
        <RoomHeader status={isCreating ? "Creating a browser session…" : "Ready for a real localhost call"} phase={isCreating ? "pending" : error ? "failed" : "idle"} />
        <section className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-xl rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] p-7 shadow-2xl backdrop-blur-xl">
            <div className="mb-7 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4 text-sm leading-6 text-emerald-50">This room is a thin consumer of the public Chalk browser and React SDKs. A localhost-only backend keeps the API key and participant identity out of this tab.</div>
            <label className="text-sm text-zinc-300" htmlFor="room-display-name">
              Your name in this tab
            </label>
            <input id="room-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/10 bg-black/30 px-4 outline-none ring-emerald-300/40 focus:ring-2" />
            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
                {error}
              </p>
            )}
            <button type="button" onClick={() => void join()} disabled={isCreating} className="mt-6 h-12 w-full rounded-full bg-white font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-60">
              {isCreating ? "Creating session…" : "Join real room"}
            </button>
            <p className="mt-4 text-center text-xs text-zinc-500">Open this URL in a second tab with a different name.</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function LiveRoom({ displayName, onLeave }: { readonly displayName: string; readonly onLeave: () => void }) {
  const sessionStore = useChalkSession();
  const session = useChalkSnapshot();
  const participants = useParticipants();
  const localMedia = useLocalMedia();
  const remoteMedia = useRemoteMedia();
  const actions = useChalkActions();
  const [commandError, setCommandError] = useState("");
  const didStart = useRef(false);

  useEffect(() => {
    if (didStart.current) return;
    didStart.current = true;
    void actions.join().catch(() => undefined);
  }, [actions]);

  useEffect(() => {
    const cleanup = () => beaconLocalBrowserSessionCleanup();
    globalThis.addEventListener?.("pagehide", cleanup, { once: true });
    return () => globalThis.removeEventListener?.("pagehide", cleanup);
  }, []);

  useEffect(() => {
    mountedSessions.set(sessionStore, true);
    return () => {
      mountedSessions.delete(sessionStore);
      queueMicrotask(() => {
        if (mountedSessions.get(sessionStore)) return;
        void sessionStore
          .leave()
          .catch(() => undefined)
          .finally(() => cleanupLocalBrowserSession().catch(() => undefined));
      });
    };
  }, [sessionStore]);

  const remoteFeeds = useMemo(() => groupRemoteMedia(remoteMedia), [remoteMedia]);
  const localTracks = [localMedia.microphone.track, localMedia.camera.track].filter(isMediaTrack);
  const microphoneEnabled = localMedia.microphone.state === "enabled" || localMedia.microphone.state === "requesting";
  const cameraEnabled = localMedia.camera.state === "enabled" || localMedia.camera.state === "requesting";
  const status = sessionStatus(session.state, session.connection.sync, session.connection.media);

  const run = async (operation: () => Promise<void>, fallback: string) => {
    try {
      await operation();
      setCommandError("");
    } catch (cause) {
      setCommandError(message(cause, fallback));
    }
  };

  const leave = async () => {
    try {
      await actions.leave();
    } catch (cause) {
      setCommandError(message(cause, "The SDK could not confirm the remote leave"));
    } finally {
      await cleanupLocalBrowserSession().catch(() => undefined);
      onLeave();
    }
  };

  return (
    <main className="min-h-screen bg-[#09090b] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 py-4 md:px-7">
        <RoomHeader status={status} phase={session.state === "failed" ? "failed" : session.state === "live" ? "live" : "pending"} />
        <section className="flex min-h-0 flex-1 flex-col py-4">
          <div className="grid min-h-0 flex-1 auto-rows-[minmax(260px,1fr)] grid-cols-1 gap-3 lg:grid-cols-2">
            <VideoTile tracks={localTracks} label={`${displayName} · this tab`} muted mirrored cameraEnabled={cameraEnabled} />
            {remoteFeeds.map((feed) => (
              <VideoTile key={feed.participantSessionId} tracks={feed.tracks} label={participantName(participants, feed.participantSessionId)} muted={false} mirrored={false} cameraEnabled={feed.tracks.some((track) => track.kind === "video")} />
            ))}
            {remoteFeeds.length === 0 && (
              <div className="grid min-h-[320px] place-items-center rounded-[1.75rem] border border-dashed border-white/15 bg-white/[0.025] p-8 text-center text-zinc-400">
                <div>
                  <p className="text-lg text-zinc-200">Waiting for the second tab</p>
                  <p className="mt-2 text-sm">Join the same localhost URL, then its media appears here.</p>
                </div>
              </div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-zinc-950/90 p-3">
            <div className="flex gap-2">
              <ControlButton active={microphoneEnabled} onClick={() => void run(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed")}>
                {microphoneEnabled ? "Mute" : "Unmute"}
              </ControlButton>
              <ControlButton active={cameraEnabled} onClick={() => void run(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed")}>
                {cameraEnabled ? "Stop camera" : "Start camera"}
              </ControlButton>
            </div>
            <div className="font-mono text-xs text-zinc-500">
              {participants.length} participant(s) in Sync · {remoteFeeds.length} remote feed(s)
            </div>
            <button type="button" onClick={() => void leave()} className="h-10 rounded-full bg-red-500 px-6 text-sm font-semibold hover:bg-red-400">
              Leave
            </button>
          </div>
          {(commandError || session.failure) && (
            <p role="alert" className="mt-3 text-center text-sm text-red-300">
              {commandError || session.failure?.message}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

const mountedSessions = new WeakMap<ChalkSessionStore, true>();

function RoomHeader({ status, phase }: { readonly status: string; readonly phase: "idle" | "pending" | "live" | "failed" }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-emerald-300">Public SDK consumer</p>
        <h1 className="mt-1 text-2xl font-semibold">Cloudflare SFU · two-tab test</h1>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm">
        <span className={`h-2.5 w-2.5 rounded-full ${phase === "live" ? "bg-emerald-400 shadow-[0_0_14px_#34d399]" : phase === "failed" ? "bg-red-400" : phase === "pending" ? "bg-amber-300" : "bg-zinc-500"}`} />
        {status}
      </div>
    </header>
  );
}

function VideoTile({ tracks, label, muted, mirrored, cameraEnabled }: { readonly tracks: readonly MediaStreamTrack[]; readonly label: string; readonly muted: boolean; readonly mirrored: boolean; readonly cameraEnabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useMemo(() => new MediaStream([...tracks]), [tracks]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
    return () => {
      if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="relative min-h-[320px] overflow-hidden rounded-[1.75rem] border border-white/10 bg-zinc-900">
      <video ref={videoRef} autoPlay playsInline muted={muted} className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""} ${cameraEnabled ? "" : "opacity-0"}`} />
      <span className="absolute bottom-4 left-4 rounded-full bg-black/60 px-3 py-1.5 text-sm backdrop-blur">{label}</span>
    </div>
  );
}

function ControlButton({ active, onClick, children }: { readonly active: boolean; readonly onClick: () => void; readonly children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`h-10 rounded-full border px-5 text-sm font-medium ${active ? "border-white/15 bg-white/10 hover:bg-white/15" : "border-red-400/20 bg-red-400/10 text-red-100"}`}>
      {children}
    </button>
  );
}

function groupRemoteMedia(media: readonly ChalkRemoteMedia[]): readonly { readonly participantSessionId: string; readonly tracks: readonly MediaStreamTrack[] }[] {
  const grouped = new Map<string, MediaStreamTrack[]>();
  for (const publication of media) {
    const tracks = grouped.get(publication.participantSessionId) ?? [];
    tracks.push(publication.track);
    grouped.set(publication.participantSessionId, tracks);
  }
  return [...grouped].map(([participantSessionId, tracks]) => ({ participantSessionId, tracks }));
}

function participantName(participants: readonly ChalkParticipant[], participantSessionId: string): string {
  return participants.find((participant) => participant.participantSessionId === participantSessionId)?.displayName ?? `Guest ${participantSessionId.slice(0, 5)}`;
}

function sessionStatus(state: string, sync: string, media: string): string {
  if (state === "live") return "Live — API + Sync + Cloudflare SFU";
  if (state === "reconnecting") return `Recovering — Sync ${sync}, media ${media}`;
  if (state === "failed") return "Join failed";
  if (state === "leaving" || state === "left") return "Leaving the room…";
  return "Joining through the public Chalk SDK…";
}

function isMediaTrack(track: MediaStreamTrack | null): track is MediaStreamTrack {
  return track !== null;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
