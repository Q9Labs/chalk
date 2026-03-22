import type React from "react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SettingsDialog } from "../composite/SettingsDialog";
import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { useDraggable } from "../../hooks/ui/useDraggable";
import { useHaptics } from "../../hooks/ui/useHaptics";
import { usePictureInPicture } from "../../hooks/ui/usePictureInPicture";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { buildMeetingPictureInPictureSource } from "./picture-in-picture";
import { useSharedPictureInPicture } from "./picture-in-picture/PictureInPictureContext";
import { MeetingRoomControls } from "./meeting-room/MeetingRoomControls";
import { MeetingRoomOverlays } from "./meeting-room/MeetingRoomOverlays";
import { MeetingRoomPanels } from "./meeting-room/MeetingRoomPanels";
import { MeetingRoomStage } from "./meeting-room/MeetingRoomStage";
import type { MeetingRoomProps } from "./meeting-room/types";
import { useMeetingRoomBackgroundEffects } from "./meeting-room/useMeetingRoomBackgroundEffects";
import { useMeetingRoomDerived } from "./meeting-room/useMeetingRoomDerived";
import { useMeetingRoomLifecycle } from "./meeting-room/useMeetingRoomLifecycle";
import { useMeetingRoomTheme } from "./meeting-room/useMeetingRoomTheme";
import { useMeetingRoomUiState } from "./meeting-room/useMeetingRoomUiState";

// Stable defaults prevent effect dependencies from changing when callers omit props.
const EMPTY_LIST = [] as never[];
const DEFAULT_BACKGROUND_EFFECT = { mode: "none" } as const;

function MeetingRoomBase({
  roomName,
  meetingLink,
  localParticipant,
  participants,
  canManageParticipants = false,
  onToggleParticipantMute,
  onRemoveParticipant,
  onUpdateDisplayName,
  activeReactions = EMPTY_LIST,
  isMuted = false,
  isVideoEnabled = false,
  isScreenSharing = false,
  isHandRaised = false,
  isWhiteboardOpen = false,
  isRecording = false,
  isTranscribing: _isTranscribing = false,
  recordingDuration: _recordingDuration = 0,
  meetingDuration = 0,
  canRecord = false,
  transcripts = EMPTY_LIST,
  chatMessages = EMPTY_LIST,
  unreadChatCount = 0,
  enablePictureInPicture = false,
  enableBackgroundEffects = true,
  isPictureInPictureActive,
  isPictureInPictureSupported,
  isBackgroundEffectsSupported = false,
  isApplyingBackgroundEffect = false,
  selectedBackgroundEffect = DEFAULT_BACKGROUND_EFFECT,
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
  onTogglePictureInPicture,
  onApplyBackgroundEffect,
  onClearBackgroundEffect,
  onLeave,
  onTourComplete,
  onAddPeople,
  onOpenDebug: _onOpenDebug,
  connectionState = "connected",
  onRetryConnection,
  connectionSupportCode,
  audioInputDevices = EMPTY_LIST,
  audioOutputDevices = EMPTY_LIST,
  videoInputDevices = EMPTY_LIST,
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
  const { trigger } = useHaptics();
  const containerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const didHydrateDevicePreferencesRef = useRef(false);
  const whiteboardApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const whiteboardSnapshotKeyRef = useRef<string | null>(null);
  const [whiteboardSnapshot, setWhiteboardSnapshot] = useState<null | {
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
    key: string;
  }>(null);
  const { dragHandlers: pillDragHandlers } = useDraggable(pillRef, {
    boundaryRef: containerRef,
    snapToCorners: true,
    cornerMargin: 24,
    bounce: 0.2,
    friction: 0.94,
  });

  const settingsDefaults = useMemo(
    () => ({
      appearance: {
        layout: defaultLayout,
        theme,
        showFilmstrip: true,
        reducedMotion: false,
        generatedAvatars: true,
      },
      experience: {
        showInviteToast: showInviteToastOnJoin,
        defaultOpenChat: defaultChatOpen,
        defaultOpenParticipants: defaultParticipantsOpen,
        defaultOpenTranscription: defaultTranscriptionOpen,
      },
    }),
    [defaultChatOpen, defaultLayout, defaultParticipantsOpen, defaultTranscriptionOpen, showInviteToastOnJoin, theme],
  );

  const { settings, updateAudioSettings, updateVideoSettings, updateAppearanceSettings, updateExperienceSettings } = useMeetingRoomSettings({
    defaults: settingsDefaults,
  });
  const backgroundEffects = useMeetingRoomBackgroundEffects({
    enabled: enableBackgroundEffects,
    settings,
    updateVideoSettings,
    currentEffect: selectedBackgroundEffect,
    isSupported: isBackgroundEffectsSupported,
    isApplying: isApplyingBackgroundEffect,
    applyBackgroundEffect: onApplyBackgroundEffect,
    clearBackgroundEffect: onClearBackgroundEffect,
  });

  const ui = useMeetingRoomUiState({
    defaultChatOpen: settings.experience.defaultOpenChat,
    defaultParticipantsOpen: settings.experience.defaultOpenParticipants,
    defaultTranscriptionOpen: settings.experience.defaultOpenTranscription,
    defaultLayout: settings.appearance.layout,
    defaultFilmstripOpen: settings.appearance.showFilmstrip,
    showInviteToastOnJoin: settings.experience.showInviteToast,
    onChatOpen,
  });

  const handleOpenSettings = useCallback(() => {
    void trigger("selection");
    ui.setIsSettingsOpen(true);
  }, [trigger, ui.setIsSettingsOpen]);

  const handleToggleMute = useCallback(() => {
    void trigger("selection");
    onToggleMute?.();
  }, [onToggleMute, trigger]);

  const handleToggleVideo = useCallback(() => {
    void trigger("selection");
    onToggleVideo?.();
  }, [onToggleVideo, trigger]);

  useHotkey("Mod+K", handleOpenSettings, {
    enabled: !ui.isExiting,
    ignoreInputs: true,
    preventDefault: true,
  });

  useHotkey("M", handleToggleMute, {
    enabled: !ui.isExiting,
    ignoreInputs: true,
  });

  useHotkey("V", handleToggleVideo, {
    enabled: !ui.isExiting,
    ignoreInputs: true,
  });

  const roomTheme = settings.appearance.theme;
  const reduceMotion = settings.appearance.reducedMotion;
  const { isDarkMode } = useMeetingRoomTheme({ theme: roomTheme });
  const { handleTourComplete, handleCopyLink } = useMeetingRoomLifecycle({
    meetingLink,
    enableTour,
    showTourOnFirstVisit,
    defaultChatOpen,
    onChatOpen,
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
  const localParticipantGradientPreference = settings.appearance.profileGradient;
  const hasExternalPictureInPicture = typeof onTogglePictureInPicture === "function";
  const sharedPictureInPicture = useSharedPictureInPicture();
  const registerSharedPictureInPicture = sharedPictureInPicture?.register;
  const pictureInPictureOwnerId = useId();

  useEffect(() => {
    if (typeof window === "undefined" || !enableWhiteboard || !isWhiteboardOpen) {
      return;
    }

    let outerFrameId = 0;
    let innerFrameId = 0;

    outerFrameId = window.requestAnimationFrame(() => {
      innerFrameId = window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    });

    return () => {
      window.cancelAnimationFrame(outerFrameId);
      window.cancelAnimationFrame(innerFrameId);
    };
  }, [enableWhiteboard, isWhiteboardOpen, isSplit, ui.activePanel, ui.isFilmstripOpen, ui.layout]);

  const captureWhiteboardSnapshot = useCallback(() => {
    const api = whiteboardApiRef.current;
    if (!api) {
      return;
    }

    const elements = api.getSceneElementsIncludingDeleted();
    const appState = api.getAppState() as Record<string, unknown>;
    const files = (api.getFiles() ?? {}) as Record<string, unknown>;
    const sceneVersion = elements.reduce((total, element) => total + (((element as { version?: number }).version ?? 0) as number), 0);
    const nextKey = [
      sceneVersion,
      appState.scrollX ?? 0,
      appState.scrollY ?? 0,
      (appState.zoom as { value?: number } | undefined)?.value ?? 1,
      Object.keys(files).length,
    ].join(":");

    if (whiteboardSnapshotKeyRef.current === nextKey) {
      return;
    }

    whiteboardSnapshotKeyRef.current = nextKey;
    setWhiteboardSnapshot({
      elements,
      appState,
      files,
      key: nextKey,
    });
  }, []);

  const handleWhiteboardExcalidrawApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      whiteboardApiRef.current = api;
      captureWhiteboardSnapshot();
      onWhiteboardExcalidrawApiReady?.(api);
    },
    [captureWhiteboardSnapshot, onWhiteboardExcalidrawApiReady],
  );

  useEffect(() => {
    if (!enablePictureInPicture || !enableWhiteboard || !isWhiteboardOpen) {
      whiteboardSnapshotKeyRef.current = null;
      setWhiteboardSnapshot(null);
      return;
    }

    captureWhiteboardSnapshot();
    const intervalId = window.setInterval(captureWhiteboardSnapshot, 500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [captureWhiteboardSnapshot, enablePictureInPicture, enableWhiteboard, isWhiteboardOpen]);

  const { source: pictureInPictureSource, previewSource, participantSources, meetingLayout } = useMemo(
    () =>
      buildMeetingPictureInPictureSource({
        participants: allParticipants,
        localParticipant,
        isWhiteboardOpen,
        whiteboardSnapshot,
      }),
    [allParticipants, isWhiteboardOpen, localParticipant, whiteboardSnapshot],
  );
  const pictureInPictureOptions = useMemo(
    () => ({
      autoOpen: settings.experience.autoOpenPictureInPicture,
      phase: "meeting" as const,
      roomName,
      displayName: localParticipant.displayName,
      source: pictureInPictureSource,
      previewSource,
      participantSources,
      meetingLayout,
      controls: {
        localParticipantGradientPreference,
        isMuted,
        isVideoEnabled,
        isScreenSharing,
        isHandRaised,
        isWhiteboardOpen,
        enableScreenShare,
        enableHandRaise,
        enableWhiteboard,
        enableReactions,
        audioInputDevices,
        audioOutputDevices,
        videoInputDevices,
        selectedAudioInput,
        selectedAudioOutput,
        selectedVideoInput,
        onAudioInputChange,
        onAudioOutputChange,
        onVideoInputChange,
        onToggleMute,
        onToggleVideo,
        onToggleScreenShare,
        onToggleRecording,
        onToggleHandRaise,
        onToggleWhiteboard,
        onOpenReactions: () => ui.setIsReactionPickerOpen(true),
        onSendReaction,
        onLeave,
      },
    }),
    [
      roomName,
      localParticipant.displayName,
      pictureInPictureSource,
      previewSource,
      participantSources,
      meetingLayout,
      isMuted,
      isVideoEnabled,
      isScreenSharing,
      isHandRaised,
      isWhiteboardOpen,
      enableScreenShare,
      enableHandRaise,
      enableWhiteboard,
      enableReactions,
      audioInputDevices,
      audioOutputDevices,
      videoInputDevices,
      selectedAudioInput,
      selectedAudioOutput,
      selectedVideoInput,
      onAudioInputChange,
      onAudioOutputChange,
      onVideoInputChange,
      onToggleMute,
      onToggleVideo,
      onToggleScreenShare,
      onToggleRecording,
      onToggleHandRaise,
      onToggleWhiteboard,
      ui.setIsReactionPickerOpen,
      onSendReaction,
      onLeave,
      localParticipantGradientPreference,
      settings.experience.autoOpenPictureInPicture,
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
    if (didHydrateDevicePreferencesRef.current) {
      return;
    }

    if (audioInputDevices.length === 0 && audioOutputDevices.length === 0 && videoInputDevices.length === 0 && !selectedAudioInput && !selectedAudioOutput && !selectedVideoInput) {
      return;
    }

    didHydrateDevicePreferencesRef.current = true;

    const audioUpdates: Partial<typeof settings.audio> = {};
    const videoUpdates: Partial<typeof settings.video> = {};

    if (settings.audio.selectedInput) {
      if (settings.audio.selectedInput !== selectedAudioInput && audioInputDevices.some((device) => device.deviceId === settings.audio.selectedInput)) {
        onAudioInputChange?.(settings.audio.selectedInput);
      }
    } else if (selectedAudioInput) {
      audioUpdates.selectedInput = selectedAudioInput;
    }

    if (settings.audio.selectedOutput) {
      if (settings.audio.selectedOutput !== selectedAudioOutput && audioOutputDevices.some((device) => device.deviceId === settings.audio.selectedOutput)) {
        onAudioOutputChange?.(settings.audio.selectedOutput);
      }
    } else if (selectedAudioOutput) {
      audioUpdates.selectedOutput = selectedAudioOutput;
    }

    if (settings.video.selectedInput) {
      if (settings.video.selectedInput !== selectedVideoInput && videoInputDevices.some((device) => device.deviceId === settings.video.selectedInput)) {
        onVideoInputChange?.(settings.video.selectedInput);
      }
    } else if (selectedVideoInput) {
      videoUpdates.selectedInput = selectedVideoInput;
    }

    if (Object.keys(audioUpdates).length > 0) {
      updateAudioSettings(audioUpdates);
    }

    if (Object.keys(videoUpdates).length > 0) {
      updateVideoSettings(videoUpdates);
    }
  }, [
    audioInputDevices,
    audioOutputDevices,
    onAudioInputChange,
    onAudioOutputChange,
    onVideoInputChange,
    selectedAudioInput,
    selectedAudioOutput,
    selectedVideoInput,
    settings.audio.selectedInput,
    settings.audio.selectedOutput,
    settings.video.selectedInput,
    updateAudioSettings,
    updateVideoSettings,
    videoInputDevices,
  ]);

  const handleAddPeople = useCallback(() => {
    ui.setShowInviteModal(true);
    onAddPeople?.();
  }, [onAddPeople, ui.setShowInviteModal]);


  const handleFilmstripToggle = useCallback(() => {
    const nextValue = !ui.isFilmstripOpen;
    ui.setIsFilmstripOpen(nextValue);
    updateAppearanceSettings({ showFilmstrip: nextValue });
  }, [ui.isFilmstripOpen, ui.setIsFilmstripOpen, updateAppearanceSettings]);


  const handleAudioInputPreference = useCallback(
    (deviceId: string) => {
      onAudioInputChange?.(deviceId);
    },
    [onAudioInputChange],
  );

  const handleAudioOutputPreference = useCallback(
    (deviceId: string) => {
      onAudioOutputChange?.(deviceId);
    },
    [onAudioOutputChange],
  );

  const handleVideoInputPreference = useCallback(
    (deviceId: string) => {
      onVideoInputChange?.(deviceId);
    },
    [onVideoInputChange],
  );

  const handleExperienceSettings = useCallback(
    (updates: Partial<typeof settings.experience>) => {
      if (updates.showInviteToast === false) {
        ui.setShowInviteToast(false);
      }
      updateExperienceSettings(updates);
    },
    [ui.setShowInviteToast, updateExperienceSettings],
  );

  const effectiveGetParticipantVolume = useCallback(
    (participantId: string) => {
      const baseVolume = getParticipantVolume?.(participantId) ?? 1;
      return Math.max(0, Math.min(1, baseVolume * (settings.audio.outputVolume / 100)));
    },
    [getParticipantVolume, settings.audio.outputVolume],
  );

  return (
    <div
      ref={containerRef}
      data-chalk
      className={cn("chalk-root chalk-theme-transition relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground", "p-0", className)}
      data-chalk-theme={roomTheme === "system" ? undefined : roomTheme}
      style={getParticipantThemeVariables(participantColorSeed, localParticipantGradientPreference) as React.CSSProperties}
    >      <div className={cn("absolute inset-0 pointer-events-none z-0 overflow-hidden", isDarkMode ? "bg-[#050505]" : "bg-background")}>
        {settings.appearance.ambientBackground && (
          <div className={cn("absolute inset-0 transition-opacity duration-1000", settings.appearance.gradient === "darker" ? "opacity-100" : "opacity-100")}>
            {settings.appearance.gradient === "darker" ? (
              /* High-end moody mesh gradient for 'darker' mode */
              <>
                <div
                  className="absolute -top-[20%] -left-[10%] w-[70%] h-[70%] rounded-full opacity-[0.15]"
                  style={{
                    background: "radial-gradient(circle, var(--primary) 0%, transparent 70%)",
                    filter: "blur(120px)",
                  }}
                />
                <div
                  className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] rounded-full opacity-[0.1]"
                  style={{
                    background: "radial-gradient(circle, var(--accent) 0%, transparent 70%)",
                    filter: "blur(140px)",
                  }}
                />
                <div
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80%] h-[80%] rounded-full opacity-[0.05]"
                  style={{
                    background: "radial-gradient(circle, var(--primary) 0%, transparent 60%)",
                    filter: "blur(160px)",
                  }}
                />
              </>
            ) : (
              /* Standard animated ambient background */
              <div className={isDarkMode ? "mix-blend-screen" : "mix-blend-multiply"}>
                <div
                  className={cn("absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] transition-opacity duration-500", isDarkMode ? "opacity-40 dark:opacity-20" : "opacity-40", !reduceMotion && "animate-[spin_15s_linear_infinite]")}
                  style={{
                    background: "radial-gradient(ellipse at 40% 40%, var(--primary) 0%, transparent 60%)",
                    filter: "blur(100px)",
                  }}
                />
                <div
                  className={cn("absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] transition-opacity duration-500", isDarkMode ? "opacity-30 dark:opacity-10" : "opacity-30", !reduceMotion && "animate-[spin_20s_linear_infinite_reverse]")}
                  style={{
                    background: "radial-gradient(ellipse at 60% 60%, var(--accent) 0%, transparent 60%)",
                    filter: "blur(120px)",
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {!isMobile && (
        <div ref={pillRef} {...pillDragHandlers} className="absolute top-4 left-6 z-30">
          <div className="px-3 py-1 rounded-full bg-muted/80 border border-border select-none shadow-sm">
            <span className="text-xs font-medium text-foreground tracking-tight">{roomName}</span>
          </div>
        </div>
      )}

      <div className={cn("relative z-0 flex min-h-0 flex-1 flex-row overflow-hidden", !reduceMotion && "animate-in fade-in duration-1000 ease-out fill-mode-both", isMobile ? "gap-2 px-2 pt-2 pb-0" : "gap-4 px-4 pt-4 pb-4", ui.isExiting && "pointer-events-none")}>
        <MeetingRoomStage
          isMobile={isMobile}
          layout={ui.layout}
          isStageMode={isStageMode}
          isSplit={isSplit}
          screenSharer={screenSharer}
          allParticipants={allParticipants}
          isFilmstripOpen={ui.isFilmstripOpen}
          onToggleFilmstrip={handleFilmstripToggle}
          enableWhiteboard={enableWhiteboard}
          isWhiteboardOpen={isWhiteboardOpen}
          theme={roomTheme}
          onWhiteboardExcalidrawApiReady={handleWhiteboardExcalidrawApiReady}
          activeReactions={activeReactions}
          isExiting={ui.isExiting}
          localParticipantColorSeed={participantColorSeed}
          localParticipantGradientPreference={localParticipantGradientPreference}
        />

        <MeetingRoomPanels
          isMobile={isMobile}
          activePanel={ui.activePanel}
          onClosePanel={() => ui.setActivePanel(null)}
          allParticipants={allParticipants}
          canManageParticipants={canManageParticipants}
          onToggleParticipantMute={onToggleParticipantMute}
          onRemoveParticipant={onRemoveParticipant}
          onUpdateDisplayName={onUpdateDisplayName}
          onAddPeople={handleAddPeople}
          chatMessages={chatMessages}
          onSendMessage={onSendMessage}
          onSendMessageWithAttachments={onSendMessageWithAttachments}
          onResolveChatAttachmentUrl={onResolveChatAttachmentUrl}
          transcripts={transcripts}
          participantVolumes={participantVolumes}
          onParticipantVolumeChange={onParticipantVolumeChange}
          localParticipantColorSeed={participantColorSeed}
          localParticipantGradientPreference={localParticipantGradientPreference}
        />
      </div>

      <div className={cn("relative z-10 w-full", !reduceMotion && "animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out fill-mode-both delay-300")}>
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
          enablePictureInPicture={enablePictureInPicture}
          enableTranscription={enableTranscription}
          enableChat={enableChat}
          isPictureInPictureSupported={pictureInPicture.isSupported}
          isPictureInPictureActive={pictureInPicture.isActive}
          audioInputDevices={audioInputDevices}
          audioOutputDevices={audioOutputDevices}
          videoInputDevices={videoInputDevices}
          selectedAudioInput={selectedAudioInput ?? settings.audio.selectedInput}
          selectedAudioOutput={selectedAudioOutput ?? settings.audio.selectedOutput}
          selectedVideoInput={selectedVideoInput ?? settings.video.selectedInput}
          onToggleMute={onToggleMute}
          onToggleVideo={onToggleVideo}
          onAudioInputChange={handleAudioInputPreference}
          onAudioOutputChange={handleAudioOutputPreference}
          onVideoInputChange={handleVideoInputPreference}
          onToggleScreenShare={onToggleScreenShare}
          onToggleRecording={onToggleRecording}
          onToggleHandRaise={onToggleHandRaise}
          onToggleWhiteboard={onToggleWhiteboard}
          onToggleTranscription={onToggleTranscription}
          onTogglePictureInPicture={pictureInPicture.toggle}
          onSendReaction={onSendReaction}
          onLeave={onLeave}
          onOpenSettings={handleOpenSettings}
          isExiting={ui.isExiting}
          localParticipantColorSeed={participantColorSeed}
          localParticipantGradientPreference={localParticipantGradientPreference}
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
        meetingLink={meetingLink}
        onCopyLink={handleCopyLink}
        allParticipants={allParticipants}
        getParticipantVolume={effectiveGetParticipantVolume}
        selectedAudioOutput={selectedAudioOutput ?? settings.audio.selectedOutput}
      />

      <SettingsDialog
        isOpen={ui.isSettingsOpen}
        onClose={() => ui.setIsSettingsOpen(false)}
        settings={settings}
        enablePictureInPicture={enablePictureInPicture}
        isPictureInPictureSupported={pictureInPicture.isSupported}
        isPictureInPictureActive={pictureInPicture.isActive}
        onOpenPictureInPicture={pictureInPicture.isSupported && !pictureInPicture.isActive ? pictureInPicture.toggle : undefined}
        enableBackgroundEffects={enableBackgroundEffects}
        isBackgroundEffectsSupported={backgroundEffects.isSupported}
        isApplyingBackgroundEffect={backgroundEffects.isApplying}
        backgroundEffects={backgroundEffects.effects}
        selectedBackgroundEffectId={backgroundEffects.selectedEffectId}
        onSelectBackgroundEffect={backgroundEffects.handleSelect}
        onUploadBackgroundEffect={backgroundEffects.handleCustomUpload}
        onUpdateAudio={(updates) => {
          updateAudioSettings(updates);
          if (updates.selectedInput) {
            handleAudioInputPreference(updates.selectedInput);
          }
          if (updates.selectedOutput) {
            handleAudioOutputPreference(updates.selectedOutput);
          }
        }}
        onUpdateVideo={(updates) => {
          updateVideoSettings(updates);
          if (updates.selectedInput) {
            handleVideoInputPreference(updates.selectedInput);
          }
        }}
        onUpdateAppearance={(updates) => {
          updateAppearanceSettings(updates);
          if (updates.layout) {
            ui.setLayout(updates.layout);
          }
          if (typeof updates.showFilmstrip === "boolean") {
            ui.setIsFilmstripOpen(updates.showFilmstrip);
          }
        }}
        onUpdateExperience={handleExperienceSettings}
        audioInputDevices={audioInputDevices}
        audioOutputDevices={audioOutputDevices}
        videoInputDevices={videoInputDevices}
        audioLevel={0}
        videoTrack={localParticipant.videoTrack}
        reducedMotion={reduceMotion}
        participantColorSeed={participantColorSeed}
        isDarkMode={isDarkMode}
      />
    </div>
  );
}

export type { ActiveReaction, ChatMessage, MeetingPanel, Participant, TranscriptEntry, MeetingRoomProps } from "./meeting-room/types";

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
