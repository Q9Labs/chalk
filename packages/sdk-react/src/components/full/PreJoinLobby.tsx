import type React from "react";
import { memo, useCallback, useEffect, useId, useMemo, useRef } from "react";

import { cn } from "../../utils/cn";
import { getParticipantGradient, getParticipantColor } from "../../utils/colorGenerator";
import { applyThemeToDocument } from "../../utils/theme";
import { usePictureInPicture } from "../../hooks/ui/usePictureInPicture";
import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { SettingsDialog } from "../composite/SettingsDialog";
import { DiagnosticErrorSheet } from "../composite";
import { LoadingScreen } from "./LoadingScreen";
import { buildPreJoinPictureInPictureSource } from "./picture-in-picture";
import { useSharedPictureInPicture } from "./picture-in-picture/PictureInPictureContext";
import { PreJoinFloatingControls } from "./prejoin-lobby/PreJoinFloatingControls";
import { PreJoinHeader } from "./prejoin-lobby/PreJoinHeader";
import { PreJoinJoinPanel } from "./prejoin-lobby/PreJoinJoinPanel";
import { PreJoinLobbyMobile } from "./prejoin-lobby/PreJoinLobbyMobile";
import { PreJoinPreviewPane } from "./prejoin-lobby/PreJoinPreviewPane";
import type { PreJoinLobbyProps } from "./prejoin-lobby/types";
import { usePreJoinAudioMeter } from "./prejoin-lobby/usePreJoinAudioMeter";
import { usePreJoinMedia } from "./prejoin-lobby/usePreJoinMedia";
import { usePreJoinTheme } from "./prejoin-lobby/usePreJoinTheme";
import { usePreJoinUiState } from "./prejoin-lobby/usePreJoinUiState";

const JOINING_ROOM_MESSAGES = [
  "Checking your camera and mic...",
  "Syncing room settings...",
  "Testing your connection...",
  "Preparing your preview...",
  "Opening a low-latency route...",
  "Choosing the fastest route...",
  "Almost there...",
] as const;
const EMPTY_LIST = [] as never[];
const NOOP = () => {};

function resolvePreferredDeviceId(preferredDeviceId: string | undefined, devices: readonly MediaDeviceInfo[]): string | undefined {
  if (!preferredDeviceId) {
    return undefined;
  }

  if (devices.length === 0) {
    return preferredDeviceId;
  }

  return devices.some((device) => device.deviceId === preferredDeviceId) ? preferredDeviceId : undefined;
}

function PreJoinLobbyBase({
  roomName,
  userName = "Chalker",
  onJoin,
  onCancel,
  videoTrack,
  audioTrack,
  audioLevel,
  videoDevices = EMPTY_LIST,
  audioInputDevices = EMPTY_LIST,
  audioOutputDevices = EMPTY_LIST,
  selectedVideoDevice,
  selectedAudioInput,
  selectedAudioOutput,
  onVideoDeviceChange = NOOP,
  onAudioInputChange = NOOP,
  onAudioOutputChange = NOOP,
  initialVideoEnabled = false,
  initialAudioEnabled = false,
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
  const { settings, updateAudioSettings, updateVideoSettings, updateAppearanceSettings, updateExperienceSettings } = useMeetingRoomSettings({
    defaults: {
      appearance: {
        theme: initialTheme,
      },
    },
  });
  const { isDarkMode, toggleTheme } = usePreJoinTheme({ initialTheme });
  const handleToggleTheme = useCallback(() => {
    const nextTheme = isDarkMode ? "light" : "dark";
    toggleTheme();
    updateAppearanceSettings({
      theme: nextTheme,
    });
  }, [isDarkMode, toggleTheme, updateAppearanceSettings]);
  const resolvedSelectedVideoDevice = useMemo(() => resolvePreferredDeviceId(selectedVideoDevice ?? settings.video.selectedInput, videoDevices), [selectedVideoDevice, settings.video.selectedInput, videoDevices]);
  const resolvedSelectedAudioInput = useMemo(() => resolvePreferredDeviceId(selectedAudioInput ?? settings.audio.selectedInput, audioInputDevices), [selectedAudioInput, settings.audio.selectedInput, audioInputDevices]);
  const resolvedSelectedAudioOutput = useMemo(() => resolvePreferredDeviceId(selectedAudioOutput ?? settings.audio.selectedOutput, audioOutputDevices), [selectedAudioOutput, settings.audio.selectedOutput, audioOutputDevices]);
  const handleVideoInputPreference = useCallback(
    (deviceId: string) => {
      updateVideoSettings({ selectedInput: deviceId });
      onVideoDeviceChange(deviceId);
    },
    [onVideoDeviceChange, updateVideoSettings],
  );
  const handleAudioInputPreference = useCallback(
    (deviceId: string) => {
      updateAudioSettings({ selectedInput: deviceId });
      onAudioInputChange(deviceId);
    },
    [onAudioInputChange, updateAudioSettings],
  );
  const handleAudioOutputPreference = useCallback(
    (deviceId: string) => {
      updateAudioSettings({ selectedOutput: deviceId });
      onAudioOutputChange(deviceId);
    },
    [onAudioOutputChange, updateAudioSettings],
  );

  const ui = usePreJoinUiState({
    userName,
    error,
    initialVideoEnabled,
    initialAudioEnabled,
    initialShowSettings,
    selectedVideoDevice: resolvedSelectedVideoDevice,
    selectedAudioInput: resolvedSelectedAudioInput,
    selectedAudioOutput: resolvedSelectedAudioOutput,
    onJoin,
  });

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
    selectedVideoDevice: resolvedSelectedVideoDevice,
    selectedAudioInput: resolvedSelectedAudioInput,
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
  const pictureInPictureRef = useRef<any>(null);

  const handleJoin = useCallback(() => {
    const pip = pictureInPictureRef.current;
    if (enablePictureInPicture && settings.experience.autoOpenPictureInPicture && pip?.isSupported && !pip?.isActive) {
      void pip?.open();
    }
    ui.handleJoin();
  }, [enablePictureInPicture, settings.experience.autoOpenPictureInPicture, ui.handleJoin]);

  const participantGradient = useMemo(() => propParticipantGradient || getParticipantGradient(ui.displayName, settings.appearance.profileGradient), [propParticipantGradient, settings.appearance.profileGradient, ui.displayName]);
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
      autoOpen: settings.experience.autoOpenPictureInPicture,
      phase: isLoading ? ("joining" as const) : ("prejoin" as const),
      roomName,
      displayName: ui.displayName,
      source: pictureInPictureSource,
      controls: {
        localParticipantGradientPreference: settings.appearance.profileGradient,
        isMuted: !ui.isAudioEnabled,
        isVideoEnabled: ui.isVideoEnabled,
        audioInputDevices: effectiveAudioInputDevices,
        audioOutputDevices,
        videoInputDevices: effectiveVideoDevices,
        selectedAudioInput: resolvedSelectedAudioInput,
        selectedAudioOutput: resolvedSelectedAudioOutput,
        selectedVideoInput: resolvedSelectedVideoDevice,
        onAudioInputChange: handleAudioInputPreference,
        onAudioOutputChange: handleAudioOutputPreference,
        onVideoInputChange: handleVideoInputPreference,
        onToggleMute: ui.toggleAudio,
        onToggleVideo: ui.toggleVideo,
        onJoin: handleJoin,
        loadingMessages: JOINING_ROOM_MESSAGES,
        errorMessage: ui.localError,
        supportCode,
      },
    }),
    [
      settings.experience.autoOpenPictureInPicture,
      settings.appearance.profileGradient,
      roomName,
      ui.displayName,
      pictureInPictureSource,
      ui.isAudioEnabled,
      ui.isVideoEnabled,
      ui.toggleAudio,
      ui.toggleVideo,
      effectiveAudioInputDevices,
      audioOutputDevices,
      effectiveVideoDevices,
      resolvedSelectedAudioInput,
      resolvedSelectedAudioOutput,
      resolvedSelectedVideoDevice,
      handleAudioInputPreference,
      handleAudioOutputPreference,
      handleVideoInputPreference,
      handleJoin,
      isLoading,
      supportCode,
      ui.localError,
    ],
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
        open: async () => {
          if (!isPictureInPictureActive) {
            await onTogglePictureInPicture?.();
          }
        },
        close: async () => {
          if (isPictureInPictureActive) {
            await onTogglePictureInPicture?.();
          }
        },
        toggle: onTogglePictureInPicture,
      }
    : sharedPictureInPicture
      ? sharedPictureInPicture
      : internalPictureInPicture;

  useEffect(() => {
    pictureInPictureRef.current = pictureInPicture;
  }, [pictureInPicture]);

  const normalizedAudioLevel = Math.min(100, Math.max(0, activeAudioLevel * 100));
  const isMobile = useIsMobile();

  return (
    <div data-chalk data-chalk-theme={isDarkMode ? "dark" : "light"} className={cn("chalk-root min-h-screen flex flex-col overflow-hidden relative", isDarkMode && "dark", className)} style={{ "--primary": getParticipantColor(ui.displayName, settings.appearance.profileGradient).primary } as React.CSSProperties}>
      <div className={cn("absolute inset-0 z-50 transition-all duration-1000 ease-in-out pointer-events-none", isLoading ? "opacity-100 pointer-events-auto" : "opacity-0")}>
        <LoadingScreen message="Joining room..." className="w-full h-full" displayName={ui.displayName} supportingMessages={JOINING_ROOM_MESSAGES} gradientPreference={settings.appearance.profileGradient} />
      </div>

      <div className={cn("flex-1 flex flex-col w-full transition-all duration-700 ease-in-out", isLoading ? "opacity-0 scale-95 blur-sm" : "opacity-100 scale-100 blur-0")}>
        <SettingsDialog
          isOpen={ui.showSettings}
          onClose={() => ui.setShowSettings(false)}
          settings={settings}
          onUpdateAudio={(updates) => {
            const { selectedInput, selectedOutput, ...rest } = updates;
            if (Object.keys(rest).length > 0) {
              updateAudioSettings(rest);
            }
            if (selectedInput) {
              handleAudioInputPreference(selectedInput);
            }
            if (selectedOutput) {
              handleAudioOutputPreference(selectedOutput);
            }
          }}
          onUpdateVideo={(updates) => {
            const { selectedInput, ...rest } = updates;
            if (Object.keys(rest).length > 0) {
              updateVideoSettings(rest);
            }
            if (selectedInput) {
              handleVideoInputPreference(selectedInput);
            }
          }}
          onUpdateAppearance={(updates) => {
            updateAppearanceSettings(updates);
            if (updates.theme === "light" || updates.theme === "dark") {
              applyThemeToDocument(updates.theme);
            }
          }}
          onUpdateExperience={updateExperienceSettings}
          enablePictureInPicture={enablePictureInPicture}
          isPictureInPictureSupported={pictureInPicture.isSupported}
          isPictureInPictureActive={pictureInPicture.isActive}
          onOpenPictureInPicture={pictureInPicture.isSupported && !pictureInPicture.isActive ? pictureInPicture.toggle : undefined}
          audioInputDevices={effectiveAudioInputDevices}
          audioOutputDevices={audioOutputDevices}
          videoInputDevices={effectiveVideoDevices}
          audioLevel={activeAudioLevel}
          videoTrack={activeVideoTrack}
          reducedMotion={settings.appearance.reducedMotion}
          participantColorSeed={ui.displayName}
          isDarkMode={isDarkMode}
        />

        {isMobile ? (
          <PreJoinLobbyMobile
            roomName={roomName}
            displayName={ui.displayName}
            isDarkMode={isDarkMode}
            isLoading={isLoading}
            isVideoEnabled={ui.isVideoEnabled}
            isAudioEnabled={ui.isAudioEnabled}
            audioLevel={activeAudioLevel}
            normalizedAudioLevel={normalizedAudioLevel}
            participantGradient={participantGradient}
            participantGradientPreference={settings.appearance.profileGradient}
            videoRef={videoRef}
            effectiveVideoDevices={effectiveVideoDevices}
            effectiveAudioInputDevices={effectiveAudioInputDevices}
            selectedVideoDevice={resolvedSelectedVideoDevice}
            selectedAudioInput={resolvedSelectedAudioInput}
            onToggleTheme={handleToggleTheme}
            onToggleVideo={ui.toggleVideo}
            onToggleAudio={ui.toggleAudio}
            onVideoDeviceChange={handleVideoInputPreference}
            onAudioInputChange={handleAudioInputPreference}
            onToggleSettings={ui.toggleSettings}
            onDisplayNameChange={ui.setDisplayNameFromInput}
            onJoin={handleJoin}
            enablePictureInPicture={enablePictureInPicture}
            isPictureInPictureSupported={pictureInPicture.isSupported}
            isPictureInPictureActive={pictureInPicture.isActive}
            onTogglePictureInPicture={pictureInPicture.toggle}
          />
        ) : (
          <>
            <PreJoinHeader roomName={roomName} isDarkMode={isDarkMode} onToggleTheme={handleToggleTheme} />

            <div className="flex-1 w-full max-w-6xl mx-auto flex items-center px-6 lg:px-8 pb-16">
              <div className="grid w-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-12 lg:gap-16 items-center">
                <PreJoinPreviewPane
                  videoRef={videoRef}
                  displayName={ui.displayName}
                  isVideoEnabled={ui.isVideoEnabled}
                  isAudioEnabled={ui.isAudioEnabled}
                  audioLevel={activeAudioLevel}
                  normalizedAudioLevel={normalizedAudioLevel}
                  participantGradient={participantGradient}
                  participantGradientPreference={settings.appearance.profileGradient}
                  controls={
                    <PreJoinFloatingControls
                      isAudioEnabled={ui.isAudioEnabled}
                      isVideoEnabled={ui.isVideoEnabled}
                      effectiveAudioInputDevices={effectiveAudioInputDevices}
                      effectiveVideoDevices={effectiveVideoDevices}
                      selectedAudioInput={resolvedSelectedAudioInput}
                      selectedVideoDevice={resolvedSelectedVideoDevice}
                      onAudioInputChange={handleAudioInputPreference}
                      onVideoDeviceChange={handleVideoInputPreference}
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

                <PreJoinJoinPanel displayName={ui.displayName} isLoading={isLoading} canJoin={ui.canJoin} onDisplayNameChange={ui.setDisplayNameFromInput} onJoin={handleJoin} participantGradient={participantGradient} />
              </div>
            </div>
          </>
        )}
      </div>
      {ui.localError && (
        <DiagnosticErrorSheet
          error={ui.localError}
          supportCode={supportCode}
          onRetry={() => {
            ui.setLocalError(undefined);
            handleJoin();
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
