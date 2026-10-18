"use client";
import { SpaceClientError, type ClientFailure, type Reaction } from "@q9labsai/chalk-client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCan, useMedia, useParticipants, useRecording, useSelf, useSpaceClient } from "../../bindings/hooks";
import { useEpisodeDuration } from "../../internal/useEpisodeDuration";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { useSoundsSetting } from "../../internal/useSoundsSetting";
import { useSoundCues } from "../../internal/useSoundCues";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { AudioOutput } from "../audio-output/AudioOutput";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ChatPanel } from "../composite/ChatPanel";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { ControlBar, type ControlBarButtonName } from "../control-bar/ControlBar";
import { ParticipantsPanel } from "../participants-panel/ParticipantsPanel";
import { ParticipantVolumeProvider } from "../participants-panel/participant-volume-context";
import { OfflineActions } from "../offline-actions/OfflineActions";
import { ReconnectingOverlay } from "../reconnecting-overlay/ReconnectingOverlay";
import { useCallToasts } from "../toast-stack/useCallToasts";
import { CallReady } from "../call-limbo/CallReady";
import { useCallLink } from "../call-limbo/useCallLink";
import { mediaFailureToast } from "../toast-stack/call-events";
import { ToastStack, type Toast } from "../toast-stack/ToastStack";
import { CallCard } from "../call-card/CallCard";
import { SpacePresentation } from "./SpacePresentation";
import { SpaceStage } from "../stage/SpaceStage";
import { DRAWER_EXIT_MS, useDrawerPresence } from "./useDrawerPresence";
import type { ChatUploadFile } from "@q9labsai/chalk-client";
import { type ReconnectingOverlayProps } from "../reconnecting-overlay/ReconnectingOverlay";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";

export type SpacePanel = "chat" | "participants" | "admission";

export interface SpaceViewFeatures {
  readonly chat?: boolean;
  readonly participants?: boolean;
  readonly admission?: boolean;
  readonly screenShare?: boolean;
  readonly recording?: boolean;
  readonly whiteboard?: boolean;
  readonly reactions?: boolean;
  readonly handRaise?: boolean;
  /** Join / leave / message / hand-raise / reaction cues. */
  readonly sounds?: boolean;
}

export interface SpaceViewWhiteboard {
  readonly isOpen: boolean;
  readonly props: WhiteboardViewProps;
}

export interface SpaceViewProps {
  readonly colorScheme?: "light" | "dark";
  readonly onColorSchemeChange?: (colorScheme: "light" | "dark") => void;
  readonly spaceName: string;
  readonly inviteLink?: string;
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly stageBackground?: boolean;
  /** Initial layout without a handler; controlled layout when onLayoutChange is supplied. */
  readonly layout?: "grid" | "focus";
  readonly onLayoutChange?: (layout: "grid" | "focus") => void;
  readonly initialPanel?: SpacePanel | null;
  readonly features?: SpaceViewFeatures;
  readonly generatedAvatars?: boolean;
  readonly commandError?: string;
  readonly onDismissCommandError?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly reconnecting?: Omit<ReconnectingOverlayProps, "isVisible"> & {
    readonly isVisible: boolean;
  };
  readonly overlay?: React.ReactNode;
  readonly onLeft?: () => void | Promise<void>;
  readonly onEndEpisode?: () => void | Promise<void>;
  readonly className?: string;
}

const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

export function SpaceView({
  colorScheme = "dark",
  onColorSchemeChange,
  spaceName,
  inviteLink,
  pickChatFiles,
  stageBackground = true,
  layout: controlledLayout,
  onLayoutChange,
  initialPanel = null,
  features,
  generatedAvatars = true,
  commandError: externalCommandError,
  onDismissCommandError,
  onToggleWhiteboard,
  whiteboard,
  reconnecting,
  overlay,
  onLeft,
  onEndEpisode,
  className,
}: SpaceViewProps): React.JSX.Element {
  const callToasts = useCallToasts();
  const [soundsEnabled] = useSoundsSetting();
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const callLink = useCallLink(participantsSlice.roster.length <= 1);
  const media = useMedia();
  const recording = useRecording();
  const canPublishScreen = useCan("publishScreen");
  const canSendChat = useCan("sendChat");
  const canSendReaction = useCan("sendReaction");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canManageAdmission = useCan("manageAdmission");
  const canManageRecording = useCan("manageRecording");
  const episodeDuration = useEpisodeDuration();
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus">(controlledLayout ?? "focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | ClientFailure | null>(null);
  const [commandSource, setCommandSource] = useState<"microphone" | "camera" | "screen">();
  const onCommandError = (failure: ClientFailure | string | null, source?: "microphone" | "camera" | "screen") => {
    if (!failure && commandError && typeof commandError === "object") callToasts.dismissFailure(commandError.code);
    setCommandError(failure);
    setCommandSource(source);
    if (failure && typeof failure !== "string") playSound("error", failure);
  };
  const layout = onLayoutChange ? (controlledLayout ?? uncontrolledLayout) : uncontrolledLayout;
  const feature = (name: keyof SpaceViewFeatures) => features?.[name] !== false;
  const localId = self.participantId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantsSlice.roster, self.displayName]);
  useEffect(() => setActivePanel(initialPanel), [initialPanel]);
  useEffect(() => {
    if (feature("admission") && feature("participants") && canManageAdmission && participantsSlice.admissionQueue.length > 0) setActivePanel("participants");
  }, [canManageAdmission, participantsSlice.admissionQueue.length, features?.admission, features?.participants]);
  const buttons: ControlBarButtonName[] = [
    "mic",
    "video",
    ...(feature("screenShare") && canPublishScreen ? ["screenshare" as const] : []),
    ...(feature("recording") && canManageRecording ? ["record" as const] : []),
    ...(feature("participants") ? ["participants" as const] : []),
    ...(feature("chat") && canSendChat ? ["chat" as const] : []),
    ...(feature("handRaise") ? ["handraise" as const] : []),
    ...(feature("reactions") && canSendReaction ? ["reactions" as const] : []),
    ...(feature("whiteboard") && canDrawWhiteboard ? ["whiteboard" as const] : []),
    "leave",
  ];
  const updateLayout = (nextLayout: "grid" | "focus") => {
    setUncontrolledLayout(nextLayout);
    onLayoutChange?.(nextLayout);
  };
  const playSound = useSoundCues(feature("sounds") && soundsEnabled);
  const prefersReducedMotion = usePrefersReducedMotion();
  const drawer = useDrawerPresence(activePanel, prefersReducedMotion ? 0 : DRAWER_EXIT_MS);
  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError(null);
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "This command could not be completed.");
    }
  }, []);
  const leaveCall = onLeft ? () => void runCommand(async () => onLeft()) : undefined;
  const endCallForEveryone = onEndEpisode ? () => void runCommand(async () => onEndEpisode()) : undefined;
  const displayedCommandError = externalCommandError ?? commandError;
  const mappedFailure = mediaFailureToast(typeof displayedCommandError === "object" ? displayedCommandError : null, commandSource);
  const retryMedia = async () => {
    try {
      if (commandSource === "screen") await client.media.setScreenShareEnabled(true);
      else if (commandSource === "camera") await client.media.setCameraEnabled(true);
      else if (commandSource === "microphone") await client.media.setMicrophoneEnabled(true);
      onCommandError(null);
    } catch (cause) {
      onCommandError(cause instanceof SpaceClientError ? cause : { code: "client.internal_error", recoverable: true, message: "Your device couldn’t start. Try again." }, commandSource);
    }
  };
  const retryableMedia = commandSource && typeof displayedCommandError === "object" && displayedCommandError?.recoverable && (commandSource === "screen" || displayedCommandError.code === "media.device_busy");
  const commandToasts: Toast[] = mappedFailure
    ? [{ id: "space-command-error", ...mappedFailure, action: retryableMedia ? { label: "Try again", onClick: () => void retryMedia() } : undefined }]
    : typeof displayedCommandError === "string"
      ? [{ id: "space-command-error", message: displayedCommandError, type: "error" }]
      : [];
  const dismissCommandError = () => {
    if (commandError && typeof commandError === "object") callToasts.dismissFailure(commandError.code);
    setCommandError(null);
    onDismissCommandError?.();
  };
  return (
    <ParticipantVolumeProvider>
      <SpacePresentation
        colorScheme={colorScheme}
        stageBackground={stageBackground}
        header={{
          colorScheme,
          onColorSchemeChange,
          spaceName,
          duration: episodeDuration,
          isRecording: recording.current?.status === "recording",
          layout,
          onLayoutChange: updateLayout,
        }}
        stage={<SpaceStage tiles={tiles} layout={layout} onLayoutChange={updateLayout} generatedAvatars={generatedAvatars} whiteboard={whiteboard} className="h-full" />}
        controls={
          <ControlBar
            density="comfortable"
            buttons={buttons}
            activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
            onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
            onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
            onToggleWhiteboard={onToggleWhiteboard}
            onOpenReactions={() => setReactionPickerOpen((current) => !current)}
            onCommandError={onCommandError}
            onLeaveRequest={leaveCall}
            onEndForEveryone={endCallForEveryone}
          />
        }
        compactControls={
          <ControlBar
            density="compact"
            layout={layout}
            onLayoutChange={updateLayout}
            buttons={buttons}
            activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
            onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
            onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
            onToggleWhiteboard={onToggleWhiteboard}
            onOpenReactions={() => setReactionPickerOpen((current) => !current)}
            onCommandError={onCommandError}
            onLeaveRequest={leaveCall}
            onEndForEveryone={endCallForEveryone}
          />
        }
        stageOverlay={
          <>
            {feature("reactions") ? <ReactionsOverlay /> : null}
            {feature("reactions") && canSendReaction ? (
              <div className="absolute bottom-24 left-1/2 z-50 -translate-x-1/2">
                <ReactionPicker
                  isOpen={isReactionPickerOpen}
                  onClose={() => setReactionPickerOpen(false)}
                  allowedReactions={[...DEFAULT_REACTIONS]}
                  onSelect={(reaction) => void runCommand(() => client.reactions.send(reaction as Reaction)).finally(() => setReactionPickerOpen(false))}
                  size="compact"
                />
              </div>
            ) : null}
          </>
        }
        sidebar={
          <CallCard state={drawer.state} onClose={() => setActivePanel(null)}>
            {drawer.panel === "chat" && feature("chat") && canSendChat ? <ChatPanel variant="sidebar" generatedAvatars={generatedAvatars} onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
            {drawer.panel === "participants" && feature("participants") ? <ParticipantsPanel variant="sidebar" admissionEnabled={feature("admission")} generatedAvatars={generatedAvatars} onCommandError={onCommandError} onClose={() => setActivePanel(null)} /> : null}
            {drawer.panel === "admission" && feature("admission") ? <AdmissionPanel className="h-full w-full rounded-none shadow-none" onClose={() => setActivePanel(null)} /> : null}
          </CallCard>
        }
        toasts={
          <ToastStack
            toasts={[...callToasts.toasts.filter((toast) => !(typeof displayedCommandError === "object" && displayedCommandError && toast.failureCode === displayedCommandError.code)), ...commandToasts]}
            onDismiss={(id) => (id === "space-command-error" ? dismissCommandError() : callToasts.dismiss(id))}
          />
        }
        mediaOutput={
          <div className="[&>div]:top-[68px] [&>div>button]:h-11 [&>div>button]:shadow-[0_8px_24px_rgba(0,0,0,.4)]">
            <AudioOutput resumeAudioLabel="Your browser paused the sound. Click to hear the call" />
          </div>
        }
        overlays={
          <>
            <CallReady open={callLink.open} onClose={callLink.close} link={inviteLink} />
            {overlay}
            {reconnecting && reconnecting.status !== "reconnecting" ? <ReconnectingOverlay {...reconnecting} /> : null}
            <OfflineActions reconnecting={reconnecting?.status === "reconnecting" && reconnecting.isVisible} />
          </>
        }
        className={className}
      />
    </ParticipantVolumeProvider>
  );
}
