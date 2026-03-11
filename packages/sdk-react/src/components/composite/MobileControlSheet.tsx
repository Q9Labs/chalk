import React, { useCallback, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "../../utils/cn";
import { CircleIcon, FileTextIcon, HandIcon, Message01Icon, Microphone01Icon, MicrophoneOff01Icon, Monitor01Icon, MonitorOffIcon, Edit02Icon, CallEnd01Icon, Settings01Icon, SmileIcon, UserGroupIcon, Video01Icon, VideoOffIcon, PictureInPictureIcon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface MobileControlSheetProps {
  isOpen: boolean;
  onClose: () => void;

  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRecording?: boolean;
  isChatOpen?: boolean;
  isParticipantsOpen?: boolean;
  isTranscriptionEnabled?: boolean;
  isHandRaised?: boolean;
  isWhiteboardOpen?: boolean;
  isPictureInPictureActive?: boolean;

  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: () => void;
  onToggleHandRaise?: () => void;
  onToggleWhiteboard?: () => void;
  onOpenReactions?: () => void;
  onOpenSettings?: () => void;
  onTogglePictureInPicture?: () => Promise<void> | void;
  onLeave?: () => void;

  /** Enable certain optional features */
  enableScreenShare?: boolean;
  enableRecording?: boolean;
  enableHandRaise?: boolean;
  enableReactions?: boolean;
  enableWhiteboard?: boolean;
  enablePictureInPicture?: boolean;
  enableTranscription?: boolean;
  enableChat?: boolean;

  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

const SWIPE_THRESHOLD = 80;

export const MobileControlSheet = React.memo(
  ({
    isOpen,
    onClose,
    isMuted = false,
    isVideoEnabled = true,
    isScreenSharing = false,
    isRecording = false,
    isChatOpen = false,
    isParticipantsOpen = false,
    isTranscriptionEnabled = false,
    isHandRaised = false,
    isWhiteboardOpen = false,
    isPictureInPictureActive = false,
    onToggleMute,
    onToggleVideo,
    onToggleScreenShare,
    onToggleRecording,
    onToggleChat,
    onToggleParticipants,
    onToggleTranscription,
    onToggleHandRaise,
    onToggleWhiteboard,
    onOpenReactions,
    onOpenSettings,
    onTogglePictureInPicture,
    onLeave,
    enableScreenShare = true,
    enableRecording = true,
    enableHandRaise = true,
    enableReactions = true,
    enableWhiteboard = true,
    enablePictureInPicture = false,
    enableTranscription = true,
    enableChat = true,
    participantColorSeed,
    participantGradientPreference,
    className,
  }: MobileControlSheetProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [translateY, setTranslateY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const touchStartRef = useRef<{ y: number; time: number } | null>(null);
    const themeVariables = getParticipantThemeVariables(participantColorSeed, participantGradientPreference);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      touchStartRef.current = { y: touch.clientY, time: Date.now() };
      setIsDragging(true);
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;

      const deltaY = touch.clientY - touchStartRef.current.y;
      // Only allow swiping down (to close)
      if (deltaY > 0) {
        setTranslateY(deltaY);
      }
    }, []);

    const handleTouchEnd = useCallback(() => {
      if (!touchStartRef.current) return;

      // Close if swipe distance threshold met
      if (translateY > SWIPE_THRESHOLD) {
        onClose();
      }

      setTranslateY(0);
      setIsDragging(false);
      touchStartRef.current = null;
    }, [translateY, onClose]);

    const handleAction = useCallback(
      (action?: () => void) => {
        action?.();
        onClose();
      },
      [onClose],
    );

    const handleOpenChange = useCallback(
      (open: boolean) => {
        if (!open) {
          onClose();
        }
      },
      [onClose],
    );

    // Build control items dynamically based on enabled features
    const controlItems = [
      {
        key: "mic",
        icon: isMuted ? <MicrophoneOff01Icon className="w-6 h-6 text-destructive" /> : <Microphone01Icon className="w-6 h-6" />,
        label: isMuted ? "Unmute" : "Mute",
        active: !isMuted,
        action: onToggleMute,
        enabled: true,
      },
      {
        key: "video",
        icon: isVideoEnabled ? <Video01Icon className="w-6 h-6" /> : <VideoOffIcon className="w-6 h-6 text-destructive" />,
        label: isVideoEnabled ? "Stop Video" : "Start Video",
        active: isVideoEnabled,
        action: onToggleVideo,
        enabled: true,
      },
      {
        key: "screenshare",
        icon: isScreenSharing ? <MonitorOffIcon className="w-6 h-6" /> : <Monitor01Icon className="w-6 h-6" />,
        label: isScreenSharing ? "Stop Share" : "Share Screen",
        active: isScreenSharing,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleScreenShare,
        enabled: enableScreenShare && !!onToggleScreenShare,
      },
      {
        key: "pip",
        icon: <PictureInPictureIcon className="w-6 h-6" />,
        label: isPictureInPictureActive ? "Close PiP" : "Open PiP",
        active: isPictureInPictureActive,
        activeClassName: "bg-primary text-primary-foreground",
        action: onTogglePictureInPicture ? () => void onTogglePictureInPicture() : undefined,
        enabled: enablePictureInPicture && !!onTogglePictureInPicture,
      },
      {
        key: "chat",
        icon: <Message01Icon className="w-6 h-6" />,
        label: "Chat",
        active: isChatOpen,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleChat,
        enabled: enableChat && !!onToggleChat,
      },
      {
        key: "participants",
        icon: <UserGroupIcon className="w-6 h-6" />,
        label: "People",
        active: isParticipantsOpen,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleParticipants,
        enabled: !!onToggleParticipants,
      },
      {
        key: "handraise",
        icon: <HandIcon className="w-6 h-6" />,
        label: isHandRaised ? "Lower Hand" : "Raise Hand",
        active: isHandRaised,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleHandRaise,
        enabled: enableHandRaise && !!onToggleHandRaise,
      },
      {
        key: "reactions",
        icon: <SmileIcon className="w-6 h-6" />,
        label: "Reactions",
        active: false,
        action: onOpenReactions,
        enabled: enableReactions && !!onOpenReactions,
      },
      {
        key: "whiteboard",
        icon: <Edit02Icon className="w-6 h-6" />,
        label: "Whiteboard",
        active: isWhiteboardOpen,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleWhiteboard,
        enabled: enableWhiteboard && !!onToggleWhiteboard,
      },
      {
        key: "record",
        icon: <CircleIcon className={cn("w-6 h-6", isRecording && "fill-destructive text-destructive")} />,
        label: isRecording ? "Stop Recording" : "Record",
        active: isRecording,
        action: onToggleRecording,
        enabled: enableRecording && !!onToggleRecording,
      },
      {
        key: "transcription",
        icon: <FileTextIcon className="w-6 h-6" />,
        label: "Transcript",
        active: isTranscriptionEnabled,
        activeClassName: "bg-primary text-primary-foreground",
        action: onToggleTranscription,
        enabled: enableTranscription && !!onToggleTranscription,
      },
      {
        key: "settings",
        icon: <Settings01Icon className="w-6 h-6" />,
        label: "Settings",
        active: false,
        action: onOpenSettings,
        enabled: !!onOpenSettings,
      },
    ].filter((item) => item.enabled);

    return (
      <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          {/* Backdrop */}
          <Dialog.Backdrop className={cn("fixed inset-0 bg-background/80 z-40 transition-opacity duration-200", isOpen ? "opacity-100" : "opacity-0 pointer-events-none")} />

          {/* Sheet */}
          <Dialog.Popup
            className={cn("fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-card text-card-foreground", !prefersReducedMotion && !isDragging && "transition-transform duration-300 ease-out", isOpen ? "translate-y-0" : "translate-y-full", className)}
            style={{
              ...(themeVariables as React.CSSProperties),
              transform: isOpen && translateY > 0 ? `translateY(${translateY}px)` : undefined,
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <Dialog.Title className="sr-only">More controls</Dialog.Title>

            {/* Drag Handle */}
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
            </div>

            {/* Control Grid - 3 columns with 44px min touch targets */}
            <div className="grid grid-cols-3 gap-2 px-4 pt-2 pb-4">
              {controlItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => handleAction(item.action)}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2 py-4 px-2 rounded-xl min-h-[88px] active:scale-95 transition-all",
                    item.active && (item as any).activeClassName ? (item as any).activeClassName : item.active ? "bg-accent text-accent-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted",
                  )}
                  aria-label={item.label}
                  aria-pressed={item.active}
                >
                  {/* Icon container - ensures 44px touch target */}
                  <div className="flex items-center justify-center w-11 h-11">{item.icon}</div>
                  <span className="text-xs font-medium truncate max-w-full">{item.label}</span>
                </button>
              ))}
            </div>

            {/* Leave Button - Full width, prominent */}
            {onLeave && (
              <div className="px-4 pb-4">
                <button type="button" onClick={() => handleAction(onLeave)} className="w-full flex items-center justify-center gap-3 py-4 px-6 rounded-xl bg-destructive hover:bg-destructive/90 active:scale-[0.98] transition-all min-h-[56px]" aria-label="Leave meeting">
                  <CallEnd01Icon className="w-6 h-6 text-destructive-foreground" />
                  <span className="text-base font-semibold text-destructive-foreground">Leave Meeting</span>
                </button>
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  },
);

MobileControlSheet.displayName = "MobileControlSheet";
