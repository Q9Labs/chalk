"use client";
import { commandFailure, recordingFailure, type MediaCommandSource, type MediaCommandAction } from "../control-bar/command-failure";
import { isDeviceAccessFailure } from "../device-access/model";
import { DeviceAccessProvider, useDeviceAccess } from "../device-access/useDeviceAccess";
import { mediaToggleTarget } from "../control-bar/media-toggle";
import { type ChalkWhiteboardView, type ClientFailure, type Reaction } from "@q9labsai/chalk-client";
import { DEFAULT_QUICK_REACTIONS } from "@q9labsai/chalk-ui/reactions";
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCan, useCanDrawWhiteboard, useConnection, useMedia, useOffline, useParticipants, useRecording, useSelf, useSpaceClient } from "../../bindings/hooks";
import { callDiagnostics } from "../space-header/call-diagnostics";
import { callCountdown } from "./countdown";
import { useEpisodeDuration } from "../../internal/useEpisodeDuration";
import { useRecordingSeconds } from "../../internal/useRecordingSeconds";
import { useIsMobile, usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { useSoundsSetting } from "../../internal/useSoundsSetting";
import { useSoundCues } from "../../internal/useSoundCues";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { AudioOutput } from "../audio-output/AudioOutput";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ParticipantsPanel } from "../participants-panel/ParticipantsPanel";
import { useHandOrder } from "../../internal/useHandOrder";
import { ChatPanel } from "../composite/ChatPanel";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { ControlBar, type ControlBarButtonName } from "../control-bar/ControlBar";
import { failedMediaNotice } from "../control-bar/control-bar-behavior";
import { ParticipantVolumeProvider } from "../participants-panel/participant-volume-context";
import { LiveConnectionStatus } from "../connection-status/LiveConnectionStatus";
import { useConnectionPhase } from "../connection-status/use-connection-phase";
import { FrozenFramesContext } from "../participant-tile/useFrozenFrame";
import { useHeldWhile } from "../../internal/useHeldWhile";
import { useSeenConnected } from "../../internal/useSeenConnected";
import { useCallToasts } from "../toast-stack/useCallToasts";
import { useCallLink } from "../call-limbo/useCallLink";
import { mediaFailureToast } from "../toast-stack/call-events";
import { ToastStack, type Toast } from "../toast-stack/ToastStack";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import { NoticeButton } from "../toast-stack/NoticeButton";
import { BoardToastContext, type BoardToast } from "@q9labsai/chalk-whiteboard/react";
import { CallCard } from "../call-card/CallCard";
import { SpacePresentation } from "./SpacePresentation";
import { SpaceStage } from "../stage/SpaceStage";
import { DRAWER_EXIT_MS, useDrawerPresence } from "./useDrawerPresence";
import type { ChatUploadFile } from "@q9labsai/chalk-client";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";

// The knock notice is not needed to start a call, so it loads when the first request arrives.
const KnockNotice = lazy(() => import("../admission-panel/KnockNotice").then((module) => ({ default: module.KnockNotice })));

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
  readonly presenterId?: string | null;
  readonly props: WhiteboardViewProps;
  /** Shares this person's board view so others can follow it; answers false when the board service can't. */
  readonly sendView?: (view: ChalkWhiteboardView) => boolean;
}

export interface SpaceViewProps {
  readonly timeLimit?: { readonly message: string; readonly action?: { readonly label: string; readonly onClick: () => void } };
  readonly colorScheme?: "light" | "dark";
  readonly onColorSchemeChange?: (colorScheme: "light" | "dark") => void;
  readonly spaceName: string;
  readonly shareUrl?: string;
  readonly callLinkOpen?: boolean;
  readonly onCallLinkToggle?: () => void;
  readonly onReportProblem?: import("../space-header/SpaceHeader").SpaceHeaderProps["onReportProblem"];
  readonly reportUnavailableReason?: string;
  readonly onOpenReportProblem?: () => void;
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
  /** Rejoin after the call could not be recovered; the failed card offers it. */
  readonly onRejoin?: () => void;
  readonly overlay?: React.ReactNode;
  readonly onLeft?: () => void | Promise<void>;
  readonly onEndEpisode?: () => void | Promise<void>;
  readonly className?: string;
}

function toggleCallFullscreen() {
  const frame = document.activeElement?.closest<HTMLElement>("[data-part=call-frame]") ?? document.querySelector<HTMLElement>("[data-part=call-frame]");
  const request = document.fullscreenElement ? document.exitFullscreen() : frame?.requestFullscreen();
  // The browser can refuse (an embedding frame without the fullscreen permission); the call stays as it is.
  request?.catch(() => undefined);
}

export function SpaceView({
  timeLimit,
  colorScheme = "dark",
  onColorSchemeChange,
  spaceName,
  shareUrl,
  callLinkOpen,
  onCallLinkToggle,
  onReportProblem,
  reportUnavailableReason,
  onOpenReportProblem,
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
  onRejoin,
  overlay,
  onLeft,
  onEndEpisode,
  className,
}: SpaceViewProps): React.JSX.Element {
  const phone = useIsMobile();
  const effectiveShareUrl = inviteLink ?? shareUrl;
  const callToasts = useCallToasts();
  const [soundsEnabled] = useSoundsSetting();
  const client = useSpaceClient();
  const connection = useConnection();
  const connectionPhase = useConnectionPhase(connection.status);
  // A lost connection clears the roster and the tracks, so the call behind the failure card keeps what it last showed.
  const connectionLost = connectionPhase.kind === "failed";
  const self = useHeldWhile(useSelf(), connectionLost);
  const participantsSlice = useHeldWhile(useParticipants(), connectionLost);
  const callLink = useCallLink(participantsSlice.roster.length <= 1);
  const media = useHeldWhile(useMedia(), connectionLost);
  const mediaRequest = media.incomingRequests[0];
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
  const recordingSeconds = useRecordingSeconds(recording.current?.status, episodeDuration);
  const deadline = connection.episode?.deadline;
  const [now, setNow] = useState(Date.now);
  const previousCountdown = useRef<{ deadline: typeof deadline; seconds: number | null } | null>(null);
  const [limitWarning, setLimitWarning] = useState<{ id: string; minutes: number } | null>(null);
  const countdown = callCountdown(deadline, now);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Refresh the call-limit clock each second; clear the interval when the deadline changes.
  useEffect(() => {
    if (!deadline) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Emit warnings only when the committed countdown crosses a threshold; preserve a dismissed warning between ticks.
  useEffect(() => {
    const previous = previousCountdown.current;
    const next = callCountdown(deadline, now, previous?.deadline === deadline ? previous?.seconds : undefined);
    previousCountdown.current = { deadline, seconds: next.seconds };
    if (previous?.deadline !== deadline) setLimitWarning(null);
    if (next.warning !== null) setLimitWarning({ id: `time-limit-${deadline}-${next.warning}`, minutes: next.warning });
  }, [deadline, now]);
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus">(controlledLayout ?? "focus");
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [hiddenKnocks, setHiddenKnocks] = useState<ReadonlySet<string>>(new Set());
  const handOrders = useHandOrder(useMemo(() => participantsSlice.roster.filter((person) => person.handRaised).map((person) => person.participantId), [participantsSlice.roster]));
  const [previousInitialPanel, setPreviousInitialPanel] = useState(initialPanel);
  if (previousInitialPanel !== initialPanel) {
    setPreviousInitialPanel(initialPanel);
    setActivePanel(initialPanel);
  }
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  // While reconnecting the tray stays usable: a raised hand waits for the connection, and only the emoji pause.
  const reactionsReachable = connection.status === "live" || connection.status === "reconnecting";
  // The tray unmounts when the call leaves live, so its open flag must not survive to the next live call.
  if (isReactionPickerOpen && !reactionsReachable) setReactionPickerOpen(false);
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
  const seenConnected = useSeenConnected(participantsSlice.roster);
  const tiles = useMemo(
    () =>
      toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local).map(({ isReconnecting, ...tile }) => ({
        ...tile,
        ...(isReconnecting && seenConnected.has(tile.id) ? { isReconnecting } : {}),
        screenShareHasAudio: tile.isLocal ? media.screenShare.hasAudio : participantsSlice.roster.find((person) => person.participantId === tile.id)?.media.screenShareHasAudio,
      })),
    [localId, media.local, media.remote, media.screenShare.hasAudio, participantsSlice.roster, seenConnected, self.displayName],
  );
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
  const headerLayout = pinnedId ? "focus" : layout;
  const updateLayout = (nextLayout: "grid" | "focus") => {
    if (nextLayout === "grid") setPinnedId(null);
    setUncontrolledLayout(nextLayout);
    onLayoutChange?.(nextLayout);
  };
  const playSound = useSoundCues(feature("sounds") && soundsEnabled);
  const prefersReducedMotion = usePrefersReducedMotion();
  const drawer = useDrawerPresence(activePanel, prefersReducedMotion ? 0 : DRAWER_EXIT_MS);
  const { store: deviceAccess, snapshot: deviceAccessSnapshot } = useDeviceAccess();
  const runCommand = useCallback(
    async (command: () => Promise<unknown>, source?: MediaCommandSource, action?: MediaCommandAction) => {
      try {
        await command();
        if (source && source !== "speaker") deviceAccess.clear(source);
        setCommandError(null);
        setCommandSource(undefined);
        setCommandAction(undefined);
        setRetryCommand(undefined);
      } catch (cause) {
        const failure = commandFailure(cause);
        if (source && source !== "speaker") void deviceAccess.report(source, failure, () => runCommand(command, source, action));
        setCommandError(failure);
        setCommandSource(source);
        setCommandAction(action);
        setRetryCommand(() => command);
      }
    },
    [deviceAccess],
  );
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
  const shownFailure = typeof displayedCommandError === "object" ? displayedCommandError : null;
  const failureAction = externalCommandError != null ? externalCommandAction : commandAction;
  // A refused microphone, camera or screen share that the dock ran is shown by the access card on its button, not as a toast. A failure a caller passes in has no card.
  const mappedFailure =
    externalCommandError == null && !deviceAccessSnapshot.unavailable && shownFailure && isDeviceAccessFailure(shownFailure, displayedCommandSource)
      ? null
      : mediaFailureToast(shownFailure, displayedCommandSource, failureAction, externalCommandError == null && retryCommand ? () => void retryMedia() : undefined);
  const commandToasts: Toast[] = mappedFailure ? [{ id: "space-command-error", ...mappedFailure }] : typeof displayedCommandError === "string" ? [{ id: "space-command-error", message: displayedCommandError, type: "error" }] : [];
  const [boardToasts, setBoardToasts] = useState<readonly Toast[]>([]);
  const boardToastCount = useRef(0);
  const [previousBoardOpen, setPreviousBoardOpen] = useState(whiteboard?.isOpen);
  if (previousBoardOpen !== whiteboard?.isOpen) {
    setPreviousBoardOpen(whiteboard?.isOpen);
    if (!whiteboard?.isOpen) setBoardToasts([]);
  }
  const showBoardToast = useCallback((toast: BoardToast | null) => {
    if (!toast) {
      setBoardToasts([]);
      return;
    }
    boardToastCount.current += 1;
    const id = `board-${boardToastCount.current}`;
    // The same board message again replaces its notice instead of stacking a copy under it.
    setBoardToasts((current) => [...current.filter((shown) => shown.message !== toast.message).slice(-2), { ...toast, id }]);
  }, []);
  const dismissCommandError = () => {
    if (commandError && typeof commandError === "object") callToasts.dismissFailure(commandError.code);
    setCommandError(null);
    onDismissCommandError?.();
  };
  // A microphone or camera that failed without an access card gets one notice in the call's stack, above the dock, until it recovers or is dismissed.
  const mediaNotice = failedMediaNotice(media.local, deviceAccessSnapshot.issues);
  const [dismissedMediaNotice, setDismissedMediaNotice] = useState<string | undefined>(undefined);
  const mediaToast: Toast[] = mediaNotice && mediaNotice !== dismissedMediaNotice ? [{ id: "media-notice", type: "error", duration: Infinity, message: mediaNotice }] : [];
  const limitToast: Toast[] = limitWarning
    ? [{ id: limitWarning.id, type: limitWarning.minutes === 1 ? "error" : "warning", duration: Infinity, message: `${limitWarning.minutes} ${limitWarning.minutes === 1 ? "minute" : "minutes"} left. ${timeLimit?.message ?? "This call is reaching its time limit."}`, action: timeLimit?.action }]
    : [];
  const toasts = [
    ...limitToast,
    ...callToasts.toasts.filter((toast) => !(typeof displayedCommandError === "object" && displayedCommandError && toast.failureCode === displayedCommandError.code)),
    ...(whiteboard?.isOpen ? boardToasts : []),
    ...commandToasts,
    ...mediaToast,
    ...(offlineNotice ? [{ id: "offline-notice", message: offlineNotice }] : []),
  ];
  const dismissToast = (id: string) => {
    if (id.startsWith("time-limit-")) setLimitWarning(null);
    else if (id === "space-command-error") dismissCommandError();
    else if (id === "offline-notice") setDismissedOfflineNotice(offline.notice ?? null);
    else if (id === "media-notice") setDismissedMediaNotice(mediaNotice);
    else if (id.startsWith("board-")) setBoardToasts((current) => current.filter((toast) => toast.id !== id));
    else callToasts.dismiss(id);
  };
  const [foldedNotices, setFoldedNotices] = useState<readonly string[]>([]);
  const microphoneTarget = mediaToggleTarget(media.local.microphone.state, connection.status === "live");
  const cameraTarget = mediaToggleTarget(media.local.camera.state, connection.status === "live");
  const folded = toasts.filter((toast) => foldedNotices.includes(toast.id));
  return (
    <ParticipantVolumeProvider>
      <BoardToastContext.Provider value={showBoardToast}>
        <FrozenFramesContext.Provider value={connectionPhase.kind === "reconnecting" || connectionPhase.kind === "failed"}>
          <SpacePresentation
            connectionTrouble={connectionPhase.kind === "failed" ? "lost" : connectionPhase.kind === "reconnecting" ? "reconnecting" : undefined}
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
              onOpenReportProblem,
              reportUnavailableReason,
              diagnostics: callDiagnostics(connection, media),
              network: { live: connection.status === "live", samples: media.callStats, link: media.link },
              videoOn: media.local.camera.state === "enabled",
              onTurnOffVideo: () => void runCommand(() => client.media.setCameraEnabled(false), "camera", "stop"),
              shortcuts: {
                isMuted: media.local.microphone.state !== "enabled",
                onToggleMute: microphoneTarget === undefined ? undefined : () => void runCommand(() => client.media.setMicrophoneEnabled(microphoneTarget), "microphone", microphoneTarget ? "start" : "stop"),
                onToggleVideo: cameraTarget === undefined ? undefined : () => void runCommand(() => client.media.setCameraEnabled(cameraTarget), "camera", cameraTarget ? "start" : "stop"),
                onToggleHand: feature("handRaise") && canRaiseHand ? () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())) : undefined,
                onToggleChat: feature("chat") ? () => setActivePanel((current) => (current === "chat" ? null : "chat")) : undefined,
                onTogglePeople: feature("participants") ? () => setActivePanel((current) => (current === "participants" ? null : "participants")) : undefined,
                onToggleLayout: () => updateLayout(headerLayout === "grid" ? "focus" : "grid"),
                onToggleFullscreen: toggleCallFullscreen,
                onClosePanel: () => setActivePanel(null),
                onPushToTalk: (enabled) => {
                  if (enabled && connection.status !== "live") return;
                  void runCommand(() => client.media.setMicrophoneEnabled(enabled), "microphone", enabled ? "start" : "stop");
                },
              },
              duration: episodeDuration,
              timeLeft: countdown.seconds,
              isRecording: recording.current?.status === "recording",
              recordingSeconds,
              onStopRecording:
                feature("recording") && canManageRecording
                  ? () =>
                      void runCommand(() =>
                        client.recording.stop().catch((cause: unknown) => {
                          throw recordingFailure(cause, "stop");
                        }),
                      )
                  : undefined,
              layout: headerLayout,
              onLayoutChange: updateLayout,
              notices: folded.length ? <NoticeButton toasts={folded} onDismiss={dismissToast} /> : undefined,
            }}
            stage={
              <SpaceStage
                pinnedId={pinnedId}
                onPinnedChange={setPinnedId}
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
              <DeviceAccessProvider value={deviceAccess}>
                <ControlBar
                  density="comfortable"
                  layout={layout}
                  onLayoutChange={updateLayout}
                  buttons={buttons}
                  activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
                  onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
                  onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
                  onToggleWhiteboard={onToggleWhiteboard}
                  isWhiteboardOpen={whiteboard?.isOpen}
                  onOpenReactions={() => setReactionPickerOpen((current) => !current)}
                  reactionsOpen={isReactionPickerOpen}
                  onCommandError={onCommandError}
                  onLeaveRequest={leaveCall}
                  onEndForEveryone={endCallForEveryone}
                />
              </DeviceAccessProvider>
            }
            stageOverlay={
              <>
                {feature("reactions") ? <ReactionsOverlay /> : null}
                {/* The tray wrapper must not be transformed: a transformed ancestor shrinks the tray's fixed backdrop to an empty box. Its z-index stays under the notices (45) so they remain clickable over the backdrop. */}
                <LiveConnectionStatus phase={connectionPhase} onRejoin={onRejoin} onLeave={leaveCall} onReportProblem={onOpenReportProblem} />
                {feature("reactions") && canSendReaction && reactionsReachable ? (
                  <div className="absolute bottom-24 left-1/2 z-44">
                    <ReactionPicker
                      isHandRaised={self.handRaised}
                      onToggleHandRaise={feature("handRaise") && canRaiseHand ? () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())) : undefined}
                      isOpen={isReactionPickerOpen}
                      onClose={() => setReactionPickerOpen(false)}
                      allowedReactions={[...DEFAULT_QUICK_REACTIONS]}
                      emojiPaused={connection.status !== "live"}
                      onSelect={(reaction) => void runCommand(() => client.reactions.send(reaction as Reaction))}
                      size="compact"
                    />
                  </div>
                ) : null}
              </>
            }
            sidebar={
              <CallCard state={drawer.state} panel={drawer.panel} onPanelChange={setActivePanel} peopleCount={participantsSlice.roster.length} participantsEnabled={feature("participants")} chatEnabled={feature("chat")} onClose={() => setActivePanel(null)}>
                {drawer.panel === "chat" && feature("chat") ? <ChatPanel variant="mobile" generatedAvatars={generatedAvatars} onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
                {drawer.panel === "participants" && feature("participants") ? (
                  <ParticipantsPanel
                    onParticipantClick={(id) => {
                      setPinnedId((current) => (current === id ? null : id));
                      if (phone) setActivePanel(null);
                    }}
                    variant="mobile"
                    handOrders={handOrders}
                    admissionEnabled={feature("admission")}
                    generatedAvatars={generatedAvatars}
                    onCommandError={onCommandError}
                    onClose={() => setActivePanel(null)}
                  />
                ) : null}
                {drawer.panel === "admission" && feature("admission") ? (
                  <Suspense fallback={null}>
                    <AdmissionPanel className="h-full w-full rounded-none shadow-none" onClose={() => setActivePanel(null)} />
                  </Suspense>
                ) : null}
              </CallCard>
            }
            toasts={
              <ToastStack toasts={toasts} onDismiss={dismissToast} onFold={setFoldedNotices}>
                {mediaRequest ? (
                  <MediaRequestDialog
                    request={mediaRequest}
                    onDecline={() => void runCommand(() => client.media.declineRequest(mediaRequest.requestId), mediaRequest.kind === "start_camera" ? "camera" : "microphone", "request")}
                    onAllow={() => void runCommand(() => client.media.acceptRequest(mediaRequest.requestId), mediaRequest.kind === "start_camera" ? "camera" : "microphone", "request")}
                  />
                ) : null}
              </ToastStack>
            }
            mediaOutput={
              <div className="[&>div]:top-[68px] [&>div>button]:h-11 [&>div>button]:shadow-(--elevation-toast)">
                <AudioOutput resumeAudioLabel="Your browser paused the sound. Click to hear the call" />
              </div>
            }
            overlays={
              <>
                {feature("admission") && canManageAdmission && participantsSlice.admissionQueue.length > 0 && activePanel !== "participants" ? (
                  <Suspense fallback={null}>
                    <KnockNotice hiddenIds={hiddenKnocks} onReview={() => setActivePanel(feature("participants") ? "participants" : "admission")} onHide={(ids) => setHiddenKnocks((current) => new Set([...current, ...ids]))} />
                  </Suspense>
                ) : null}
                {overlay}
              </>
            }
            className={className}
          />
        </FrozenFramesContext.Provider>
      </BoardToastContext.Provider>
    </ParticipantVolumeProvider>
  );
}
