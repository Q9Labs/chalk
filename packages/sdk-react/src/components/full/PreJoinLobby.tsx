import type React from "react";
import { memo, useCallback, useEffect, useId, useMemo, useRef } from "react";

import { cn } from "../../utils/cn";
import { getParticipantGradient, getParticipantColor } from "../../utils/colorGenerator";
import { usePictureInPicture } from "../../hooks/ui/usePictureInPicture";
import { DiagnosticErrorSheet } from "../composite";
import { LoadingScreen } from "./LoadingScreen";
import { buildPreJoinPictureInPictureSource } from "./picture-in-picture";
import { useSharedPictureInPicture } from "./picture-in-picture/PictureInPictureContext";
import { PreJoinFloatingControls } from "./prejoin-lobby/PreJoinFloatingControls";
import { PreJoinHeader } from "./prejoin-lobby/PreJoinHeader";
import { PreJoinJoinPanel } from "./prejoin-lobby/PreJoinJoinPanel";
import { PreJoinPreviewPane } from "./prejoin-lobby/PreJoinPreviewPane";
import { PreJoinSettingsModal } from "./prejoin-lobby/PreJoinSettingsModal";
import type { PreJoinLobbyProps } from "./prejoin-lobby/types";
import { usePreJoinAudioMeter } from "./prejoin-lobby/usePreJoinAudioMeter";
import { usePreJoinMedia } from "./prejoin-lobby/usePreJoinMedia";
import { usePreJoinTheme } from "./prejoin-lobby/usePreJoinTheme";
import { usePreJoinUiState } from "./prejoin-lobby/usePreJoinUiState";

function PreJoinLobbyBase({
  roomName,
  userName = "Guest",
  onJoin,
  onCancel,
  videoTrack,
  audioTrack,
  audioLevel,
  videoDevices = [],
  audioInputDevices = [],
  audioOutputDevices = [],
  selectedVideoDevice,
  selectedAudioInput,
  selectedAudioOutput,
  onVideoDeviceChange = () => {},
  onAudioInputChange = () => {},
  onAudioOutputChange = () => {},
  initialVideoEnabled = true,
  initialAudioEnabled = true,
  initialShowSettings = false,
  isLoading = false,
  error,
  supportCode,
  participantGradient: propParticipantGradient,
  initialTheme = "dark",
  enablePictureInPicture = false,
  isPictureInPictureActive,
  isPictureInPictureSupported,
  onTogglePictureInPicture,
  className,
}: PreJoinLobbyProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const ui = usePreJoinUiState({
    userName,
    error,
    initialVideoEnabled,
    initialAudioEnabled,
    initialShowSettings,
    selectedVideoDevice,
    selectedAudioInput,
    selectedAudioOutput,
    onJoin,
    dropdownRef,
  });

  const { isDarkMode, toggleTheme } = usePreJoinTheme({ initialTheme });
  const handleVideoUnavailable = useCallback(() => {
    ui.setIsVideoEnabled(false);
  }, [ui.setIsVideoEnabled]);
  const handleAudioUnavailable = useCallback(() => {
    ui.setIsAudioEnabled(false);
  }, [ui.setIsAudioEnabled]);

  const { activeVideoTrack, activeAudioTrack, effectiveVideoDevices, effectiveAudioInputDevices } = usePreJoinMedia({
    videoTrack,
    audioTrack,
    videoDevices,
    audioInputDevices,
    selectedVideoDevice,
    selectedAudioInput,
    isVideoEnabled: ui.isVideoEnabled,
    isAudioEnabled: ui.isAudioEnabled,
    onVideoUnavailable: handleVideoUnavailable,
    onAudioUnavailable: handleAudioUnavailable,
    videoRef,
  });

  const { audioLevel: activeAudioLevel } = usePreJoinAudioMeter({
    track: activeAudioTrack,
    isAudioEnabled: ui.isAudioEnabled,
    externalAudioLevel: audioLevel,
  });

  const participantGradient = useMemo(() => propParticipantGradient || getParticipantGradient(ui.displayName), [propParticipantGradient, ui.displayName]);
  const hasExternalPictureInPicture = typeof onTogglePictureInPicture === "function";
  const sharedPictureInPicture = useSharedPictureInPicture();
  const registerSharedPictureInPicture = sharedPictureInPicture?.register;
  const pictureInPictureOwnerId = useId();
  const pictureInPictureSource = useMemo(
    () =>
      buildPreJoinPictureInPictureSource({
        displayName: ui.displayName,
        videoTrack: activeVideoTrack,
        isAudioEnabled: ui.isAudioEnabled,
        isVideoEnabled: ui.isVideoEnabled,
      }),
    [ui.displayName, activeVideoTrack, ui.isAudioEnabled, ui.isVideoEnabled],
  );
  const pictureInPictureOptions = useMemo(
    () => ({
      phase: "prejoin" as const,
      roomName,
      displayName: ui.displayName,
      source: pictureInPictureSource,
      controls: {
        isMuted: !ui.isAudioEnabled,
        isVideoEnabled: ui.isVideoEnabled,
        onToggleMute: ui.toggleAudio,
        onToggleVideo: ui.toggleVideo,
      },
    }),
    [roomName, ui.displayName, pictureInPictureSource, ui.isAudioEnabled, ui.isVideoEnabled, ui.toggleAudio, ui.toggleVideo],
  );

  useEffect(() => {
    if (!registerSharedPictureInPicture || hasExternalPictureInPicture || !enablePictureInPicture) {
      return;
    }

    registerSharedPictureInPicture(pictureInPictureOwnerId, pictureInPictureOptions);

    return () => {
      registerSharedPictureInPicture(pictureInPictureOwnerId, null);
    };
  }, [enablePictureInPicture, hasExternalPictureInPicture, pictureInPictureOptions, pictureInPictureOwnerId, registerSharedPictureInPicture]);

  const internalPictureInPicture = usePictureInPicture({
    enabled: enablePictureInPicture && !hasExternalPictureInPicture && !sharedPictureInPicture,
    ...pictureInPictureOptions,
  });
  const pictureInPicture = hasExternalPictureInPicture
    ? {
        isActive: Boolean(isPictureInPictureActive),
        isSupported: Boolean(isPictureInPictureSupported),
        toggle: onTogglePictureInPicture,
      }
    : sharedPictureInPicture
      ? sharedPictureInPicture
      : internalPictureInPicture;
  const normalizedAudioLevel = Math.min(100, Math.max(0, activeAudioLevel * 100));
  const hasVideoDevices = effectiveVideoDevices.length > 0;
  const hasAudioInput = effectiveAudioInputDevices.length > 0;
  const hasAudioOutput = audioOutputDevices.length > 0;

  return (
    <div data-chalk data-chalk-theme={isDarkMode ? "dark" : "light"} className={cn("chalk-root min-h-screen flex flex-col overflow-hidden relative", isDarkMode && "dark", className)} style={{ "--primary": getParticipantColor(ui.displayName).primary } as React.CSSProperties}>
      <div className={cn("absolute inset-0 z-50 transition-all duration-1000 ease-in-out pointer-events-none", isLoading ? "opacity-100 pointer-events-auto" : "opacity-0")}>
        <LoadingScreen message="Joining room..." className="w-full h-full" displayName={ui.displayName} />
      </div>

      <div className={cn("flex-1 flex flex-col w-full transition-all duration-700 ease-in-out", isLoading ? "opacity-0 scale-95 blur-sm" : "opacity-100 scale-100 blur-0")}>
        <PreJoinSettingsModal
          isOpen={ui.showSettings}
          onClose={() => ui.setShowSettings(false)}
          hasVideoDevices={hasVideoDevices}
          hasAudioInput={hasAudioInput}
          hasAudioOutput={hasAudioOutput}
          videoDevices={effectiveVideoDevices}
          audioInputDevices={effectiveAudioInputDevices}
          audioOutputDevices={audioOutputDevices}
          selectedVideoDevice={selectedVideoDevice}
          selectedAudioInput={selectedAudioInput}
          selectedAudioOutput={selectedAudioOutput}
          onVideoDeviceChange={onVideoDeviceChange}
          onAudioInputChange={onAudioInputChange}
          onAudioOutputChange={onAudioOutputChange}
          isAudioEnabled={ui.isAudioEnabled}
          audioLevel={activeAudioLevel}
          isLoading={isLoading}
        />

        <PreJoinHeader roomName={roomName} isDarkMode={isDarkMode} onToggleTheme={toggleTheme} />

        <div className="flex-1 w-full max-w-6xl mx-auto flex items-center px-6 pb-12">
          <div className="grid w-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-10 items-center">
            <PreJoinPreviewPane
              videoRef={videoRef}
              displayName={ui.displayName}
              isVideoEnabled={ui.isVideoEnabled}
              isAudioEnabled={ui.isAudioEnabled}
              audioLevel={activeAudioLevel}
              normalizedAudioLevel={normalizedAudioLevel}
              participantGradient={participantGradient}
              controls={
                <PreJoinFloatingControls
                  dropdownRef={dropdownRef}
                  openDropdown={ui.openDropdown}
                  setOpenDropdown={ui.setOpenDropdown}
                  isAudioEnabled={ui.isAudioEnabled}
                  isVideoEnabled={ui.isVideoEnabled}
                  hasAudioInput={hasAudioInput}
                  hasVideoDevices={hasVideoDevices}
                  effectiveAudioInputDevices={effectiveAudioInputDevices}
                  effectiveVideoDevices={effectiveVideoDevices}
                  selectedAudioInput={selectedAudioInput}
                  selectedVideoDevice={selectedVideoDevice}
                  onAudioInputChange={onAudioInputChange}
                  onVideoDeviceChange={onVideoDeviceChange}
                  onToggleAudio={ui.toggleAudio}
                  onToggleVideo={ui.toggleVideo}
                  onToggleSettings={ui.toggleSettings}
                  enablePictureInPicture={enablePictureInPicture}
                  isPictureInPictureSupported={pictureInPicture.isSupported}
                  isPictureInPictureActive={pictureInPicture.isActive}
                  onTogglePictureInPicture={pictureInPicture.toggle}
                />
              }
            />

            <PreJoinJoinPanel displayName={ui.displayName} isLoading={isLoading} canJoin={ui.canJoin} onDisplayNameChange={ui.setDisplayNameFromInput} onJoin={ui.handleJoin} participantGradient={participantGradient} />
          </div>
        </div>
      </div>
      {ui.localError && (
        <DiagnosticErrorSheet
          error={ui.localError}
          supportCode={supportCode}
          onRetry={() => {
            ui.setLocalError(undefined);
            ui.handleJoin();
          }}
          onBack={() => {
            ui.setLocalError(undefined);
            onCancel?.();
          }}
        />
      )}
    </div>
  );
}

export type { JoinSettings, PreJoinLobbyProps } from "./prejoin-lobby/types";

export const PreJoinLobby = memo(PreJoinLobbyBase);
PreJoinLobby.displayName = "PreJoinLobby";
