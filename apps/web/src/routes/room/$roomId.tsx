/**
 * RoomPage - Thin wrapper over SDK VideoConference
 *
 * Uses the SDK's turnkey VideoConference component which handles:
 * - Pre-join lobby with device selection
 * - Meeting room with video grid, chat, participants
 * - End screen
 * - Whiteboard (integrated via WhiteboardPanel)
 *
 * App-specific overlays:
 * - Floating reaction bubbles
 * - Keyboard shortcut 'W' to toggle whiteboard
 */

import {
  useInteractions,
  useWhiteboard,
  VideoConference,
} from "@q9labs/chalk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import z from "zod";
import { ReactionBubbles } from "@/features/room/components";
import { getJoinContext } from "../../lib/internalAuth";

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
  params: z.object({
    roomId: z.string(),
  }),
  search: z.object({
    roomName: z.string().optional(),
  }),
});

function RoomPage() {
  const { roomId } = Route.useParams() as {
    roomId: string;
  };
  const { roomName } = Route.useSearch();
  const navigate = useNavigate();

  const [storedUserName, setStoredUserName] = useState<string>("");

  // Load username from sessionStorage after mount
  useEffect(() => {
    const savedName = sessionStorage.getItem("chalk_display_name");
    if (savedName) {
      setStoredUserName(savedName);
    }
  }, []);

  const joinCtx = typeof window === "undefined" ? null : getJoinContext();
  const role = joinCtx ? "participant" : "host";

  const handleError = useCallback(
    (error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      navigate({
        to: "/room/error",
        search: { message: errorMessage, roomId },
      });
    },
    [navigate, roomId],
  );

  return (
    <div className="h-screen w-screen relative">
      {/*@ts-ignore*/}
      <VideoConference
        roomId={roomId}
        roomName={roomName || "Meeting On Chalk"}
        userName={storedUserName || (role === "host" ? "Host" : "Guest")}
        onError={handleError}
        onJoin={(data) => {
          console.log("Joined: ", data);
        }}
        onEnd={(data) => {
          localStorage.setItem("data", JSON.stringify(data));
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
          tour: false,
        }}
        defaults={{
          videoEnabled: false,
          layout: "grid",
          audioEnabled: false,
        }}
        className="h-full w-full"
      />

      {/* App-specific overlays */}
      <WhiteboardKeyboardShortcut />
      <ReactionBubblesOverlay />
    </div>
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
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
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

/**
 * Floating reaction bubbles overlay
 * Uses SDK's useInteractions to get active reactions
 */
function ReactionBubblesOverlay() {
  const { activeReactions } = useInteractions();

  if (activeReactions.length === 0) {
    return null;
  }

  return <ReactionBubbles reactions={activeReactions} />;
}

export default RoomPage;
