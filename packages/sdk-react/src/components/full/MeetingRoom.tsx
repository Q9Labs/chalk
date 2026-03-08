import type React from "react";
import { memo, useCallback, useRef } from "react";

import { useDraggable } from "../../hooks/ui/useDraggable";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { MeetingRoomControls } from "./meeting-room/MeetingRoomControls";
import { MeetingRoomOverlays } from "./meeting-room/MeetingRoomOverlays";
import { MeetingRoomPanels } from "./meeting-room/MeetingRoomPanels";
import { MeetingRoomStage } from "./meeting-room/MeetingRoomStage";
import { MeetingRoomTopBar } from "./meeting-room/MeetingRoomTopBar";
import type { MeetingRoomProps } from "./meeting-room/types";
import { useMeetingRoomDerived } from "./meeting-room/useMeetingRoomDerived";
import { useMeetingRoomLifecycle } from "./meeting-room/useMeetingRoomLifecycle";
import { useMeetingRoomTheme } from "./meeting-room/useMeetingRoomTheme";
import { useMeetingRoomUiState } from "./meeting-room/useMeetingRoomUiState";

function MeetingRoomBase({
  roomName,
  localParticipant,
  participants,
  canManageParticipants = false,
  onToggleParticipantMute,
  onRemoveParticipant,
  activeReactions = [],
  isMuted = false,
  isVideoEnabled = false,
  isScreenSharing = false,
  isHandRaised = false,
  isWhiteboardOpen = false,
  isRecording = false,
  recordingDuration: _recordingDuration = 0,
  meetingDuration = 0,
  canRecord = false,
  transcripts = [],
  chatMessages = [],
  unreadChatCount = 0,
  onSendMessage,
  onSendMessageWithAttachments,
  onResolveChatAttachmentUrl,
  onChatOpen,
  enableChat = true,
  enableRecording = true,
  enableScreenShare = true,
  enableHandRaise = true,
  enableReactions = true,
  enableWhiteboard = true,
  enableTranscription = true,
  enableTour = true,
  defaultLayout = "grid",
  defaultChatOpen = false,
  defaultParticipantsOpen = false,
  defaultTranscriptionOpen = false,
  showTourOnFirstVisit = true,
  showInviteToastOnJoin = true,
  onToggleMute,
  onToggleVideo,
  onAudioInputChange,
  onAudioOutputChange,
  onVideoInputChange,
  onToggleScreenShare,
  onToggleRecording,
  onToggleHandRaise,
  onToggleWhiteboard,
  onSendReaction,
  onToggleTranscription,
  onLeave,
  onTourComplete,
  onAddPeople,
  connectionState = "connected",
  onRetryConnection,
  connectionSupportCode,
  audioInputDevices,
  audioOutputDevices,
  videoInputDevices,
  selectedAudioInput,
  participantVolumes,
  onParticipantVolumeChange,
  getParticipantVolume,
  selectedAudioOutput,
  selectedVideoInput,
  theme = "system",
  onWhiteboardExcalidrawApiReady,
  className,
}: MeetingRoomProps): React.JSX.Element {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const { dragHandlers: pillDragHandlers } = useDraggable(pillRef, {
    boundaryRef: containerRef,
    snapToCorners: true,
    cornerMargin: 24,
    bounce: 0.2,
    friction: 0.94,
  });

  const ui = useMeetingRoomUiState({
    defaultChatOpen,
    defaultParticipantsOpen,
    defaultTranscriptionOpen,
    defaultLayout,
    showInviteToastOnJoin,
    onChatOpen,
  });
  const { isDarkMode, toggleTheme } = useMeetingRoomTheme({ theme });
  const { handleTourComplete, handleCopyLink } = useMeetingRoomLifecycle({
    enableTour,
    showTourOnFirstVisit,
    defaultChatOpen,
    onChatOpen,
    onToggleMute,
    onToggleVideo,
    onLeave,
    onTourComplete,
    setShowTour: ui.setShowTour,
    setIsExiting: ui.setIsExiting,
  });
  const { allParticipants, screenSharer, isSplit, isStageMode } = useMeetingRoomDerived({
    participants,
    localParticipant,
    isMobile,
    enableWhiteboard,
    isWhiteboardOpen,
  });
  const participantColorSeed = localParticipant.displayName || localParticipant.id;

  const handleAddPeople = useCallback(() => {
    ui.setShowInviteModal(true);
    onAddPeople?.();
  }, [onAddPeople, ui.setShowInviteModal]);

  return (
    <div
      ref={containerRef}
      data-chalk
      className={cn("chalk-root chalk-theme-transition relative h-screen w-full overflow-hidden flex flex-col bg-background text-foreground", isMobile ? "p-2" : "p-0", className)}
      data-chalk-theme={theme === "system" ? undefined : theme}
      style={getParticipantThemeVariables(participantColorSeed) as React.CSSProperties}
    >
      {/* Initial Ambient Mist FX */}
      <div className={cn(
        "absolute inset-0 pointer-events-none z-0 overflow-hidden animate-out fade-out duration-[7000ms] delay-[4000ms] fill-mode-forwards",
        isDarkMode ? "mix-blend-screen" : "mix-blend-multiply"
      )}>
        <div 
          className="absolute w-[150vw] h-[150vh] -top-[25vh] -left-[25vw] opacity-40 dark:opacity-20 animate-[spin_15s_linear_infinite]"
          style={{ background: 'radial-gradient(ellipse at 40% 40%, var(--primary) 0%, transparent 60%)', filter: 'blur(100px)' }} 
        />
        <div 
          className="absolute w-[150vw] h-[150vh] -top-[25vh] -left-[25vw] opacity-30 dark:opacity-10 animate-[spin_20s_linear_infinite_reverse]"
          style={{ background: 'radial-gradient(ellipse at 60% 60%, var(--accent) 0%, transparent 60%)', filter: 'blur(120px)' }} 
        />
      </div>

      <div className="animate-in fade-in slide-in-from-top-4 duration-700 ease-out fill-mode-both delay-100 w-full z-10 relative">
        <MeetingRoomTopBar isMobile={isMobile} roomName={roomName} activePanel={ui.activePanel} layout={ui.layout} setLayout={ui.setLayout} isDarkMode={isDarkMode} onToggleTheme={toggleTheme} pillRef={pillRef} pillDragHandlers={pillDragHandlers} />
      </div>

      <div className={cn("flex-1 min-h-0 relative flex flex-row overflow-hidden animate-in fade-in zoom-in-[0.98] duration-1000 ease-out fill-mode-both z-0", isMobile ? "gap-2 pt-2" : "gap-4 px-4 pt-4", ui.isExiting && "pointer-events-none")}>
        <MeetingRoomStage
          isMobile={isMobile}
          layout={ui.layout}
          isStageMode={isStageMode}
          isSplit={isSplit}
          screenSharer={screenSharer}
          allParticipants={allParticipants}
          isFilmstripOpen={ui.isFilmstripOpen}
          onToggleFilmstrip={() => ui.setIsFilmstripOpen(!ui.isFilmstripOpen)}
          enableWhiteboard={enableWhiteboard}
          isWhiteboardOpen={isWhiteboardOpen}
          theme={theme}
          onWhiteboardExcalidrawApiReady={onWhiteboardExcalidrawApiReady}
          activeReactions={activeReactions}
          isExiting={ui.isExiting}
          localParticipantColorSeed={participantColorSeed}
        />

        <MeetingRoomPanels
          isMobile={isMobile}
          activePanel={ui.activePanel}
          onClosePanel={() => ui.setActivePanel(null)}
          allParticipants={allParticipants}
          canManageParticipants={canManageParticipants}
          onToggleParticipantMute={onToggleParticipantMute}
          onRemoveParticipant={onRemoveParticipant}
          onAddPeople={handleAddPeople}
          chatMessages={chatMessages}
          onSendMessage={onSendMessage}
          onSendMessageWithAttachments={onSendMessageWithAttachments}
          onResolveChatAttachmentUrl={onResolveChatAttachmentUrl}
          transcripts={transcripts}
          participantVolumes={participantVolumes}
          onParticipantVolumeChange={onParticipantVolumeChange}
          localParticipantColorSeed={participantColorSeed}
        />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out fill-mode-both delay-300 w-full z-10 relative">
        <MeetingRoomControls
          isMobile={isMobile}
          activePanel={ui.activePanel}
          onTogglePanel={ui.togglePanel}
          isMobileSheetOpen={ui.isMobileSheetOpen}
          setIsMobileSheetOpen={ui.setIsMobileSheetOpen}
          isReactionPickerOpen={ui.isReactionPickerOpen}
          setIsReactionPickerOpen={ui.setIsReactionPickerOpen}
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          isScreenSharing={isScreenSharing}
          isHandRaised={isHandRaised}
          isWhiteboardOpen={isWhiteboardOpen}
          isRecording={isRecording}
          meetingDuration={meetingDuration}
          unreadChatCount={unreadChatCount}
          canRecord={canRecord}
          enableScreenShare={enableScreenShare}
          enableRecording={enableRecording}
          enableHandRaise={enableHandRaise}
          enableReactions={enableReactions}
          enableWhiteboard={enableWhiteboard}
          enableTranscription={enableTranscription}
          enableChat={enableChat}
          audioInputDevices={audioInputDevices}
          audioOutputDevices={audioOutputDevices}
          videoInputDevices={videoInputDevices}
          selectedAudioInput={selectedAudioInput}
          selectedAudioOutput={selectedAudioOutput}
          selectedVideoInput={selectedVideoInput}
          onToggleMute={onToggleMute}
          onToggleVideo={onToggleVideo}
          onAudioInputChange={onAudioInputChange}
          onAudioOutputChange={onAudioOutputChange}
          onVideoInputChange={onVideoInputChange}
          onToggleScreenShare={onToggleScreenShare}
          onToggleRecording={onToggleRecording}
          onToggleHandRaise={onToggleHandRaise}
          onToggleWhiteboard={onToggleWhiteboard}
          onToggleTranscription={onToggleTranscription}
          onSendReaction={onSendReaction}
          onLeave={onLeave}
          isExiting={ui.isExiting}
          localParticipantColorSeed={participantColorSeed}
        />
      </div>

      <MeetingRoomOverlays
        connectionState={connectionState}
        onRetryConnection={onRetryConnection}
        connectionSupportCode={connectionSupportCode}
        enableTour={enableTour}
        showTour={ui.showTour}
        onTourComplete={handleTourComplete}
        showInviteModal={ui.showInviteModal}
        setShowInviteModal={ui.setShowInviteModal}
        showInviteToast={ui.showInviteToast}
        setShowInviteToast={ui.setShowInviteToast}
        isMobile={isMobile}
        roomName={roomName}
        onCopyLink={handleCopyLink}
        allParticipants={allParticipants}
        getParticipantVolume={getParticipantVolume}
        selectedAudioOutput={selectedAudioOutput}
      />
    </div>
  );
}

export type { ActiveReaction, ChatMessage, MeetingPanel, Participant, TranscriptEntry, MeetingRoomProps } from "./meeting-room/types";

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
