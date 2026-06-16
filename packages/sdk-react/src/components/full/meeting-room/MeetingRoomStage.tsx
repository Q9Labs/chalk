import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useMemo } from "react";

import { cn } from "../../../utils/cn";
import type { ParticipantGradientPreference } from "../../../utils/colorGenerator";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon } from "../../../utils/icons";
import { ReactionBubble, VideoTile } from "../../atomic";
import { NotificationStack, ScreenShareView, VideoGrid } from "../../composite";
import { SplitStage } from "../SplitStage";
import { WhiteboardPanel } from "../WhiteboardPanel";
import { getParticipantColor } from "../../../utils/colorGenerator";
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
  localParticipantGradientPreference?: ParticipantGradientPreference;
}

export function MeetingRoomStage({
  isMobile,
  layout,
  isStageMode,
  isSplit,
  screenSharer,
  allParticipants,
  isFilmstripOpen,
  onToggleFilmstrip,
  enableWhiteboard,
  isWhiteboardOpen,
  theme,
  onWhiteboardExcalidrawApiReady,
  activeReactions,
  isExiting,
  localParticipantColorSeed,
  localParticipantGradientPreference,
}: MeetingRoomStageProps) {
  const localParticipantColor = useMemo(() => (localParticipantColorSeed ? getParticipantColor(localParticipantColorSeed, localParticipantGradientPreference).primary : undefined), [localParticipantColorSeed, localParticipantGradientPreference]);
  const shouldSuppressLocalScreenSharePreview = Boolean(screenSharer?.isLocal && screenSharer.screenShareTrack);
  const screenSharePanel = shouldSuppressLocalScreenSharePreview ? (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-2xl border border-border/40 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.12),_transparent_38%),linear-gradient(180deg,_color-mix(in_oklab,var(--background)_96%,transparent),_color-mix(in_oklab,var(--background)_88%,var(--secondary)_12%))] p-6 text-center">
      <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle,_var(--border)_1px,_transparent_1px)] [background-size:24px_24px]" />
      <div className="absolute inset-x-[18%] top-1/2 h-px bg-primary/10 blur-sm" />
      <div className="relative z-10 font-app max-w-xl">
        <p className="text-sm font-semibold tracking-[-0.01em] text-primary/85">Screen share active</p>
        <h2 className="font-display mt-5 text-[2.35rem] font-bold leading-[0.94] tracking-[-0.035em] text-foreground sm:text-[2.8rem]">Preview hidden in this window</h2>
        <p className="mx-auto mt-5 max-w-lg text-[15px] font-medium leading-7 text-muted-foreground">Chalk hides your own shared screen here while you are presenting so opening the main window does not create the infinite mirror effect.</p>
      </div>
    </div>
  ) : (
    <ScreenShareView screenShareTrack={screenSharer?.screenShareTrack!} sharedByName={screenSharer?.displayName || "Unknown"} participants={allParticipants} showThumbnails={false} />
  );

  return (
    <div className={cn("relative flex h-full min-h-0 min-w-0 flex-1 rounded-3xl overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.2,0,0,1)]", isStageMode && layout === "sidebar" ? "flex-row" : "flex-col", isExiting && "chalk-animate-void-exit")}>
      {isStageMode ? (
        <>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {isSplit && screenSharer?.screenShareTrack ? (
              <SplitStage leftPanel={screenSharePanel} rightPanel={<WhiteboardPanel participants={allParticipants} showThumbnails={false} theme={theme === "system" ? "auto" : theme} onExcalidrawApiReady={onWhiteboardExcalidrawApiReady} localParticipantColor={localParticipantColor} />} />
            ) : enableWhiteboard && isWhiteboardOpen ? (
              <WhiteboardPanel participants={allParticipants} showThumbnails={false} theme={theme === "system" ? "auto" : theme} onExcalidrawApiReady={onWhiteboardExcalidrawApiReady} localParticipantColor={localParticipantColor} />
            ) : (
              screenSharePanel
            )}

            {allParticipants.length > 0 && (
              <button
                type="button"
                onClick={onToggleFilmstrip}
                className={cn(
                  "absolute z-20 flex items-center justify-center bg-muted/80 border border-border text-foreground/80 hover:text-foreground hover:bg-muted transition-all duration-300 shadow-lg",
                  layout === "sidebar" ? "top-1/2 -translate-y-1/2 right-1 w-6 h-12 rounded-l-xl" : "left-1/2 -translate-x-1/2 bottom-1 w-12 h-6 rounded-t-xl",
                )}
                aria-label={isFilmstripOpen ? "Collapse filmstrip" : "Expand filmstrip"}
              >
                {layout === "sidebar" ? isFilmstripOpen ? <ArrowRight01Icon size={16} /> : <ArrowLeft01Icon size={16} /> : isFilmstripOpen ? <ArrowDown01Icon size={16} /> : <ArrowUp01Icon size={16} />}
              </button>
            )}
          </div>

          {isFilmstripOpen && allParticipants.length > 0 && (
            <div className={cn("flex gap-2 transition-all duration-500 ease-in-out", layout === "sidebar" ? "flex-col p-2 w-64 h-full overflow-y-auto border-l border-border" : "flex-row items-center p-2 h-40 w-full overflow-x-auto overflow-y-hidden scrollbar-none")}>
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
        <NotificationStack notifications={[]} onDismiss={() => {}} participantColorSeed={localParticipantColorSeed} participantGradientPreference={localParticipantGradientPreference} />
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
