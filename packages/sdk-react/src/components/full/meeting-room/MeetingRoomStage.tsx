import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { cn } from "../../../utils/cn";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon } from "../../../utils/icons";
import { ReactionBubble, VideoTile } from "../../atomic";
import { NotificationStack, ScreenShareView, VideoGrid } from "../../composite";
import { SplitStage } from "../SplitStage";
import { WhiteboardPanel } from "../WhiteboardPanel";
import type { ActiveReaction, MeetingLayout, Participant } from "./types";

interface MeetingRoomStageProps {
  isMobile: boolean;
  layout: MeetingLayout;
  isStageMode: boolean;
  isSplit: boolean;
  screenSharer?: Participant;
  allParticipants: Participant[];
  isFilmstripOpen: boolean;
  onToggleFilmstrip: () => void;
  enableWhiteboard: boolean;
  isWhiteboardOpen: boolean;
  theme: "light" | "dark" | "system";
  onWhiteboardExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  activeReactions: readonly ActiveReaction[];
  isExiting: boolean;
  localParticipantColorSeed?: string;
}

export function MeetingRoomStage({ isMobile, layout, isStageMode, isSplit, screenSharer, allParticipants, isFilmstripOpen, onToggleFilmstrip, enableWhiteboard, isWhiteboardOpen, theme, onWhiteboardExcalidrawApiReady, activeReactions, isExiting, localParticipantColorSeed }: MeetingRoomStageProps) {
  return (
    <div className={cn("flex-1 h-full min-w-0 relative flex rounded-3xl overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.2,0,0,1)]", isStageMode && layout === "sidebar" ? "flex-row" : "flex-col", isExiting && "chalk-animate-void-exit")}>
      {isStageMode ? (
        <>
          <div className="flex-1 relative min-h-0 min-w-0">
            {isSplit && screenSharer?.screenShareTrack ? (
              <SplitStage
                leftPanel={<ScreenShareView screenShareTrack={screenSharer.screenShareTrack} sharedByName={screenSharer.displayName || "Unknown"} participants={allParticipants} showThumbnails={false} />}
                rightPanel={<WhiteboardPanel participants={allParticipants} showThumbnails={false} theme={theme === "system" ? "auto" : theme} onExcalidrawApiReady={onWhiteboardExcalidrawApiReady} />}
              />
            ) : enableWhiteboard && isWhiteboardOpen ? (
              <WhiteboardPanel participants={allParticipants} showThumbnails={false} theme={theme === "system" ? "auto" : theme} onExcalidrawApiReady={onWhiteboardExcalidrawApiReady} />
            ) : (
              <ScreenShareView screenShareTrack={screenSharer?.screenShareTrack!} sharedByName={screenSharer?.displayName || "Unknown"} participants={allParticipants} showThumbnails={false} />
            )}

            {allParticipants.length > 0 && (
              <button
                type="button"
                onClick={onToggleFilmstrip}
                className={cn(
                  "absolute z-20 flex items-center justify-center bg-zinc-950/50 backdrop-blur-md border border-white/10 text-white/80 hover:text-white hover:bg-zinc-950/80 transition-all duration-300 shadow-lg",
                  layout === "sidebar" ? "top-1/2 -translate-y-1/2 right-1 w-6 h-12 rounded-l-xl" : "left-1/2 -translate-x-1/2 bottom-1 w-12 h-6 rounded-t-xl",
                )}
                aria-label={isFilmstripOpen ? "Collapse filmstrip" : "Expand filmstrip"}
              >
                {layout === "sidebar" ? isFilmstripOpen ? <ArrowRight01Icon size={16} /> : <ArrowLeft01Icon size={16} /> : isFilmstripOpen ? <ArrowDown01Icon size={16} /> : <ArrowUp01Icon size={16} />}
              </button>
            )}
          </div>

          {isFilmstripOpen && allParticipants.length > 0 && (
            <div className={cn("flex gap-2 transition-all duration-500 ease-in-out", layout === "sidebar" ? "flex-col p-2 w-64 h-full overflow-y-auto border-l border-white/5" : "flex-row items-center p-2 h-40 w-full overflow-x-auto overflow-y-hidden scrollbar-none")}>
              {allParticipants.map((participant, index) => (
                <div key={participant.id} className={cn("shrink-0 relative transition-all duration-300 hover:scale-[1.02]", layout === "sidebar" ? "aspect-video w-full" : "aspect-video h-full")}>
                  <VideoTile
                    participant={{
                      id: participant.id,
                      displayName: participant.displayName,
                      isLocal: participant.isLocal,
                      isSpeaking: participant.isSpeaking,
                      isMuted: participant.isMuted,
                      isVideoEnabled: participant.isVideoEnabled,
                      isScreenSharing: participant.isScreenSharing,
                      isHandRaised: participant.isHandRaised,
                      connectionQuality: participant.connectionQuality && participant.connectionQuality > 0 ? (participant.connectionQuality as 1 | 2 | 3 | 4) : undefined,
                      avatarUrl: participant.avatarUrl,
                    }}
                    videoTrack={participant.videoTrack}
                    className="w-full h-full chalk-animate-tile-pop"
                    style={{ animationDelay: `${index * 100}ms` }}
                    showName={true}
                    showStatus={true}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <VideoGrid participants={allParticipants} layout={layout} variant={isMobile ? "mobile" : "desktop"} className="p-4" />
      )}

      <div className="absolute top-14 right-4 z-50">
        <NotificationStack notifications={[]} onDismiss={() => {}} participantColorSeed={localParticipantColorSeed} />
      </div>

      {activeReactions.length > 0 && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 flex gap-2 pointer-events-none">
          {activeReactions.map((reaction) => (
            <ReactionBubble key={reaction.id} emoji={reaction.emoji} participantName={reaction.participantName} />
          ))}
        </div>
      )}
    </div>
  );
}
