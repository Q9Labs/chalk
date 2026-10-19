"use client";
import { commandFailure } from "../control-bar/command-failure";
import type { ClientFailure, Reaction } from "@q9labsai/chalk-client";
import { DEFAULT_QUICK_REACTIONS } from "@q9labsai/chalk-ui/reactions";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCan, useConnection, useMedia, useParticipants, useRecording, useSelf, useSpaceClient } from "../../bindings/hooks";
import { callDiagnostics } from "../space-header/call-diagnostics";
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
  readonly shareUrl?: string;
  readonly callLinkOpen?: boolean;
  readonly onCallLinkToggle?: () => void;
  readonly onReportProblem?: import("../space-header/SpaceHeader").SpaceHeaderProps["onReportProblem"];
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

export function SpaceView({
  colorScheme = "dark",
  onColorSchemeChange,
  spaceName,
  shareUrl,
  callLinkOpen,
  onCallLinkToggle,
  onReportProblem,
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
  const [soundsEnabled] = useSoundsSetting();
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const media = useMedia();
  const connection = useConnection();
  const recording = useRecording();
  const canPublishScreen = useCan("publishScreen");
  const canSendChat = useCan("sendChat");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canManageAdmission = useCan("manageAdmission");
  const canManageRecording = useCan("manageRecording");
  const episodeDuration = useEpisodeDuration();
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus">(controlledLayout ?? "focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [commandError, setCommandError] = useState<ClientFailure | null>(null);
  const layout = onLayoutChange ? (controlledLayout ?? uncontrolledLayout) : uncontrolledLayout;
  const feature = (name: keyof SpaceViewFeatures) => features?.[name] !== false;
  const localId = self.participantId ?? "local";
  const tiles = useMemo(
    () =>
      toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local).map((tile) => ({
        ...tile,
        screenShareHasAudio: tile.isLocal ? media.screenShare.hasAudio : participantsSlice.roster.find((person) => person.participantId === tile.id)?.media.screenShareHasAudio,
      })),
    [localId, media.local, media.remote, media.screenShare.hasAudio, participantsSlice.roster, self.displayName],
  );
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
  useSoundCues(feature("sounds") && soundsEnabled);
  const prefersReducedMotion = usePrefersReducedMotion();
  const drawer = useDrawerPresence(activePanel, prefersReducedMotion ? 0 : DRAWER_EXIT_MS);
  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError(null);
    } catch (cause) {
      setCommandError(commandFailure(cause));
    }
  }, []);
  const leaveCall = onLeft ? () => void runCommand(async () => onLeft()) : undefined;
  const endCallForEveryone = onEndEpisode ? () => void runCommand(async () => onEndEpisode()) : undefined;
  const displayedCommandError = externalCommandError ?? commandError?.message;
  const commandToasts: Toast[] = displayedCommandError ? [{ id: "space-command-error", message: displayedCommandError, type: "error" }] : [];
  const dismissCommandError = () => {
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
          people: participantsSlice.roster,
          onTogglePeople: feature("participants") ? () => setActivePanel((current) => (current === "participants" ? null : "participants")) : undefined,
          knockCount: canManageAdmission ? participantsSlice.admissionQueue.length : 0,
          shareUrl,
          callLinkOpen,
          onCallLinkToggle,
          onReportProblem,
          diagnostics: callDiagnostics(connection, media),
          shortcuts: {
            isMuted: media.local.microphone.state !== "enabled",
            onToggleMute: () => void runCommand(() => client.media.setMicrophoneEnabled(media.local.microphone.state !== "enabled")),
            onToggleVideo: () => void runCommand(() => client.media.setCameraEnabled(media.local.camera.state !== "enabled")),
            onToggleHand: feature("handRaise") && canRaiseHand ? () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())) : undefined,
            onToggleChat: feature("chat") && canSendChat ? () => setActivePanel((current) => (current === "chat" ? null : "chat")) : undefined,
            onTogglePeople: feature("participants") ? () => setActivePanel((current) => (current === "participants" ? null : "participants")) : undefined,
            onToggleLayout: () => updateLayout(layout === "grid" ? "focus" : "grid"),
            onClosePanel: () => setActivePanel(null),
            onPushToTalk: (enabled) => void runCommand(() => client.media.setMicrophoneEnabled(enabled)),
          },
          duration: episodeDuration,
          isRecording: recording.current?.status === "recording",
          layout,
          onLayoutChange: updateLayout,
        }}
        stage={
          <SpaceStage
            tiles={tiles}
            layout={layout}
            onLayoutChange={updateLayout}
            generatedAvatars={generatedAvatars}
            whiteboard={whiteboard}
            onOverflowClick={feature("participants") ? () => setActivePanel("participants") : undefined}
            shareCapture={media.screenShare.capture}
            onStopSharing={() => client.media.setScreenShareEnabled(false)}
            onChangeShare={async (options) => {
              await client.media.setScreenShareEnabled(false);
              await client.media.setScreenShareEnabled(true, options);
            }}
            className="h-full"
          />
        }
        controls={
          <ControlBar
            density="comfortable"
            layout={layout}
            onLayoutChange={updateLayout}
            shareUrl={shareUrl}
            callLinkOpen={callLinkOpen}
            onCallLinkToggle={onCallLinkToggle}
            buttons={buttons}
            activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
            onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
            onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
            onToggleWhiteboard={onToggleWhiteboard}
            onOpenReactions={() => setReactionPickerOpen((current) => !current)}
            onCommandError={setCommandError}
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
                  isHandRaised={self.handRaised}
                  onToggleHandRaise={feature("handRaise") && canRaiseHand ? () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())) : undefined}
                  isOpen={isReactionPickerOpen}
                  onClose={() => setReactionPickerOpen(false)}
                  allowedReactions={[...DEFAULT_QUICK_REACTIONS]}
                  onSelect={(reaction) => void runCommand(() => client.reactions.send(reaction as Reaction)).finally(() => setReactionPickerOpen(false))}
                  size="compact"
                />
              </div>
            ) : null}
          </>
        }
        sidebar={
          <CallCard state={drawer.state} panel={drawer.panel} onPanelChange={setActivePanel} peopleCount={participantsSlice.roster.length} participantsEnabled={feature("participants")} chatEnabled={feature("chat") && canSendChat} onClose={() => setActivePanel(null)}>
            {drawer.panel === "chat" && feature("chat") && canSendChat ? <ChatPanel variant="mobile" generatedAvatars={generatedAvatars} onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
            {drawer.panel === "participants" && feature("participants") ? <ParticipantsPanel variant="mobile" admissionEnabled={feature("admission")} generatedAvatars={generatedAvatars} onCommandError={(message) => setCommandError(message === null ? null : commandFailure(new Error(message)))} onClose={() => setActivePanel(null)} /> : null}
            {drawer.panel === "admission" && feature("admission") ? <AdmissionPanel className="h-full w-full rounded-none shadow-none" onClose={() => setActivePanel(null)} /> : null}
          </CallCard>
        }
        toasts={<ToastStack toasts={commandToasts} onDismiss={dismissCommandError} />}
        mediaOutput={<AudioOutput />}
        overlays={
          <>
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
