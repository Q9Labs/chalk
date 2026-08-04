"use client";

import { toSpaceClientStore, type SpaceClientStore, type SpaceClientStoreInput, type SpacePhase, type SpaceSnapshotView } from "../../client-compat";
import { useCallback, useMemo, useRef, useState } from "react";

import type { WaitingParticipant } from "../admission-panel/AdmissionPanel";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import type { SettingsDialogValue } from "../composite/SettingsDialog";
import { ConferenceView, type ConferenceLayout, type ConferencePanel, type ConferenceViewProps } from "../conference-view/ConferenceView";
import type { ControlBarButtonName } from "../control-bar/ControlBar";
import { EndScreen } from "../full/EndScreen";
import { JoiningScreen } from "../joining-screen/JoiningScreen";
import { PreJoinScreen, type PreJoinSettings } from "../pre-join-screen/PreJoinScreen";
import { ChalkProvider, useAutoJoin, useChalkActions, useChalkSession, useChalkSnapshot, useConferenceEvents, useConferencePhase, useConferencePhaseObserver, useConferenceDuration, useLeaveOnUnmount, useLocalMedia, useParticipants, useRemoteMedia, useWhiteboardScene } from "../../session";
import type { ConferenceEventHandlers } from "../../session/use-conference-events";
import { toAudioParticipants, toListParticipants, toParticipantNames, toVideoParticipants } from "../../selectors/meeting-room-selectors";
import { cn } from "../../utils/cn";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { uploadChatAttachment } from "../composite/chat-file-upload";

type DisposableSpaceClientStore = SpaceClientStore & { readonly dispose?: () => void };

export type VideoConferenceRole = "host" | "participant";

export interface VideoConferenceProps {
  readonly roomId: string;
  readonly roomName?: string;
  readonly logoUrl?: string;
  readonly meetingLink?: string;
  readonly userName?: string;
  readonly role?: VideoConferenceRole;
  readonly autoJoin?: boolean;
  readonly initialPhase?: SpacePhase;
  readonly initialJoinSettings?: Partial<PreJoinSettings>;
  readonly phase?: SpacePhase;
  readonly layout?: ConferenceLayout;
  readonly onLayoutChange?: (layout: ConferenceLayout) => void;
  readonly onPhaseChange?: (phase: SpacePhase) => void;
  readonly createSession: (settings: PreJoinSettings) => SpaceClientStoreInput | Promise<SpaceClientStoreInput>;
  readonly chatEnabled?: boolean;
  readonly participantsEnabled?: boolean;
  readonly admissionEnabled?: boolean;
  readonly screenShareEnabled?: boolean;
  readonly whiteboardEnabled?: boolean;
  readonly reactionsEnabled?: boolean;
  readonly handRaiseEnabled?: boolean;
  readonly infoEnabled?: boolean;
  readonly settingsEnabled?: boolean;

  readonly canShareScreen?: boolean;
  readonly canSendChat?: boolean;
  readonly canManageParticipants?: boolean;
  readonly canAdmit?: boolean;
  readonly canReact?: boolean;
  readonly canRaiseHand?: boolean;
  readonly canUseWhiteboard?: boolean;
  readonly canInvite?: boolean;
  readonly canLeave?: boolean;

  readonly onSessionChange?: (session: SpaceClientStore | null) => void;
  readonly onParticipantJoined?: ConferenceEventHandlers["onParticipantJoined"];
  readonly onParticipantLeft?: ConferenceEventHandlers["onParticipantLeft"];
  readonly onScreenShareStarted?: ConferenceEventHandlers["onScreenShareStarted"];
  readonly onScreenShareStopped?: ConferenceEventHandlers["onScreenShareStopped"];
  readonly onSessionEnded?: ConferenceEventHandlers["onSessionEnded"];
  readonly onLeave?: () => void | Promise<void>;
  readonly onClose?: () => void;
  readonly onError?: (error: Error) => void;
  readonly className?: string;
}

type ActiveVideoConferenceProps = VideoConferenceProps & {
  readonly session: SpaceClientStore;
  readonly settings: PreJoinSettings;
  readonly phase: SpacePhase;
  readonly layout: ConferenceLayout;
  readonly onLayoutChange: (layout: ConferenceLayout) => void;
  readonly onJoinFailure: (error: Error) => void;
  readonly onRejoin: () => void;
  readonly onFinished: (data: { readonly duration: number; readonly participantCount: number }) => void;
  readonly onSettingsChange: (updates: Partial<PreJoinSettings>) => void;
};

export function VideoConference(props: VideoConferenceProps): React.JSX.Element {
  const defaultSettings = useMemo(
    (): PreJoinSettings => ({
      displayName: props.initialJoinSettings?.displayName?.trim() || props.userName?.trim() || (props.role === "host" ? "Host" : "Guest"),
      microphoneEnabled: props.initialJoinSettings?.microphoneEnabled ?? true,
      cameraEnabled: props.initialJoinSettings?.cameraEnabled ?? true,
    }),
    [props.initialJoinSettings, props.role, props.userName],
  );
  const [session, setSession] = useState<SpaceClientStore | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [hasAskedToJoin, setHasAskedToJoin] = useState(props.autoJoin === true || props.initialPhase === "joining");
  const [hasAskedToLeave, setHasAskedToLeave] = useState(props.initialPhase === "ended");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [endData, setEndData] = useState<{ readonly duration: number; readonly participantCount: number } | null>(null);
  const [uncontrolledLayout, setUncontrolledLayout] = useState<ConferenceLayout>(props.layout ?? "focus");
  const creationAttempt = useRef(0);
  const phase = useConferencePhase(session, { hasAskedToJoin, hasAskedToLeave }, session || creationAttempt.current > 0 ? undefined : props.initialPhase);
  const renderedPhase = props.phase ?? phase;
  const layout = props.layout ?? uncontrolledLayout;

  useConferencePhaseObserver(renderedPhase, props.onPhaseChange);
  useLeaveOnUnmount(session, () => {
    creationAttempt.current += 1;
  });

  const handleCreateError = useCallback(
    (error: Error) => {
      setJoinError(error.message);
      setHasAskedToJoin(false);
      props.onError?.(error);
    },
    [props.onError],
  );
  const begin = useCallback(
    async (nextSettings: PreJoinSettings) => {
      const normalizedSettings: PreJoinSettings = {
        displayName: nextSettings.displayName.trim() || defaultSettings.displayName,
        microphoneEnabled: nextSettings.microphoneEnabled,
        cameraEnabled: nextSettings.cameraEnabled,
      };
      const attempt = ++creationAttempt.current;
      setSettings(normalizedSettings);
      setHasAskedToJoin(true);
      setHasAskedToLeave(false);
      setJoinError(null);
      setEndData(null);

      try {
        const nextSession = toSpaceClientStore(await props.createSession(normalizedSettings));
        if (attempt !== creationAttempt.current) {
          try {
            await nextSession.leave();
          } catch {
            // A stale creation cannot surface a leave error to an unmounted conference.
          } finally {
            (nextSession as DisposableSpaceClientStore).dispose?.();
          }
          return;
        }
        setSession(nextSession);
        props.onSessionChange?.(nextSession);
      } catch (cause) {
        if (attempt !== creationAttempt.current) return;
        handleCreateError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
    [creationAttempt, defaultSettings.displayName, handleCreateError, props.createSession, props.onSessionChange],
  );

  useAutoJoin((props.autoJoin === true || props.initialPhase === "joining") && session === null, () => begin(defaultSettings), handleCreateError);

  const handleJoinFailure = useCallback(
    (error: Error) => {
      creationAttempt.current += 1;
      void session?.leave().catch(() => undefined);
      setSession(null);
      props.onSessionChange?.(null);
      setJoinError(error.message);
      setHasAskedToJoin(false);
      setHasAskedToLeave(false);
      props.onError?.(error);
    },
    [creationAttempt, props.onError, props.onSessionChange, session],
  );
  const handleLayoutChange = useCallback(
    (nextLayout: ConferenceLayout) => {
      setUncontrolledLayout(nextLayout);
      props.onLayoutChange?.(nextLayout);
    },
    [props.onLayoutChange],
  );
  const handleRejoin = useCallback(() => {
    creationAttempt.current += 1;
    setSession(null);
    props.onSessionChange?.(null);
    setHasAskedToJoin(false);
    setHasAskedToLeave(false);
    setJoinError(null);
    setEndData(null);
  }, [creationAttempt, props.onSessionChange]);

  if (!session) {
    return renderLifecycleScreen({
      phase: renderedPhase,
      roomName: props.roomName ?? props.roomId,
      logoUrl: props.logoUrl,
      settings,
      joinError,
      onJoin: begin,
      onClose: props.onClose,
      onRejoin: handleRejoin,
      endData,
      className: props.className,
    });
  }

  return (
    <ChalkProvider session={session}>
      <ActiveVideoConference
        {...props}
        session={session}
        settings={settings}
        phase={renderedPhase}
        layout={layout}
        onLayoutChange={handleLayoutChange}
        onJoinFailure={handleJoinFailure}
        onRejoin={handleRejoin}
        onSettingsChange={(updates) => setSettings((current) => ({ ...current, ...updates }))}
        onFinished={(data) => {
          setEndData(data);
          setHasAskedToLeave(true);
          setSession(null);
          props.onSessionChange?.(null);
          void Promise.resolve(props.onLeave?.()).catch((cause: unknown) => props.onError?.(cause instanceof Error ? cause : new Error(String(cause))));
        }}
      />
    </ChalkProvider>
  );
}

function renderLifecycleScreen(input: {
  readonly phase: SpacePhase;
  readonly roomName: string;
  readonly logoUrl?: string;
  readonly settings: PreJoinSettings;
  readonly joinError: string | null;
  readonly onJoin: (settings: PreJoinSettings) => void | Promise<void>;
  readonly onClose?: () => void;
  readonly onRejoin: () => void;
  readonly endData: { readonly duration: number; readonly participantCount: number } | null;
  readonly className?: string;
}): React.JSX.Element {
  switch (input.phase) {
    case "prejoin":
      return (
        <PreJoinScreen
          roomName={input.roomName}
          logoUrl={input.logoUrl}
          defaultDisplayName={input.settings.displayName}
          initialMicrophoneEnabled={input.settings.microphoneEnabled}
          initialCameraEnabled={input.settings.cameraEnabled}
          error={input.joinError ?? undefined}
          onJoin={input.onJoin}
          className={input.className}
        />
      );
    case "ended":
      return <EndScreen roomName={input.roomName} duration={input.endData?.duration ?? 0} participantCount={input.endData?.participantCount ?? 0} onRejoin={input.onRejoin} onGoHome={input.onClose} className={input.className} />;
    case "joining":
    case "waiting":
    case "active":
    case "reconnecting":
      return <JoiningScreen message={`Joining ${input.roomName}`} displayName={input.settings.displayName} className={cn("bg-[#f7f6f2] text-[#0c0e12]", input.className)} />;
  }
}

function ActiveVideoConference(props: ActiveVideoConferenceProps): React.JSX.Element {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const actions = useChalkActions();
  const participants = useParticipants();
  const localMedia = useLocalMedia();
  const remoteMedia = useRemoteMedia();
  const [layoutPanel, setLayoutPanel] = useState<ConferencePanel | null>(null);
  const [isInfoOpen, setInfoOpen] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [isWhiteboardOpen, setWhiteboardOpen] = useState(false);
  const [loadingOlderChat, setLoadingOlderChat] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [dialogSettings, setDialogSettings] = useState<SettingsDialogValue>(() => defaultDialogSettings(props.settings, props.layout ?? "focus"));

  const handleJoinError = useCallback((error: Error) => props.onJoinFailure(error), [props.onJoinFailure]);
  useAutoJoin(true, actions.join, handleJoinError);
  const duration = useConferenceDuration(snapshot.connectionStatus);
  const handleWhiteboardError = useCallback((message: string) => setCommandError(message), []);
  useWhiteboardScene(session.whiteboard, isWhiteboardOpen, handleWhiteboardError);
  useConferenceEvents(snapshot, {
    onParticipantJoined: props.onParticipantJoined,
    onParticipantLeft: props.onParticipantLeft,
    onScreenShareStarted: props.onScreenShareStarted,
    onScreenShareStopped: props.onScreenShareStopped,
    onSessionEnded: props.onSessionEnded,
  });

  const localId = snapshot.self?.participantId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participants, remoteMedia, localId, props.settings.displayName, localMedia), [localId, localMedia, participants, props.settings.displayName, remoteMedia]);
  const audioParticipants = useMemo(() => toAudioParticipants(remoteMedia), [remoteMedia]);
  const participantNames = useMemo(() => toParticipantNames(participants, localId, props.settings.displayName), [localId, participants, props.settings.displayName]);
  const listParticipants = useMemo(() => toListParticipants(tiles, participants, snapshot.participantMediaById), [participants, snapshot.participantMediaById, tiles]);
  const localParticipant = participants.find((participant) => participant.participantId === localId);
  const localCapabilities = snapshot.capabilities;
  const microphoneEnabled = localMedia.microphone.state === "enabled" || localMedia.microphone.state === "requesting";
  const cameraEnabled = localMedia.camera.state === "enabled" || localMedia.camera.state === "requesting";
  const screenSharing = localMedia.screen.state === "enabled" || localMedia.screen.state === "requesting";
  const handRaised = localParticipant?.handRaised ?? false;
  const canChat = props.chatEnabled !== false && (props.canSendChat ?? snapshot.capabilities.includes("sendChat"));
  const canReact = props.reactionsEnabled !== false && (props.canReact ?? snapshot.capabilities.includes("sendReaction"));
  const canRequestMedia = localCapabilities.includes("requestMediaOthers");
  const canManageParticipants = props.canManageParticipants ?? localCapabilities.some((capability) => ["muteOthers", "stopVideoOthers", "removeParticipant", "assignRoles"].includes(capability));
  const canShareScreen = props.screenShareEnabled !== false && (props.canShareScreen ?? localCapabilities.includes("publishScreen"));
  const canRaiseHand = props.handRaiseEnabled !== false && (props.canRaiseHand ?? localCapabilities.includes("raiseHand"));
  const canUseWhiteboard = props.whiteboardEnabled !== false && (props.canUseWhiteboard ?? (session.whiteboard !== null && snapshot.capabilities.includes("drawWhiteboard")));
  const canInvite = props.canInvite ?? Boolean(props.meetingLink);
  const canLeave = props.canLeave !== false;
  const canAdmit = props.admissionEnabled !== false && (props.canAdmit ?? localCapabilities.includes("manageAdmission"));
  const chatFiles = snapshot.connectionStatus === "live" ? session.files : null;
  const incomingRequest = snapshot.incomingMediaRequests[0];
  const remoteScreenShare = tiles.find((participant) => participant.isScreenSharing && participant.screenShareTrack);
  const screenShare = remoteScreenShare?.screenShareTrack
    ? {
        screenShareTrack: remoteScreenShare.screenShareTrack,
        sharedByName: remoteScreenShare.displayName,
      }
    : undefined;
  const effectiveLayout = screenSharing || tiles.some((participant) => participant.isScreenSharing) ? "presentation" : props.layout;

  const admissionKey = snapshot.admissionRequests.map((request) => request.requestId).join(",");
  const [dismissedAdmissionKey, setDismissedAdmissionKey] = useState("");
  const activePanel = layoutPanel ?? (canAdmit && admissionKey && dismissedAdmissionKey !== admissionKey ? "admission" : null);

  const runCommand = useCallback(async (operation: () => Promise<unknown>, fallback: string) => {
    try {
      await operation();
      setCommandError("");
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : fallback);
    }
  }, []);
  const togglePanel = useCallback((panel: ConferencePanel) => setLayoutPanel((current) => (current === panel ? null : panel)), []);
  const leave = useCallback(async () => {
    try {
      await session.leave();
      props.onFinished({ duration, participantCount: participants.length });
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "The meeting could not confirm your leave");
    }
  }, [duration, participants.length, props.onFinished, session]);
  const copyLink = useCallback(async () => {
    if (props.meetingLink && navigator.clipboard) await navigator.clipboard.writeText(props.meetingLink);
  }, [props.meetingLink]);
  const loadOlderChat = useCallback(async () => {
    setLoadingOlderChat(true);
    try {
      await actions.loadOlderChatMessages();
    } finally {
      setLoadingOlderChat(false);
    }
  }, [actions]);
  const whiteboard = useMemo(() => createWhiteboardView(props, session, snapshot, isWhiteboardOpen), [isWhiteboardOpen, props, session, snapshot]);
  const controls = useMemo(
    () =>
      createControls({
        canChat,
        canReact,
        canRaiseHand,
        canShareScreen,
        canUseWhiteboard,
        cameraEnabled,
        handRaised,
        isChatOpen: layoutPanel === "chat",
        isParticipantsOpen: layoutPanel === "participants",
        isWhiteboardOpen,
        microphoneEnabled,
        screenSharing,
        canLeave,
        participantsEnabled: props.participantsEnabled !== false,
        settingsEnabled: props.settingsEnabled !== false,
        onToggleChat: () => togglePanel("chat"),
        onToggleHandRaise: () => void runCommand(() => actions.setHandRaised(!handRaised), "Hand raise failed"),
        onToggleMute: () => void runCommand(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed"),
        onToggleVideo: () => void runCommand(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed"),
        onToggleParticipants: () => togglePanel("participants"),
        onToggleScreenShare: () => void runCommand(() => (screenSharing ? actions.stopScreenShare() : actions.startScreenShare()), "Screen sharing update failed"),
        onToggleWhiteboard: () => setWhiteboardOpen((current) => !current),
        onOpenMore: () => setSettingsOpen(true),
        unreadChatCount: snapshot.chat.unreadCount,
      }),
    [actions, canChat, canLeave, canRaiseHand, canReact, canShareScreen, canUseWhiteboard, cameraEnabled, handRaised, isWhiteboardOpen, layoutPanel, microphoneEnabled, props.participantsEnabled, props.settingsEnabled, runCommand, screenSharing, snapshot.chat.unreadCount, togglePanel],
  );

  const closePanel = useCallback(
    (panel: ConferencePanel | null) => {
      if (panel === null && layoutPanel === null && activePanel === "admission") setDismissedAdmissionKey(admissionKey);
      setLayoutPanel(panel);
    },
    [activePanel, admissionKey, layoutPanel],
  );
  const panels = useMemo<ConferenceViewProps["panels"]>(
    () => ({
      active: activePanel,
      onChange: closePanel,
      chat: canChat
        ? {
            messages: snapshot.chat.messages,
            pendingMessages: snapshot.chat.pendingSends,
            readReceipts: snapshot.chat.readReceipts,
            participantNames,
            localParticipantId: localId,
            hasOlder: snapshot.chat.pagination.hasOlder,
            loadingOlder: loadingOlderChat,
            error: snapshot.chat.lastError?.message,
            onSendMessage: async ({ text, attachments }) => {
              await actions.sendChatMessage({ text, attachments });
            },
            onUploadAttachment: chatFiles ? (file) => uploadChatAttachment(file, chatFiles) : undefined,
            onResolveAttachmentUrl: chatFiles
              ? async (attachmentId) => {
                  const attachment = [...snapshot.chat.messages, ...snapshot.chat.pendingSends].flatMap((message) => message.attachments).find((candidate) => candidate.attachmentId === attachmentId);
                  if (!attachment) throw new Error("The chat attachment is no longer available");
                  return chatFiles.url(attachment);
                }
              : undefined,
            onMarkRead: (throughSequence) => actions.markChatRead(throughSequence),
            onRetryMessage: async (clientMessageId) => {
              await actions.retryChatMessage(clientMessageId);
            },
            onLoadOlder: loadOlderChat,
          }
        : undefined,
      participants:
        props.participantsEnabled !== false
          ? {
              participants: listParticipants,
              searchable: true,
              canManageParticipants: canManageParticipants || canRequestMedia,
              onMuteParticipant: localCapabilities.includes("muteOthers") ? (id) => void runCommand(() => actions.muteParticipant(id), "Mute failed") : undefined,
              onRequestUnmute: canRequestMedia ? (id) => void runCommand(() => actions.requestUnmute(id), "Unmute request failed") : undefined,
              onStopParticipantCamera: localCapabilities.includes("stopVideoOthers") ? (id) => void runCommand(() => actions.stopParticipantCamera(id), "Camera stop failed") : undefined,
              onRequestStartCamera: canRequestMedia ? (id) => void runCommand(() => actions.requestStartCamera(id), "Camera request failed") : undefined,
              onRemoveParticipant: localCapabilities.includes("removeParticipant") ? (id) => void runCommand(() => actions.removeParticipant(id), "Remove failed") : undefined,
              onMakeHost: localCapabilities.includes("assignRoles") ? (id) => void runCommand(() => actions.assignOwner(id), "Host transfer failed") : undefined,
              onMakeCoHost: localCapabilities.includes("assignRoles") ? (id) => void runCommand(() => actions.assignParticipantRole(id, "collaborator"), "Role update failed") : undefined,
            }
          : undefined,
      admission: canAdmit
        ? {
            participants: snapshot.admissionRequests.map((request): WaitingParticipant => ({ id: request.requestId, displayName: request.displayName })),
            onAdmit: (id) => void runCommand(() => actions.admitParticipant(id), "Admission failed"),
            onDeny: (id) => void runCommand(() => actions.denyAdmission(id), "Admission denial failed"),
          }
        : undefined,
      settings: undefined,
    }),
    [actions, activePanel, canAdmit, canChat, canManageParticipants, canRequestMedia, chatFiles, closePanel, listParticipants, loadOlderChat, localCapabilities, localId, loadingOlderChat, participantNames, props.participantsEnabled, runCommand, snapshot.admissionRequests, snapshot.chat],
  );

  const commitDialogSettings = useCallback(() => {
    const displayName = dialogSettings.identity.displayName.trim();
    if (displayName && displayName !== props.settings.displayName) {
      void runCommand(() => actions.setDisplayName(displayName), "Display name update failed");
      props.onSettingsChange({ displayName });
    }
    props.onSettingsChange({ microphoneEnabled: dialogSettings.join.audioEnabled, cameraEnabled: dialogSettings.join.videoEnabled });
  }, [actions, dialogSettings.identity.displayName, dialogSettings.join.audioEnabled, dialogSettings.join.videoEnabled, props.onSettingsChange, props.settings.displayName, runCommand]);
  const settingsDialog = useMemo(() => {
    if (props.settingsEnabled === false) return undefined;
    return {
      isOpen: isSettingsOpen,
      onOpenChange: (open: boolean) => {
        setSettingsOpen(open);
        if (!open) commitDialogSettings();
      },
      settings: dialogSettings,
      onUpdateIdentity: (updates: Partial<SettingsDialogValue["identity"]>) => setDialogSettings((current) => ({ ...current, identity: { ...current.identity, ...updates } })),
      onUpdateJoin: (updates: Partial<SettingsDialogValue["join"]>) => setDialogSettings((current) => ({ ...current, join: { ...current.join, ...updates } })),
      onUpdateAudio: (updates: Partial<SettingsDialogValue["audio"]>) => setDialogSettings((current) => ({ ...current, audio: { ...current.audio, ...updates } })),
      onUpdateVideo: (updates: Partial<SettingsDialogValue["video"]>) => setDialogSettings((current) => ({ ...current, video: { ...current.video, ...updates } })),
      onUpdateAppearance: (updates: Partial<SettingsDialogValue["appearance"]>) => {
        setDialogSettings((current) => ({ ...current, appearance: { ...current.appearance, ...updates } }));
        if ((updates.layout === "grid" || updates.layout === "focus" || updates.layout === "presentation") && updates.layout !== props.layout) props.onLayoutChange(updates.layout);
      },
      onUpdateExperience: (updates: Partial<SettingsDialogValue["experience"]>) => setDialogSettings((current) => ({ ...current, experience: { ...current.experience, ...updates } })),
      videoTrack: localMedia.camera.track,
      participantColorSeed: props.settings.displayName,
    } satisfies ConferenceViewProps["settingsDialog"];
  }, [commitDialogSettings, dialogSettings, isSettingsOpen, localMedia.camera.track, props.layout, props.onLayoutChange, props.settings.displayName, props.settingsEnabled]);

  if (props.phase === "joining" || props.phase === "waiting") return <JoiningScreen message={`Joining ${props.roomName ?? props.roomId}`} displayName={props.settings.displayName} />;
  if (props.phase === "ended") return <EndScreen roomName={props.roomName ?? props.roomId} duration={duration} participantCount={participants.length} onRejoin={props.onRejoin} onGoHome={props.onClose} />;

  return (
    <ConferenceView
      roomName={props.roomName ?? props.roomId}
      displayName={props.settings.displayName}
      logoUrl={props.logoUrl}
      meetingLink={props.meetingLink}
      duration={duration}
      layout={effectiveLayout}
      onLayoutChange={props.onLayoutChange}
      participants={tiles}
      audioParticipants={audioParticipants}
      screenShare={screenShare}
      whiteboard={whiteboard}
      controls={controls}
      mobileControlButtons={controls.buttons?.filter((button) => button !== "screenshare")}
      panels={panels}
      infoDialog={props.infoEnabled === false ? undefined : { isOpen: isInfoOpen, onOpenChange: setInfoOpen, roomName: props.roomName ?? props.roomId, meetingUrl: props.meetingLink ?? "", onCopyLink: copyLink, meetingDuration: duration }}
      settingsDialog={settingsDialog}
      inviteDialog={canInvite ? { isOpen: isInviteOpen, onOpenChange: setInviteOpen, meetingLink: props.meetingLink ?? "", onCopyLink: copyLink } : undefined}
      reactions={canReact ? { reactions: snapshot.reactions, onSelect: (reaction) => runCommand(() => actions.sendReaction(reaction), "Reaction failed") } : undefined}
      reconnecting={props.phase === "reconnecting" ? { isVisible: true, status: "reconnecting", message: snapshot.failure?.message, onLeave: canLeave ? () => void leave() : undefined } : undefined}
      overlay={
        <>
          {incomingRequest ? (
            <MediaRequestDialog
              request={incomingRequest}
              onDecline={() => void runCommand(() => actions.declineMediaRequest(incomingRequest.requestId), "Media request decline failed")}
              onAllow={() => void runCommand(() => actions.acceptMediaRequest(incomingRequest.requestId), "Media request failed")}
            />
          ) : null}
          <CommandErrorAlert message={commandError || (snapshot.connectionStatus === "live" ? snapshot.failure?.message : undefined)} />
        </>
      }
      onLeave={canLeave ? leave : undefined}
      className={props.className}
    />
  );
}

function createControls(input: {
  readonly canChat: boolean;
  readonly canReact: boolean;
  readonly canRaiseHand: boolean;
  readonly canShareScreen: boolean;
  readonly canUseWhiteboard: boolean;
  readonly cameraEnabled: boolean;
  readonly handRaised: boolean;
  readonly isChatOpen: boolean;
  readonly isParticipantsOpen: boolean;
  readonly isWhiteboardOpen: boolean;
  readonly microphoneEnabled: boolean;
  readonly screenSharing: boolean;
  readonly canLeave: boolean;
  readonly participantsEnabled: boolean;
  readonly settingsEnabled: boolean;
  readonly unreadChatCount: number;
  readonly onToggleChat: () => void;
  readonly onToggleHandRaise: () => void;
  readonly onToggleMute: () => void;
  readonly onToggleVideo: () => void;
  readonly onToggleParticipants: () => void;
  readonly onToggleScreenShare: () => void;
  readonly onToggleWhiteboard: () => void;
  readonly onOpenMore: () => void;
}): NonNullable<ConferenceViewProps["controls"]> {
  const buttons: ControlBarButtonName[] = ["mic", "video"];
  if (input.canShareScreen) buttons.push("screenshare");
  if (input.canUseWhiteboard) buttons.push("whiteboard");
  if (input.canRaiseHand) buttons.push("handraise");
  if (input.canLeave) buttons.push("leave");
  if (input.participantsEnabled) buttons.push("participants");
  if (input.canChat) buttons.push("chat");
  if (input.canReact) buttons.push("reactions");
  if (input.settingsEnabled) buttons.push("more");

  return {
    buttons,
    isMuted: !input.microphoneEnabled,
    isVideoEnabled: input.cameraEnabled,
    isScreenSharing: input.screenSharing,
    isChatOpen: input.isChatOpen,
    isParticipantsOpen: input.isParticipantsOpen,
    isHandRaised: input.handRaised,
    isWhiteboardOpen: input.isWhiteboardOpen,
    unreadChatCount: input.unreadChatCount,
    onToggleMute: input.onToggleMute,
    onToggleVideo: input.onToggleVideo,
    onToggleScreenShare: input.onToggleScreenShare,
    onToggleChat: input.onToggleChat,
    onToggleParticipants: input.onToggleParticipants,
    onToggleHandRaise: input.onToggleHandRaise,
    onToggleWhiteboard: input.onToggleWhiteboard,
    onOpenMore: input.onOpenMore,
  };
}

function createWhiteboardView(props: ActiveVideoConferenceProps, session: SpaceClientStore, snapshot: SpaceSnapshotView, isOpen: boolean): ConferenceViewProps["whiteboard"] {
  if (!isOpen || !session.whiteboard || props.whiteboardEnabled === false || props.canUseWhiteboard === false) return undefined;
  const whiteboard = session.whiteboard;
  return {
    isOpen: true,
    props: {
      canDraw: snapshot.capabilities.includes("drawWhiteboard"),
      collab: {
        canDraw: snapshot.capabilities.includes("drawWhiteboard"),
        subscribe: (listener) => whiteboard.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
        submitUpdate: async (input) => whiteboard.submitUpdate({ sceneId: input.sceneId, syncAll: input.syncAll, elements: input.elements.map(fromWhiteboardWireElement) }),
        sendCursor: (input) => whiteboard.sendCursor(input),
        requestSnapshot: () => whiteboard.requestSnapshot(),
        clear: () => whiteboard.clear(),
        initiateUpload: (input) => whiteboard.files.initiateUpload(input),
        finalizeUpload: (uploadId) => whiteboard.files.finalizeUpload(uploadId),
        presignDownload: async (fileId) => whiteboard.files.getDownloadUrl(fileId),
      },
    },
  };
}

function defaultDialogSettings(settings: PreJoinSettings, layout: ConferenceLayout): SettingsDialogValue {
  return {
    identity: { displayName: settings.displayName },
    join: { videoEnabled: settings.cameraEnabled, audioEnabled: settings.microphoneEnabled },
    audio: { selectedInput: undefined, selectedOutput: undefined, outputVolume: 100, noiseSuppression: false, echoCancellation: true, autoGainControl: true },
    video: { selectedInput: undefined, quality: "auto" },
    appearance: { layout, theme: "light", gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: false },
    experience: { captions: false, compactMode: false, showInviteToast: false, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
  };
}
