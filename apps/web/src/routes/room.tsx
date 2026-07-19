import { CloudflareSFUClient, createCloudflareSFUHTTPTransport } from "@q9labsai/chalk-client/media";
import { createV3SyncClient, type V3SessionSnapshot } from "@q9labsai/chalk-client/sync";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/room")({ component: LocalRoomPage });

type AdmissionResponse = {
  participant: { id: string; generation: number };
  lifecycle_intent: { id: string };
  media_plane: {
    provider: string;
    client_payload: { connectionId: string; stunServer: string };
  };
};

type Runtime = {
  media: CloudflareSFUClient;
  participantSessionId: string;
  sync: ReturnType<typeof createV3SyncClient>;
  local: MediaStream;
  unsubscribe: () => void;
};

type RemoteFeed = { participantSessionId: string; stream: MediaStream };

const localConfig = {
  apiURL: import.meta.env.VITE_CHALK_API_URL ?? "http://localhost:8080",
  apiToken: import.meta.env.VITE_CHALK_LOCAL_API_TOKEN ?? "",
  syncURL: import.meta.env.VITE_CHALK_SYNC_URL ?? "ws://localhost:4100/v3/sync",
  tenantId: import.meta.env.VITE_CHALK_TENANT_ID ?? "",
  roomId: import.meta.env.VITE_CHALK_ROOM_ID ?? "",
  sessionId: import.meta.env.VITE_CHALK_SESSION_ID ?? "",
};

function LocalRoomPage() {
  const initialName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "Hasan", []);
  const [displayName, setDisplayName] = useState(initialName);
  const [phase, setPhase] = useState<"lobby" | "joining" | "live" | "failed">("lobby");
  const [status, setStatus] = useState("Ready for a real localhost call");
  const [error, setError] = useState("");
  const [isMuted, setMuted] = useState(false);
  const [isCameraEnabled, setCameraEnabled] = useState(true);
  const [remoteFeeds, setRemoteFeeds] = useState<RemoteFeed[]>([]);
  const [syncSnapshot, setSyncSnapshot] = useState<V3SessionSnapshot | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const runtime = useRef<Runtime | null>(null);

  useEffect(() => () => stopRuntime(runtime.current), []);

  const participantName = (participantSessionId: string) => syncSnapshot?.control?.participants.find((participant) => participant.participantSessionId === participantSessionId)?.displayName ?? `Guest ${participantSessionId.slice(0, 5)}`;

  const join = async () => {
    let local: MediaStream | null = null;
    setPhase("joining");
    setError("");
    setStatus("Requesting camera and microphone…");
    try {
      requireLocalConfig();
      local = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (localVideo.current) localVideo.current.srcObject = local;
      setStatus("Admitting this tab through Chalk API…");
      const participantSessionId = crypto.randomUUID();
      const admission = await admitParticipant(participantSessionId, displayName.trim() || "Guest");
      if (admission.media_plane.provider !== "cloudflare_sfu") throw new Error(`Expected cloudflare_sfu, received ${admission.media_plane.provider}`);

      const transport = createCloudflareSFUHTTPTransport({
        apiBaseURL: localConfig.apiURL,
        bearerToken: localConfig.apiToken,
        tenantId: localConfig.tenantId,
        roomId: localConfig.roomId,
        sessionId: localConfig.sessionId,
        participantSessionId,
      });
      const media = new CloudflareSFUClient({
        bootstrap: admission.media_plane.client_payload,
        participantSessionId,
        transport,
        onError: (cause) => setError(cause instanceof Error ? cause.message : "Cloudflare SFU refresh failed"),
        onRemoteTrack: ({ participantSessionId: remoteParticipantId, track }) => {
          setRemoteFeeds((current) => {
            const existing = current.find((feed) => feed.participantSessionId === remoteParticipantId);
            if (existing) {
              if (!existing.stream.getTracks().some((candidate) => candidate.id === track.id)) existing.stream.addTrack(track);
              return [...current];
            }
            return [...current, { participantSessionId: remoteParticipantId, stream: new MediaStream([track]) }];
          });
        },
      });
      setStatus("Publishing this tab to Cloudflare SFU…");
      await media.start(local);

      const syncToken = createDevSyncToken({ admission, participantSessionId, displayName: displayName.trim() || "Guest" });
      const sync = createV3SyncClient({ url: localConfig.syncURL, token: async () => syncToken, mediaPlane: media, persistenceScope: `room-proof:${participantSessionId}` });
      const unsubscribe = sync.subscribe((snapshot) => {
        setSyncSnapshot(snapshot);
        if (snapshot.connection.phase === "live") setStatus("Live — API + Sync + Cloudflare SFU");
      });
      runtime.current = { media, participantSessionId, sync, local, unsubscribe };
      await sync.start();
      setPhase("live");
      setStatus("Connecting to Chalk Sync…");
    } catch (cause) {
      const activeRuntime = runtime.current;
      stopRuntime(activeRuntime);
      if (!activeRuntime) for (const track of local?.getTracks() ?? []) track.stop();
      runtime.current = null;
      setPhase("failed");
      setError(cause instanceof Error ? cause.message : "Unable to join the room");
      setStatus("Join failed");
    }
  };

  const toggleMicrophone = async () => {
    const activeRuntime = runtime.current;
    if (!activeRuntime) return;
    const next = !isMuted;
    try {
      const result = await activeRuntime.media.setLocalPublicationTarget({ operationId: crypto.randomUUID(), participantSessionId: activeRuntime.participantSessionId, source: "microphone", enabled: !next });
      if (result.outcome !== "confirmed" && result.outcome !== "satisfied") throw new Error(result.errorCode ?? "Microphone update failed");
      setMuted(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone update failed");
    }
  };

  const toggleCamera = async () => {
    const activeRuntime = runtime.current;
    if (!activeRuntime) return;
    const next = !isCameraEnabled;
    try {
      const result = await activeRuntime.media.setLocalPublicationTarget({ operationId: crypto.randomUUID(), participantSessionId: activeRuntime.participantSessionId, source: "camera", enabled: next });
      if (result.outcome !== "confirmed" && result.outcome !== "satisfied") throw new Error(result.errorCode ?? "Camera update failed");
      setCameraEnabled(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Camera update failed");
    }
  };

  const leave = () => {
    stopRuntime(runtime.current);
    runtime.current = null;
    setRemoteFeeds([]);
    setSyncSnapshot(null);
    setPhase("lobby");
    setStatus("Left the room cleanly");
  };

  return (
    <main className="min-h-screen bg-[#09090b] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 py-4 md:px-7">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-emerald-300">Local proof room</p>
            <h1 className="mt-1 text-2xl font-semibold">Cloudflare SFU · two-tab test</h1>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${syncSnapshot?.connection.phase === "live" ? "bg-emerald-400 shadow-[0_0_14px_#34d399]" : phase === "failed" ? "bg-red-400" : "bg-amber-300"}`} />
            {status}
          </div>
        </header>

        {phase === "lobby" || phase === "failed" ? (
          <section className="grid flex-1 place-items-center py-10">
            <div className="w-full max-w-xl rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] p-7 shadow-2xl backdrop-blur-xl">
              <div className="mb-7 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4 text-sm leading-6 text-emerald-50">This is not the SDK preview. Joining creates a Chalk participant, a real Cloudflare peer session, and a Sync v3 connection.</div>
              <label className="text-sm text-zinc-300" htmlFor="room-display-name">
                Your name in this tab
              </label>
              <input id="room-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-white/10 bg-black/30 px-4 outline-none ring-emerald-300/40 focus:ring-2" />
              {error && (
                <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
                  {error}
                </p>
              )}
              <button type="button" onClick={join} className="mt-6 h-12 w-full rounded-full bg-white font-semibold text-zinc-950 transition hover:bg-emerald-200">
                Join real room
              </button>
              <p className="mt-4 text-center text-xs text-zinc-500">Open this URL in a second tab with a different name.</p>
            </div>
          </section>
        ) : (
          <section className="flex min-h-0 flex-1 flex-col py-4">
            <div className="grid min-h-0 flex-1 auto-rows-[minmax(260px,1fr)] grid-cols-1 gap-3 lg:grid-cols-2">
              <VideoTile videoRef={localVideo} label={`${displayName} · this tab`} muted mirrored cameraEnabled={isCameraEnabled} />
              {remoteFeeds.map((feed) => (
                <RemoteVideoTile key={feed.participantSessionId} feed={feed} label={participantName(feed.participantSessionId)} />
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
                <ControlButton active={!isMuted} onClick={toggleMicrophone}>
                  {isMuted ? "Unmute" : "Mute"}
                </ControlButton>
                <ControlButton active={isCameraEnabled} onClick={toggleCamera}>
                  {isCameraEnabled ? "Stop camera" : "Start camera"}
                </ControlButton>
              </div>
              <div className="font-mono text-xs text-zinc-500">
                {syncSnapshot?.presence?.items.length ?? 0} tab(s) in Sync · {remoteFeeds.length} remote feed(s)
              </div>
              <button type="button" onClick={leave} className="h-10 rounded-full bg-red-500 px-6 text-sm font-semibold hover:bg-red-400">
                Leave
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-center text-sm text-red-300">
                {error}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function VideoTile({ videoRef, label, muted, mirrored, cameraEnabled }: { videoRef: React.RefObject<HTMLVideoElement | null>; label: string; muted: boolean; mirrored: boolean; cameraEnabled: boolean }) {
  return (
    <div className="relative min-h-[320px] overflow-hidden rounded-[1.75rem] border border-white/10 bg-zinc-900">
      <video ref={videoRef} autoPlay playsInline muted={muted} className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""} ${cameraEnabled ? "" : "opacity-0"}`} />
      <span className="absolute bottom-4 left-4 rounded-full bg-black/60 px-3 py-1.5 text-sm backdrop-blur">{label}</span>
    </div>
  );
}

function RemoteVideoTile({ feed, label }: { feed: RemoteFeed; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = feed.stream;
  }, [feed.stream]);
  return <VideoTile videoRef={ref} label={label} muted={false} mirrored={false} cameraEnabled />;
}

function ControlButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`h-10 rounded-full border px-5 text-sm font-medium ${active ? "border-white/15 bg-white/10 hover:bg-white/15" : "border-red-400/20 bg-red-400/10 text-red-100"}`}>
      {children}
    </button>
  );
}

async function admitParticipant(participantSessionId: string, name: string): Promise<AdmissionResponse> {
  const response = await fetch(`${localConfig.apiURL}/v1/tenants/${localConfig.tenantId}/rooms/${localConfig.roomId}/sessions/${localConfig.sessionId}/participants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${localConfig.apiToken}`, "Content-Type": "application/json", "Idempotency-Key": `local-room-${participantSessionId}` },
    body: JSON.stringify({ participant_session_id: participantSessionId, name, initial_role: "participant", eligible_roles: ["participant"] }),
  });
  if (!response.ok) throw new Error(`Chalk admission failed with HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as AdmissionResponse;
}

function createDevSyncToken({ admission, participantSessionId, displayName }: { admission: AdmissionResponse; participantSessionId: string; displayName: string }): string {
  const now = Math.floor(Date.now() / 1_000);
  const claims = JSON.stringify({
    tenant_id: localConfig.tenantId,
    room_id: localConfig.roomId,
    session_id: localConfig.sessionId,
    participant_id: participantSessionId,
    participant_session_id: participantSessionId,
    participant_session_generation: admission.participant.generation,
    admission_lifecycle_intent_id: admission.lifecycle_intent.id,
    display_name: displayName,
    initial_role: "participant",
    eligible_roles: ["participant"],
    issued_at: now,
    expires_at: now + 3_600,
  });
  const bytes = new TextEncoder().encode(claims);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function requireLocalConfig(): void {
  const missing = Object.entries(localConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) throw new Error(`Local room configuration is missing: ${missing.join(", ")}`);
  if (!localConfig.apiURL.includes("localhost") && !localConfig.apiURL.includes("127.0.0.1")) throw new Error("The proof room is restricted to a localhost API");
}

function stopRuntime(runtime: Runtime | null): void {
  if (!runtime) return;
  runtime.unsubscribe();
  runtime.sync.stop();
  runtime.media.stop();
  for (const track of runtime.local.getTracks()) track.stop();
}
