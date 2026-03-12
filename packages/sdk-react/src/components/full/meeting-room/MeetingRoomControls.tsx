import type { MediaDevice } from "@q9labs/chalk-core";
import { cn } from "../../../utils/cn";
import type { ParticipantGradientPreference } from "../../../utils/colorGenerator";
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
  enablePictureInPicture: boolean;
  enableTranscription: boolean;
  enableChat: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  audioInputDevices?: readonly MediaDevice[];
  audioOutputDevices?: readonly MediaDevice[];
  videoInputDevices?: readonly MediaDevice[];
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  selectedVideoInput?: string;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  onVideoInputChange?: (deviceId: string) => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onToggleTranscription?: () => void;
  onTogglePictureInPicture?: () => Promise<void> | void;
  onSendReaction?: (emoji: string) => void;
  onLeave?: () => void;
  onOpenSettings?: () => void;
  isExiting: boolean;
  localParticipantColorSeed?: string;
  localParticipantGradientPreference?: ParticipantGradientPreference;
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
  enablePictureInPicture,
  enableTranscription,
  enableChat,
  isPictureInPictureSupported,
  isPictureInPictureActive,
  audioInputDevices,
  audioOutputDevices,
  videoInputDevices,
  selectedAudioInput,
  selectedAudioOutput,
  selectedVideoInput,
  onToggleMute,
  onToggleVideo,
  onAudioInputChange,
  onAudioOutputChange,
  onVideoInputChange,
  onToggleScreenShare,
  onToggleRecording,
  onToggleHandRaise,
  onToggleWhiteboard,
  onToggleTranscription,
  onTogglePictureInPicture,
  onSendReaction,
  onLeave,
  onOpenSettings,
  isExiting,
  localParticipantColorSeed,
  localParticipantGradientPreference,
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
          onOpenSettings={() => {
            onOpenSettings?.();
            setIsMobileSheetOpen(false);
          }}
          onLeave={onLeave}
          enableScreenShare={enableScreenShare}
          enableRecording={enableRecording}
          enableHandRaise={enableHandRaise}
          enableReactions={enableReactions}
          enableWhiteboard={enableWhiteboard}
          enablePictureInPicture={enablePictureInPicture && Boolean(isPictureInPictureSupported)}
          enableTranscription={enableTranscription}
          enableChat={enableChat}
          isPictureInPictureActive={isPictureInPictureActive}
          participantColorSeed={localParticipantColorSeed}
          participantGradientPreference={localParticipantGradientPreference}
          onTogglePictureInPicture={enablePictureInPicture && isPictureInPictureSupported ? onTogglePictureInPicture : undefined}
        />
      )}

      <div className={cn("shrink-0 z-20 w-full flex justify-center", !isMobile && "mt-[-1px]")}>
        <div className="relative w-full">
          <ControlBar
            variant={isMobile ? "mobile" : "dock"}
            isMuted={isMuted}
            isVideoEnabled={isVideoEnabled}
            isScreenSharing={isScreenSharing}
            isHandRaised={isHandRaised}
            isWhiteboardOpen={isWhiteboardOpen}
            isRecording={isRecording}
            isPictureInPictureActive={isPictureInPictureActive}
            meetingDuration={meetingDuration}
            unreadChatCount={unreadChatCount}
            isChatOpen={activePanel === "chat"}
            isParticipantsOpen={activePanel === "participants"}
            isTranscriptionEnabled={activePanel === "transcription"}
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
            onToggleScreenShare={enableScreenShare && !isMobile ? onToggleScreenShare : undefined}
            onToggleRecording={enableRecording && canRecord ? onToggleRecording : undefined}
            onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
            onToggleWhiteboard={enableWhiteboard ? onToggleWhiteboard : undefined}
            onTogglePictureInPicture={enablePictureInPicture && isPictureInPictureSupported ? onTogglePictureInPicture : undefined}
            onLeave={onLeave}
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
            onOpenSettings={onOpenSettings}
            onOpenMore={isMobile ? () => setIsMobileSheetOpen(true) : undefined}
            participantColorSeed={localParticipantColorSeed}
            participantGradientPreference={localParticipantGradientPreference}
            className={cn(isMobile ? "z-[60] touch-manipulation" : "", isExiting ? "chalk-animate-dock-down" : "chalk-animate-dock-up")}
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
              participantGradientPreference={localParticipantGradientPreference}
              position="top"
              className="absolute bottom-24 left-1/2 -translate-x-1/2"
            />
          )}
        </div>
      </div>
    </>
  );
}
