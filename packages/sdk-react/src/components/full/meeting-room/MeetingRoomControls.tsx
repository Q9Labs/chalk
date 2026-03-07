import { cn } from "../../../utils/cn";
import { ControlBar, MobileControlSheet, ReactionPicker } from "../../composite";
import type { MeetingPanel } from "./types";

interface MeetingRoomControlsProps {
  isMobile: boolean;
  activePanel: MeetingPanel | null;
  onTogglePanel: (panel: MeetingPanel) => void;
  isMobileSheetOpen: boolean;
  setIsMobileSheetOpen: (open: boolean) => void;
  isReactionPickerOpen: boolean;
  setIsReactionPickerOpen: (open: boolean) => void;
  isMuted: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  isWhiteboardOpen: boolean;
  isRecording: boolean;
  meetingDuration: number;
  unreadChatCount: number;
  canRecord: boolean;
  enableScreenShare: boolean;
  enableRecording: boolean;
  enableHandRaise: boolean;
  enableReactions: boolean;
  enableWhiteboard: boolean;
  enableTranscription: boolean;
  enableChat: boolean;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onToggleTranscription?: () => void;
  onSendReaction?: (emoji: string) => void;
  onLeave?: () => void;
  onAnimatedLeave: () => void;
  isExiting: boolean;
  localParticipantColorSeed?: string;
}

export function MeetingRoomControls({
  isMobile,
  activePanel,
  onTogglePanel,
  isMobileSheetOpen,
  setIsMobileSheetOpen,
  isReactionPickerOpen,
  setIsReactionPickerOpen,
  isMuted,
  isVideoEnabled,
  isScreenSharing,
  isHandRaised,
  isWhiteboardOpen,
  isRecording,
  meetingDuration,
  unreadChatCount,
  canRecord,
  enableScreenShare,
  enableRecording,
  enableHandRaise,
  enableReactions,
  enableWhiteboard,
  enableTranscription,
  enableChat,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  onToggleRecording,
  onToggleHandRaise,
  onToggleWhiteboard,
  onToggleTranscription,
  onSendReaction,
  onLeave,
  onAnimatedLeave,
  isExiting,
  localParticipantColorSeed,
}: MeetingRoomControlsProps) {
  return (
    <>
      {isMobile && (
        <MobileControlSheet
          isOpen={isMobileSheetOpen}
          onClose={() => setIsMobileSheetOpen(false)}
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          isScreenSharing={isScreenSharing}
          isRecording={isRecording}
          isChatOpen={activePanel === "chat"}
          isParticipantsOpen={activePanel === "participants"}
          isTranscriptionEnabled={activePanel === "transcription"}
          isHandRaised={isHandRaised}
          isWhiteboardOpen={isWhiteboardOpen}
          onToggleMute={onToggleMute}
          onToggleVideo={onToggleVideo}
          onToggleScreenShare={enableScreenShare ? onToggleScreenShare : undefined}
          onToggleRecording={enableRecording && canRecord ? onToggleRecording : undefined}
          onToggleChat={
            enableChat
              ? () => {
                  onTogglePanel("chat");
                  setIsMobileSheetOpen(false);
                }
              : undefined
          }
          onToggleParticipants={() => {
            onTogglePanel("participants");
            setIsMobileSheetOpen(false);
          }}
          onToggleTranscription={
            enableTranscription
              ? () => {
                  onTogglePanel("transcription");
                  onToggleTranscription?.();
                  setIsMobileSheetOpen(false);
                }
              : undefined
          }
          onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
          onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
          onOpenReactions={
            enableReactions
              ? () => {
                  setIsReactionPickerOpen(true);
                  setIsMobileSheetOpen(false);
                }
              : undefined
          }
          onLeave={onLeave}
          enableScreenShare={enableScreenShare}
          enableRecording={enableRecording}
          enableHandRaise={enableHandRaise}
          enableReactions={enableReactions}
          enableWhiteboard={enableWhiteboard}
          enableTranscription={enableTranscription}
          enableChat={enableChat}
          participantColorSeed={localParticipantColorSeed}
        />
      )}

      <div className="shrink-0 z-20 w-full flex justify-center mt-[-1px]">
        <div className="relative w-full">
          <ControlBar
            variant={isMobile ? "mobile" : "dock"}
            isMuted={isMuted}
            isVideoEnabled={isVideoEnabled}
            isScreenSharing={isScreenSharing}
            isHandRaised={isHandRaised}
            isWhiteboardOpen={isWhiteboardOpen}
            isRecording={isRecording}
            meetingDuration={meetingDuration}
            unreadChatCount={unreadChatCount}
            isChatOpen={activePanel === "chat"}
            isParticipantsOpen={activePanel === "participants"}
            isTranscriptionEnabled={activePanel === "transcription"}
            onToggleMute={onToggleMute}
            onToggleVideo={onToggleVideo}
            onToggleScreenShare={enableScreenShare ? onToggleScreenShare : undefined}
            onToggleRecording={enableRecording && canRecord ? onToggleRecording : undefined}
            onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
            onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
            onLeave={onAnimatedLeave}
            onToggleChat={enableChat ? () => onTogglePanel("chat") : undefined}
            onToggleParticipants={() => onTogglePanel("participants")}
            onToggleTranscription={
              enableTranscription
                ? () => {
                    onTogglePanel("transcription");
                    onToggleTranscription?.();
                  }
                : undefined
            }
            onOpenReactions={enableReactions ? () => setIsReactionPickerOpen(true) : undefined}
            onOpenMore={isMobile ? () => setIsMobileSheetOpen(true) : undefined}
            participantColorSeed={localParticipantColorSeed}
            className={cn(isMobile ? "absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] touch-manipulation" : "", isExiting ? "chalk-animate-dock-down" : "chalk-animate-dock-up")}
          />
          {enableReactions && !isMobile && (
            <ReactionPicker
              isOpen={isReactionPickerOpen}
              onClose={() => setIsReactionPickerOpen(false)}
              onSelect={(emoji) => {
                onSendReaction?.(emoji);
                setIsReactionPickerOpen(false);
              }}
              participantColorSeed={localParticipantColorSeed}
              position="top"
              className="absolute bottom-24 left-1/2 -translate-x-1/2"
            />
          )}
        </div>
      </div>
    </>
  );
}
