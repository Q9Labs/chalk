/**
 * RoomPage - Thin wrapper over SDK VideoConference
 *
 * Uses the SDK's turnkey VideoConference component which handles:
 * - Pre-join lobby with device selection
 * - Meeting room with video grid, chat, participants
 * - End screen
 * - Whiteboard (integrated via WhiteboardPanel)
 *
 * App-specific enhancement:
 * - Keyboard shortcut 'W' to toggle whiteboard
 */

import { getStoredMeetingRoomSettings, useRoomEntryModel, useWhiteboard, VideoConference, writeMeetingEndSummaryFromData } from "@q9labs/chalk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import z from "zod";
import { createWebTokenProvider, getApiUrl, getJoinContext } from "../../lib/webMeeting";
import { ChalkLogo } from "../../components/ChalkLogo";
import { WebChalkRuntime } from "../../components/WebChalkRuntime";
import { cn } from "../../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { getPublicAppOrigin } from "../../lib/publicUrl";

function getStoredUserName() {
  if (typeof window === "undefined") {
    return "";
  }

  return getStoredMeetingRoomSettings().identity.displayName;
}

function getStoredJoinDefaults() {
  if (typeof window === "undefined") {
    return { audioEnabled: false, videoEnabled: false };
  }

  const storedSettings = getStoredMeetingRoomSettings();

  return {
    audioEnabled: storedSettings.join.audioEnabled,
    videoEnabled: storedSettings.join.videoEnabled,
  };
}

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
  params: z.object({
    roomId: z.string(),
  }),
  validateSearch: z.object({
    roomName: z.string().optional(),
    autoJoin: z.coerce.boolean().optional(),
  }),
});

function RoomPage() {
  const { roomId } = Route.useParams() as {
    roomId: string;
  };
  const { roomName, autoJoin } = Route.useSearch();
  const navigate = useNavigate();
  const apiUrl = useMemo(() => getApiUrl(), []);
  const webTokenProvider = useMemo(() => createWebTokenProvider(apiUrl), [apiUrl]);
  const joinCtx = typeof window === "undefined" ? null : getJoinContext();

  const [storedUserName, setStoredUserName] = useState<string>(() => getStoredUserName());
  const [now, setNow] = useState(Date.now());
  const [defaults, setDefaults] = useState(() => getStoredJoinDefaults());
  const {
    availability,
    isLoading: isCheckingRoom,
    meetingLink,
    role,
    room,
  } = useRoomEntryModel({
    apiUrl,
    joinContext: joinCtx,
    nowMs: now,
    publicAppUrl: getPublicAppOrigin(),
    roomId,
    roomName,
    tokenProvider: webTokenProvider,
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load username and defaults from storage after mount
  useEffect(() => {
    setStoredUserName(getStoredUserName());
    setDefaults(getStoredJoinDefaults());
  }, []);

  if (isCheckingRoom) {
    return (
      <div className="h-screen w-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Waiting Room Logic
  const startMs = availability.startsAtMs;
  const joinAllowedAtMs = availability.opensAtMs;

  if (joinAllowedAtMs && now < joinAllowedAtMs) {
    const timeUntilOpenMs = joinAllowedAtMs - now;
    const isImminent = timeUntilOpenMs < 60_000; // Less than 1 minute

    const days = Math.floor(timeUntilOpenMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeUntilOpenMs / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((timeUntilOpenMs / 1000 / 60) % 60);
    const seconds = Math.floor((timeUntilOpenMs / 1000) % 60);

    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 relative overflow-hidden selection:bg-primary/20 text-white">
        <div className="absolute inset-0 z-0">
          <div className="absolute top-[20%] left-[10%] w-[50vw] h-[50vw] bg-primary/10 rounded-full blur-[150px]" />
        </div>

        <div className="relative z-10 w-full max-w-2xl text-center space-y-12 animate-in fade-in duration-1000">
          <div>
            <div className="inline-flex h-8 px-3 items-center justify-center rounded-full bg-white/10 border border-white/20 text-xs font-bold uppercase tracking-widest mb-8 backdrop-blur-md">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse mr-2" />
              Opening Soon
            </div>

            <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight text-balance mb-4 leading-tight">{room?.name || roomName || "Scheduled Session"}</h1>

            <div className="flex items-center justify-center gap-6 text-sm font-semibold text-white/50 uppercase tracking-widest mt-6">
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={Calendar01Icon} size={16} />{" "}
                {startMs
                  ? new Date(startMs).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                  : ""}
              </span>
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={Clock01Icon} size={16} />{" "}
                {startMs
                  ? new Date(startMs).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : ""}
              </span>
            </div>
          </div>

          <div className="py-8">
            <div className={cn("font-mono font-bold tracking-tighter flex justify-center gap-4 transition-all duration-500", isImminent ? "text-primary text-8xl md:text-9xl" : "text-white/90 text-7xl md:text-8xl")}>
              {days > 0 && (
                <span>
                  {String(days).padStart(2, "0")}
                  <span className="text-white/20 opacity-50 text-4xl mr-2">d</span>
                </span>
              )}
              {(days > 0 || hours > 0) && (
                <span>
                  {String(hours).padStart(2, "0")}
                  <span className="text-white/20 opacity-50 text-4xl mr-2">h</span>
                </span>
              )}
              <span>
                {String(minutes).padStart(2, "0")}
                <span className="text-white/20 opacity-50 text-4xl mr-2">m</span>
              </span>
              <span>
                {String(seconds).padStart(2, "0")}
                <span className="text-white/20 opacity-50 text-4xl">s</span>
              </span>
            </div>
            <p className="mt-6 text-sm font-medium text-white/40 uppercase tracking-[0.2em]">Until waiting room opens</p>
          </div>

          <div className="pt-8 flex flex-col items-center">
            <ChalkLogo className="opacity-30 mix-blend-screen scale-75" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <WebChalkRuntime fallback={<div className="h-screen w-screen bg-background" />}>
      {({ openDebug }) => (
        <div className="h-screen w-screen relative bg-background">
          <VideoConference
            roomId={roomId}
            roomName={roomName || "Meeting On Chalk"}
            meetingLink={meetingLink || undefined}
            mobileRedirect={{
              iosStoreUrl: import.meta.env.VITE_IOS_APP_STORE_URL,
            }}
            userName={storedUserName || "Chalker"}
            autoJoin={autoJoin}
            onJoin={() => {}}
            onEnd={(data) => {
              writeMeetingEndSummaryFromData(data, {
                roomName: room?.name || roomName || "Meeting On Chalk",
              });
              navigate({ to: "/room/end", search: { roomId } });
            }}
            sounds={true}
            debug={true}
            role={role as "host" | "participant"}
            features={{
              chat: true,
              recording: role === "host",
              screenShare: true,
              whiteboard: true,
              reactions: true,
              handRaise: true,
              backgroundEffects: true,
              tour: false,
            }}
            defaults={{
              videoEnabled: defaults.videoEnabled,
              layout: "grid",
              audioEnabled: defaults.audioEnabled,
            }}
            onOpenDebug={openDebug}
            className="h-full w-full"
          />

          <WhiteboardKeyboardShortcut />
        </div>
      )}
    </WebChalkRuntime>
  );
}

/**
 * Keyboard shortcut 'W' to toggle whiteboard
 * Uses SDK's useWhiteboard hook
 */
function WhiteboardKeyboardShortcut() {
  const { toggle } = useWhiteboard();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "w" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        toggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  return null;
}

export default RoomPage;
