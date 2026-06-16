import type React from "react";
import type { RefObject } from "react";

import { cn } from "../../../utils/cn";
import { getParticipantColor, type ParticipantGradientPreference } from "../../../utils/colorGenerator";
import { PreJoinHeader } from "./PreJoinHeader";
import { PreJoinMobilePreview } from "./PreJoinMobilePreview";
import { PreJoinMobileControls } from "./PreJoinMobileControls";
import { PreJoinMobileJoinSheet } from "./PreJoinMobileJoinSheet";

interface PreJoinLobbyMobileProps {
  roomName?: string;
  displayName: string;
  isDarkMode: boolean;
  isLoading: boolean;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  audioLevel: number;
  normalizedAudioLevel: number;
  participantGradient: string;
  participantGradientPreference?: ParticipantGradientPreference;
  videoRef: RefObject<HTMLVideoElement | null>;
  effectiveVideoDevices: MediaDeviceInfo[];
  effectiveAudioInputDevices: MediaDeviceInfo[];
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  onToggleTheme: () => void;
  onToggleVideo: () => void;
  onToggleAudio: () => void;
  onVideoDeviceChange: (deviceId: string) => void;
  onAudioInputChange: (deviceId: string) => void;
  onToggleSettings: () => void;
  onDisplayNameChange: (value: string) => void;
  onJoin: (displayNameOverride?: string) => void;
  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  onTogglePictureInPicture?: () => Promise<void> | void;
}

export function PreJoinLobbyMobile({
  roomName,
  displayName,
  isDarkMode,
  isLoading,
  isVideoEnabled,
  isAudioEnabled,
  audioLevel,
  participantGradient,
  participantGradientPreference,
  videoRef,
  effectiveVideoDevices,
  effectiveAudioInputDevices,
  selectedVideoDevice,
  selectedAudioInput,
  onToggleTheme,
  onToggleVideo,
  onToggleAudio,
  onVideoDeviceChange,
  onAudioInputChange,
  onToggleSettings,
  onDisplayNameChange,
  onJoin,
}: PreJoinLobbyMobileProps): React.JSX.Element {
  const participantColors = getParticipantColor(displayName, participantGradientPreference);

  return (
    <div
      className={cn("relative w-full h-full flex flex-col overflow-hidden", isDarkMode ? "dark" : "")}
      style={
        {
          "--primary": participantColors.primary,
        } as React.CSSProperties
      }
    >
      {/* Video Preview Layer */}
      <PreJoinMobilePreview videoRef={videoRef} displayName={displayName} isVideoEnabled={isVideoEnabled} isAudioEnabled={isAudioEnabled} audioLevel={audioLevel} participantGradient={participantGradient} participantGradientPreference={participantGradientPreference} />

      {/* UI Overlay Layer */}
      <div className="relative z-10 flex flex-col h-full pointer-events-none">
        {/* Header */}
        <div className="pt-[env(safe-area-inset-top)] pointer-events-auto">
          <PreJoinHeader roomName={roomName} isDarkMode={isDarkMode} onToggleTheme={onToggleTheme} variant="mobile" />
        </div>

        {/* Controls - Positioned above bottom sheet */}
        <div className="flex-1 pointer-events-none" />

        <div className="flex justify-center pb-6 pointer-events-auto">
          <PreJoinMobileControls
            isAudioEnabled={isAudioEnabled}
            isVideoEnabled={isVideoEnabled}
            effectiveAudioInputDevices={effectiveAudioInputDevices}
            effectiveVideoDevices={effectiveVideoDevices}
            selectedAudioInput={selectedAudioInput}
            selectedVideoDevice={selectedVideoDevice}
            onAudioInputChange={onAudioInputChange}
            onVideoDeviceChange={onVideoDeviceChange}
            onToggleAudio={onToggleAudio}
            onToggleVideo={onToggleVideo}
            onToggleSettings={onToggleSettings}
          />
        </div>

        {/* Bottom Join Sheet */}
        <div className="pointer-events-auto">
          <PreJoinMobileJoinSheet displayName={displayName} isLoading={isLoading} onDisplayNameChange={onDisplayNameChange} onJoin={onJoin} />
        </div>
      </div>
    </div>
  );
}
