"use client";
import { commandFailure, type MediaCommandSource, type MediaCommandAction } from "../control-bar/command-failure";
import { type ChalkWhiteboardView, type ClientFailure, type Reaction } from "@q9labsai/chalk-client";
import { DEFAULT_QUICK_REACTIONS } from "@q9labsai/chalk-ui/reactions";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCan, useCanDrawWhiteboard, useConnection, useMedia, useOffline, useParticipants, useRecording, useSelf, useSpaceClient } from "../../bindings/hooks";
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
import { useCallToasts } from "../toast-stack/useCallToasts";
import { CallReady } from "../call-limbo/CallReady";
import { useCallLink } from "../call-limbo/useCallLink";
import { mediaFailureToast } from "../toast-stack/call-events";
import { ToastStack, type Toast } from "../toast-stack/ToastStack";
import { NoticeButton } from "../toast-stack/NoticeButton";
import { BoardToastContext, type BoardToast } from "../board/board-toasts";
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
  /** Shares this person's board view so others can follow it; answers false when the board service can't. */
  readonly sendView?: (view: ChalkWhiteboardView) => boolean;
}

export interface SpaceViewProps {
  readonly colorScheme?: "light" | "dark";
  readonly onColorSchemeChange?: (colorScheme: "light" | "dark") => void;
  readonly spaceName: string;
  readonly shareUrl?: string;
  readonly callLinkOpen?: boolean;
  readonly onCallLinkToggle?: () => void;
  readonly onReportProblem?: import("../space-header/SpaceHeader").SpaceHeaderProps["onReportProblem"];
  readonly inviteLink?: string;
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly stageBackground?: boolean;
  /** Initial layout without a handler; controlled layout when onLayoutChange is supplied. */
  readonly layout?: "grid" | "focus";
  readonly onLayoutChange?: (layout: "grid" | "focus") => void;
  readonly initialPanel?: SpacePanel | null;
  readonly features?: SpaceViewFeatures;
  readonly generatedAvatars?: boolean;
  readonly commandError?: string | ClientFailure;
  readonly commandSource?: MediaCommandSource;
  readonly commandAction?: MediaCommandAction;
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
  inviteLink,
  pickChatFiles,
  stageBackground = true,
  layout: controlledLayout,
  onLayoutChange,
  initialPanel = null,
  features,
  generatedAvatars = true,
  commandError: externalCommandError,
  commandSource: externalCommandSource,
  commandAction: externalCommandAction,
  onDismissCommandError,
  onToggleWhiteboard,
  whiteboard,
  reconnecting,
  overlay,
  onLeft,
  onEndEpisode,
  className,
}: SpaceViewProps): React.JSX.Element {
  const effectiveShareUrl = inviteLink ?? shareUrl;
  const callToasts = useCallToasts();
  const [soundsEnabled] = useSoundsSetting();
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const callLink = useCallLink(participantsSlice.roster.length <= 1);
  const media = useMedia();
  const connection = useConnection();
  const offline = useOffline();
  const [dismissedOfflineNotice, setDismissedOfflineNotice] = useState<string | null>(null);
  const offlineNotice = offline.notice && offline.notice !== dismissedOfflineNotice ? offline.notice : null;
  const recording = useRecording();
  const canPublishScreen = useCan("publishScreen");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canDrawWhiteboard = useCanDrawWhiteboard();
  const canManageAdmission = useCan("manageAdmission");
  const canManageRecording = useCan("manageRecording");
  const episodeDuration = useEpisodeDuration();
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus">(controlledLayout ?? "focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | ClientFailure | null>(null);
  const [commandSource, setCommandSource] = useState<MediaCommandSource>();
  const [commandAction, setCommandAction] = useState<MediaCommandAction>();
  const [retryCommand, setRetryCommand] = useState<() => Promise<unknown>>();
  const onCommandError = (failure: ClientFailure | string | null, source?: MediaCommandSource, mediaSource?: MediaCommandSource, action?: MediaCommandAction, command?: () => Promise<unknown>) => {
    if (!failure && commandError && typeof commandError === "object") callToasts.dismissFailure(commandError.code);
    setCommandError(failure);
    setCommandSource(mediaSource ?? source);
    setCommandAction(action);
    setRetryCommand(() => command);
    if (failure && typeof failure !== "string") playSound("error", failure);
  };
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
    ...(feature("chat") ? ["chat" as const] : []),
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
  const runCommand = useCallback(async (command: () => Promise<unknown>, source?: MediaCommandSource, action?: MediaCommandAction) => {
    try {
      await command();
      setCommandError(null);
      setCommandSource(undefined);
      setCommandAction(undefined);
      setRetryCommand(undefined);
    } catch (cause) {
      setCommandError(commandFailure(cause));
      setCommandSource(source);
      setCommandAction(action);
      setRetryCommand(() => command);
    }
  }, []);
  const leaveCall = onLeft ? () => void runCommand(async () => onLeft()) : undefined;
  const endCallForEveryone = onEndEpisode ? () => void runCommand(async () => onEndEpisode()) : undefined;
  const displayedCommandError = externalCommandError ?? commandError;
  const displayedCommandSource = externalCommandError != null ? externalCommandSource : commandSource;
  const retryMedia = async () => {
    if (!retryCommand) return;
    try {
      await retryCommand();
      onCommandError(null);
    } catch (cause) {
      onCommandError(commandFailure(cause), commandSource, commandSource, commandAction, retryCommand);
    }
  };
  const mappedFailure = mediaFailureToast(typeof displayedCommandError === "object" ? displayedCommandError : null, displayedCommandSource, externalCommandError != null ? externalCommandAction : commandAction, externalCommandError == null && retryCommand ? () => void retryMedia() : undefined);
  const commandToasts: Toast[] = mappedFailure ? [{ id: "space-command-error", ...mappedFailure }] : typeof displayedCommandError === "string" ? [{ id: "space-command-error", message: displayedCommandError, type: "error" }] : [];
  const [boardToasts, setBoardToasts] = useState<readonly Toast[]>([]);
  const boardToastCount = useRef(0);
  useEffect(() => {
    if (!whiteboard?.isOpen) setBoardToasts([]);
  }, [whiteboard?.isOpen]);
  const showBoardToast = useCallback((toast: BoardToast | null) => {
    if (!toast) {
      setBoardToasts([]);
      return;
    }
    boardToastCount.current += 1;
    const id = `board-${boardToastCount.current}`;
    setBoardToasts((current) => [...current.slice(-2), { ...toast, id }]);
  }, []);
  const dismissCommandError = () => {
    if (commandError && typeof commandError === "object") callToasts.dismissFailure(commandError.code);
    setCommandError(null);
    onDismissCommandError?.();
  };
  const toasts = [
    ...callToasts.toasts.filter((toast) => !(typeof displayedCommandError === "object" && displayedCommandError && toast.failureCode === displayedCommandError.code)),
    ...(whiteboard?.isOpen ? boardToasts : []),
    ...commandToasts,
    ...(offlineNotice ? [{ id: "offline-notice", message: offlineNotice }] : []),
  ];
  const dismissToast = (id: string) => {
    if (id === "space-command-error") dismissCommandError();
    else if (id === "offline-notice") setDismissedOfflineNotice(offline.notice ?? null);
    else if (id.startsWith("board-")) setBoardToasts((current) => current.filter((toast) => toast.id !== id));
    else callToasts.dismiss(id);
  };
  const [foldedNotices, setFoldedNotices] = useState<readonly string[]>([]);
  const folded = toasts.filter((toast) => foldedNotices.includes(toast.id));
  return (
    <ParticipantVolumeProvider>
      <BoardToastContext.Provider value={showBoardToast}>
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
            shareUrl: effectiveShareUrl,
            callLinkOpen: callLinkOpen ?? callLink.open,
            onCallLinkToggle: onCallLinkToggle ?? callLink.toggle,
            onReportProblem,
            diagnostics: callDiagnostics(connection, media),
            shortcuts: {
              isMuted: media.local.microphone.state !== "enabled",
              onToggleMute:
                connection.status === "live" || media.local.microphone.state === "enabled" ? () => void runCommand(() => client.media.setMicrophoneEnabled(media.local.microphone.state !== "enabled"), "microphone", media.local.microphone.state === "enabled" ? "stop" : "start") : undefined,
              onToggleVideo: connection.status === "live" || media.local.camera.state === "enabled" ? () => void runCommand(() => client.media.setCameraEnabled(media.local.camera.state !== "enabled"), "camera", media.local.camera.state === "enabled" ? "stop" : "start") : undefined,
              onToggleHand: feature("handRaise") && canRaiseHand ? () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())) : undefined,
              onToggleChat: feature("chat") ? () => setActivePanel((current) => (current === "chat" ? null : "chat")) : undefined,
              onTogglePeople: feature("participants") ? () => setActivePanel((current) => (current === "participants" ? null : "participants")) : undefined,
              onToggleLayout: () => updateLayout(layout === "grid" ? "focus" : "grid"),
              onClosePanel: () => setActivePanel(null),
              onPushToTalk: (enabled) => {
                if (enabled && connection.status !== "live") return;
                void runCommand(() => client.media.setMicrophoneEnabled(enabled), "microphone", enabled ? "start" : "stop");
              },
            },
            duration: episodeDuration,
            isRecording: recording.current?.status === "recording",
            layout,
            onLayoutChange: updateLayout,
            notices: folded.length ? <NoticeButton toasts={folded} onDismiss={dismissToast} /> : undefined,
          }}
          stage={
            <SpaceStage
              tiles={tiles}
              layout={layout}
              onLayoutChange={updateLayout}
              generatedAvatars={generatedAvatars}
              whiteboard={whiteboard}
              onCloseBoard={whiteboard?.isOpen ? onToggleWhiteboard : undefined}
              colorScheme={colorScheme}
              onOverflowClick={feature("participants") ? () => setActivePanel("participants") : undefined}
              shareCapture={media.screenShare.capture}
              onStopSharing={async () => {
                await client.media.setScreenShareEnabled(false);
              }}
              onChangeShare={
                connection.status === "live"
                  ? async (options) => {
                      await client.media.setScreenShareEnabled(true, options);
                    }
                  : undefined
              }
              className="h-full"
            />
          }
          controls={
            <ControlBar
              density="comfortable"
              layout={layout}
              onLayoutChange={updateLayout}
              shareUrl={effectiveShareUrl}
              callLinkOpen={callLinkOpen ?? callLink.open}
              onCallLinkToggle={onCallLinkToggle ?? callLink.toggle}
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
              {feature("reactions") && canSendReaction && connection.status === "live" ? (
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
            <CallCard state={drawer.state} panel={drawer.panel} onPanelChange={setActivePanel} peopleCount={participantsSlice.roster.length} participantsEnabled={feature("participants")} chatEnabled={feature("chat")} onClose={() => setActivePanel(null)}>
              {drawer.panel === "chat" && feature("chat") ? <ChatPanel variant="mobile" generatedAvatars={generatedAvatars} onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
              {drawer.panel === "participants" && feature("participants") ? <ParticipantsPanel variant="mobile" admissionEnabled={feature("admission")} generatedAvatars={generatedAvatars} onCommandError={onCommandError} onClose={() => setActivePanel(null)} /> : null}
              {drawer.panel === "admission" && feature("admission") ? <AdmissionPanel className="h-full w-full rounded-none shadow-none" onClose={() => setActivePanel(null)} /> : null}
            </CallCard>
          }
          toasts={<ToastStack toasts={toasts} onDismiss={dismissToast} onFold={setFoldedNotices} />}
          mediaOutput={
            <div className="[&>div]:top-[68px] [&>div>button]:h-11 [&>div>button]:shadow-[0_8px_24px_rgba(0,0,0,.4)]">
              <AudioOutput resumeAudioLabel="Your browser paused the sound. Click to hear the call" />
            </div>
          }
          overlays={
            <>
              <CallReady open={callLinkOpen ?? callLink.open} onClose={onCallLinkToggle ?? callLink.close} link={effectiveShareUrl} />
              {overlay}
              {reconnecting && reconnecting.status !== "reconnecting" ? <ReconnectingOverlay {...reconnecting} /> : null}
              <OfflineActions reconnecting={reconnecting?.status === "reconnecting" && reconnecting.isVisible} hasNotice={offlineNotice !== null} />
            </>
          }
          className={className}
        />
      </BoardToastContext.Provider>
    </ParticipantVolumeProvider>
  );
}
