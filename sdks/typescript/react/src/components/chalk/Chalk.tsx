"use client";

import { createSpaceClient, type ChatUploadFile, type ClientEventMap, type GetAccess, type JoinOptions, type SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import { ChalkProvider } from "../../bindings/context";
import { useCan, useChat, useConnection, useMedia, useParticipants, useReactions, useSelf, useSpaceClient } from "../../bindings/hooks";
import { toActiveScreenShare, toAudioParticipants, toListParticipants, toParticipantNames, toVideoParticipants } from "../../selectors/space-selectors";
import { chalkThemeStyle, type ChalkColorScheme, type ChalkTheme } from "../../theme";
import { uploadChatAttachment } from "../composite/chat-file-upload";
import type { SettingsDialogValue } from "../composite/SettingsDialog";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import { SpaceView, type SpacePanel, type SpaceViewProps } from "../space-view/SpaceView";
import { Entrance } from "../entrance/Entrance";
import type { ThemeAppearance, ThemePalette, ThemeTexture } from "../theme";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";

export type SpaceLayout = "focus" | "grid" | "presentation";

export type ChalkFeatures = {
  readonly chat?: boolean;
  readonly participants?: boolean;
  readonly admission?: boolean;
  readonly screenShare?: boolean;
  readonly whiteboard?: boolean;
  readonly reactions?: boolean;
  readonly handRaise?: boolean;
  readonly info?: boolean;
  readonly settings?: boolean;
};

type SpaceIntegration =
  | {
      readonly client: SpaceClient;
      readonly space?: never;
      readonly getAccess?: never;
    }
  | {
      readonly client?: never;
      readonly space: string;
      readonly getAccess: GetAccess;
    };

type SpaceEventCallbacks = {
  readonly onJoined?: () => void;
  readonly onLeft?: () => void;
  readonly onEpisodeEnded?: (event: ClientEventMap["episodeEnded"]) => void;
  readonly onParticipantJoined?: (event: ClientEventMap["participantJoined"]) => void;
  readonly onParticipantLeft?: (event: ClientEventMap["participantLeft"]) => void;
  readonly onScreenShareStarted?: (event: ClientEventMap["screenShareStarted"]) => void;
  readonly onScreenShareStopped?: (event: ClientEventMap["screenShareStopped"]) => void;
  readonly onError?: (event: ClientEventMap["error"]) => void;
};

export type ChalkProps = SpaceIntegration &
  SpaceEventCallbacks & {
    readonly entrance?: boolean;
    readonly defaults?: {
      readonly microphone?: boolean;
      readonly camera?: boolean;
    };
    readonly displayName?: string;
    readonly features?: ChalkFeatures;
    readonly theme?: ChalkTheme;
    readonly initialPalette?: ThemePalette;
    readonly initialTexture?: ThemeTexture;
    readonly onAppearanceChange?: (appearance: ThemeAppearance) => void;
    readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
    readonly logoUrl?: string;
    readonly spaceName?: string;
    readonly inviteLink?: string;
    readonly layout?: SpaceLayout;
    readonly onLayoutChange?: (layout: SpaceLayout) => void;
  };

export function Chalk(props: ChalkProps): React.JSX.Element {
  const colorScheme = useResolvedColorScheme(props.theme?.colorScheme);
  const suppliedClient = props.client;
  const space = props.space;
  const getAccess = props.getAccess;
  const getAccessRef = useRef(getAccess);
  getAccessRef.current = getAccess;
  const getLatestAccess = useCallback<GetAccess>((context) => {
    const latestGetAccess = getAccessRef.current;
    if (!latestGetAccess) return Promise.reject(new Error("Chalk cannot refresh access after getAccess was removed."));
    return latestGetAccess(context);
  }, []);
  const ownedClient = useMemo(() => {
    if (suppliedClient) return null;
    if (!space || !getAccessRef.current) throw new Error("Chalk requires either client or both space and getAccess.");
    return createSpaceClient({ space, getAccess: getLatestAccess });
  }, [getLatestAccess, space, suppliedClient]);
  const client = suppliedClient ?? ownedClient!;

  useEffect(() => {
    if (ownedClient === null) return;
    return () => {
      void ownedClient
        .leave()
        .catch(() => undefined)
        .finally(() => ownedClient.dispose());
    };
  }, [ownedClient]);

  return (
    <div data-chalk data-chalk-theme={colorScheme} className="chalk-root h-full min-h-0 w-full" style={chalkThemeStyle(props.theme, colorScheme)}>
      <ChalkProvider client={client}>
        <SpaceExperience {...props} resolvedColorScheme={colorScheme} />
      </ChalkProvider>
    </div>
  );
}

function SpaceExperience(props: ChalkProps & { readonly resolvedColorScheme: Exclude<ChalkColorScheme, "system"> }): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const previousStatus = useRef(connection.status);
  const hasObservedStatus = useRef(false);
  const hasBeenLive = useRef(connection.status === "live" || connection.status === "reconnecting");
  const autoJoinAttempted = useRef(false);
  const previousClient = useRef(client);
  const [joinError, setJoinError] = useState<string | null>(null);
  const entrance = props.entrance ?? true;
  const spaceName = props.spaceName ?? props.space ?? "Space";

  if (previousClient.current !== client) {
    previousClient.current = client;
    previousStatus.current = connection.status;
    hasObservedStatus.current = false;
    hasBeenLive.current = connection.status === "live" || connection.status === "reconnecting";
    autoJoinAttempted.current = false;
  }

  useClientEvents(client, props);

  const join = useCallback(
    async (settings: JoinOptions) => {
      try {
        setJoinError(null);
        await client.join(settings);
      } catch (cause) {
        setJoinError(cause instanceof Error ? cause.message : "Could not enter this Space.");
      }
    },
    [client],
  );

  const retryAutomaticJoin = useCallback(() => {
    autoJoinAttempted.current = true;
    void join(defaultJoinOptions(props));
  }, [join, props]);

  useEffect(() => {
    setJoinError(null);
  }, [client]);

  useEffect(() => {
    if (entrance || connection.status !== "idle" || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void join(defaultJoinOptions(props));
  }, [connection.status, entrance, join, props.defaults?.camera, props.defaults?.microphone, props.displayName]);

  useEffect(() => {
    const previous = previousStatus.current;
    if (hasObservedStatus.current) {
      if (connection.status === "live" && previous !== "live" && previous !== "reconnecting") props.onJoined?.();
      if (connection.status === "left" && previous !== "left") props.onLeft?.();
    }
    previousStatus.current = connection.status;
    hasObservedStatus.current = true;
    if (connection.status === "live" || connection.status === "reconnecting") hasBeenLive.current = true;
  }, [connection.status, props.onJoined, props.onLeft]);

  if (connection.status === "idle") {
    if (!entrance) return <StatusView message={joinError ?? `Entering ${spaceName}…`} onRetry={joinError ? retryAutomaticJoin : undefined} />;
    return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={joinError ?? undefined} onJoin={join} />;
  }

  if (connection.status === "joining") {
    if (!entrance) return <StatusView message={`Entering ${spaceName}…`} />;
    return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} joining error={joinError ?? undefined} onJoin={join} />;
  }

  if (connection.status === "failed") {
    if (!hasBeenLive.current && entrance) {
      return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={connection.lastError?.message ?? joinError ?? "Unable to enter this Space."} onJoin={join} />;
    }
    return <StatusView message={connection.lastError?.message ?? joinError ?? "This Space is unavailable."} onRetry={() => void join(defaultJoinOptions(props))} />;
  }

  if (connection.status === "leaving") return <StatusView message={`Leaving ${spaceName}…`} />;

  if (connection.status === "left") {
    return <StatusView message="You have left this Space." onRetry={() => void join(defaultJoinOptions(props))} />;
  }

  return <SpaceSurface {...props} spaceName={spaceName} reconnecting={connection.status === "reconnecting"} />;
}

function SpaceSurface(props: ChalkProps & { readonly resolvedColorScheme: Exclude<ChalkColorScheme, "system">; readonly spaceName: string; readonly reconnecting: boolean }): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const participantSlice = useParticipants();
  const media = useMedia();
  const chat = useChat();
  const reactions = useReactions();
  const canPublishScreen = useCan("publishScreen");
  const canSendChat = useCan("sendChat");
  const canSendReaction = useCan("sendReaction");
  const canRaiseHand = useCan("raiseHand");
  const canMuteOthers = useCan("muteOthers");
  const canStopVideoOthers = useCan("stopVideoOthers");
  const canRequestMedia = useCan("requestMediaOthers");
  const canRemoveParticipants = useCan("removeParticipant");
  const canManageAdmission = useCan("manageAdmission");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canEndEpisode = useCan("endEpisode");
  const [layout, setLayout] = useState<SpaceLayout>(props.layout ?? "focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(null);
  const [commandError, setCommandError] = useState("");
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialPalette: ThemePalette = props.initialPalette ?? (props.resolvedColorScheme === "dark" ? "warm-charcoal" : "light");
  const initialTexture: ThemeTexture = props.initialTexture ?? "none";
  const [settings, setSettings] = useState<SettingsDialogValue>(() => createSettings(self.displayName ?? "", props.layout ?? "focus", initialPalette, initialTexture));
  const settingsRef = useRef<SettingsDialogValue | null>(null);
  const appearancePaletteExplicitRef = useRef(props.initialPalette !== undefined);
  if (props.initialPalette !== undefined) appearancePaletteExplicitRef.current = true;
  settingsRef.current = settings;

  useEffect(() => {
    if (props.initialPalette === undefined && props.initialTexture === undefined) return;
    setSettings((current) => {
      const nextPalette = props.initialPalette ?? current.appearance.palette ?? initialPalette;
      const nextTexture = props.initialTexture ?? current.appearance.texture ?? initialTexture;
      if (nextPalette === current.appearance.palette && nextTexture === current.appearance.texture) return current;
      const next: SettingsDialogValue = {
        ...current,
        appearance: {
          ...current.appearance,
          palette: nextPalette,
          texture: nextTexture,
          theme: nextPalette === "light" ? "light" : "dark",
        },
      };
      settingsRef.current = next;
      return next;
    });
  }, [initialPalette, initialTexture, props.initialPalette, props.initialTexture]);

  useEffect(() => {
    if (appearancePaletteExplicitRef.current) return;
    const nextPalette: ThemePalette = props.resolvedColorScheme === "dark" ? "warm-charcoal" : "light";
    setSettings((current) => {
      if (current.appearance.palette === nextPalette) return current;
      const next: SettingsDialogValue = {
        ...current,
        appearance: {
          ...current.appearance,
          palette: nextPalette,
          theme: nextPalette === "light" ? "light" : "dark",
        },
      };
      settingsRef.current = next;
      return next;
    });
  }, [props.resolvedColorScheme]);

  useEffect(() => {
    if (props.layout) setLayout(props.layout);
  }, [props.layout]);

  useEffect(() => {
    setSettings((current) => ({
      ...current,
      identity: { displayName: self.displayName ?? current.identity.displayName },
      join: {
        audioEnabled: media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting",
        videoEnabled: media.local.camera.state === "enabled" || media.local.camera.state === "requesting",
      },
      audio: {
        ...current.audio,
        selectedInput: media.selection.microphone ?? undefined,
        selectedOutput: media.selection.speaker ?? undefined,
      },
      video: { ...current.video, selectedInput: media.selection.camera ?? undefined },
    }));
  }, [media.local.camera.state, media.local.microphone.state, media.selection.camera, media.selection.microphone, media.selection.speaker, self.displayName]);

  useEffect(() => {
    if (feature("admission") && canManageAdmission && participantSlice.admissionQueue.length > 0) setActivePanel("admission");
  }, [canManageAdmission, participantSlice.admissionQueue.length, props.features?.admission]);

  const updateLayout = (nextLayout: SpaceLayout) => {
    if (!props.layout) setLayout(nextLayout);
    props.onLayoutChange?.(nextLayout);
  };
  const microphoneEnabled = media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting";
  const cameraEnabled = media.local.camera.state === "enabled" || media.local.camera.state === "requesting";
  const screenSharing = media.local.screen.state === "enabled" || media.local.screen.state === "requesting";
  const feature = (name: keyof ChalkFeatures): boolean => props.features?.[name] !== false;
  const canManageParticipants = canMuteOthers || canStopVideoOthers || canRemoveParticipants || canRequestMedia;
  const localId = self.participantId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participantSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantSlice.roster, self.displayName]);
  const activeScreenShare = useMemo(() => toActiveScreenShare(tiles), [tiles]);
  const effectiveLayout: SpaceLayout = activeScreenShare ? "presentation" : layout;
  const participantNames = useMemo(() => toParticipantNames(participantSlice.roster, localId, self.displayName ?? "You"), [localId, participantSlice.roster, self.displayName]);
  const listParticipants = useMemo(() => toListParticipants(tiles, Object.fromEntries(participantSlice.roster.map((participant) => [participant.participantId, participant.media]))), [participantSlice.roster, tiles]);
  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError("");
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "This command could not be completed.");
    }
  }, []);
  const activeScreenShareTrack = activeScreenShare?.screenShareTrack;
  const screenShare: SpaceViewProps["screenShare"] =
    activeScreenShare && activeScreenShareTrack
      ? {
          screenShareTrack: activeScreenShareTrack,
          sharedByName: activeScreenShare.displayName,
          onStopShare: () => void runCommand(() => (activeScreenShare.isLocal ? client.media.setScreenShareEnabled(false) : client.participants.stopScreenShare(activeScreenShare.id))),
        }
      : undefined;
  const incomingMediaRequest = media.incomingRequests[0];
  const controls = {
    buttons: [
      "mic",
      "video",
      ...(feature("screenShare") && canPublishScreen ? (["screenshare"] as const) : []),
      ...(feature("participants") ? (["participants"] as const) : []),
      ...(feature("chat") && canSendChat ? (["chat"] as const) : []),
      ...(feature("handRaise") && canRaiseHand ? (["handraise"] as const) : []),
      ...(feature("reactions") && canSendReaction ? (["reactions"] as const) : []),
      ...(feature("whiteboard") && canDrawWhiteboard ? (["whiteboard"] as const) : []),
      ...(feature("info") && props.inviteLink ? (["info"] as const) : []),
      ...(feature("settings") ? (["settings"] as const) : []),
      "leave",
    ],
    isMuted: !microphoneEnabled,
    isVideoEnabled: cameraEnabled,
    isScreenSharing: screenSharing,
    isChatOpen: activePanel === "chat",
    isParticipantsOpen: activePanel === "participants",
    isHandRaised: self.handRaised,
    unreadChatCount: chat.unreadCount,
    onToggleMute: () => void runCommand(() => client.media.setMicrophoneEnabled(!microphoneEnabled)),
    onToggleVideo: () => void runCommand(() => client.media.setCameraEnabled(!cameraEnabled)),
    onToggleScreenShare: () => void runCommand(() => client.media.setScreenShareEnabled(!screenSharing)),
    onToggleChat: () => setActivePanel((current) => (current === "chat" ? null : "chat")),
    onToggleParticipants: () => setActivePanel((current) => (current === "participants" ? null : "participants")),
    onToggleHandRaise: () => void runCommand(() => (self.handRaised ? client.participants.lowerHand() : client.participants.raiseHand())),
    onToggleWhiteboard: () => setWhiteboardOpen((current) => !current),
    onOpenInfo: () => setInfoOpen(true),
    onOpenSettings: () => setSettingsOpen(true),
  } satisfies NonNullable<SpaceViewProps["controls"]>;
  const panels: SpaceViewProps["panels"] = {
    active: activePanel,
    onChange: setActivePanel,
    chat:
      feature("chat") && canSendChat
        ? {
            messages: chat.messages,
            pendingMessages: chat.pendingSends,
            readReceipts: chat.readReceipts,
            participantNames,
            localParticipantId: localId,
            hasOlder: chat.pagination.hasOlder,
            onSendMessage: (input) => client.chat.send(input).then(() => undefined),
            onUploadAttachment: (file) => uploadChatAttachment(file, client.chat.files),
            pickChatFiles: props.pickChatFiles,
            onResolveAttachmentUrl: async (attachmentId) => {
              const attachment = [...chat.messages, ...chat.pendingSends].flatMap((message) => message.attachments).find((candidate) => candidate.attachmentId === attachmentId);
              if (!attachment) throw new Error("The chat attachment is no longer available.");
              return client.chat.files.url(attachment);
            },
            onMarkRead: (sequence) => {
              const message = chat.messages.find((candidate) => candidate.sequence === sequence);
              return message ? client.chat.markRead(message.messageId) : undefined;
            },
            onLoadOlder: () => client.chat.loadOlder().then(() => undefined),
          }
        : undefined,
    participants: feature("participants")
      ? {
          participants: listParticipants,
          canManageParticipants,
          onMuteParticipant: canMuteOthers ? (participantId) => void runCommand(() => client.participants.mute(participantId)) : undefined,
          onRequestUnmute: canRequestMedia ? (participantId) => void runCommand(() => client.participants.requestMedia(participantId, "microphone")) : undefined,
          onStopParticipantCamera: canStopVideoOthers ? (participantId) => void runCommand(() => client.participants.stopVideo(participantId)) : undefined,
          onRequestStartCamera: canRequestMedia ? (participantId) => void runCommand(() => client.participants.requestMedia(participantId, "camera")) : undefined,
          onRemoveParticipant: canRemoveParticipants ? (participantId) => void runCommand(() => client.participants.remove(participantId)) : undefined,
        }
      : undefined,
    admission:
      feature("admission") && canManageAdmission
        ? {
            participants: participantSlice.admissionQueue.map((participant) => ({ id: participant.requestId, displayName: participant.displayName })),
            onAdmit: (requestId) => void runCommand(() => client.participants.admit(requestId)),
            onDeny: (requestId) => void runCommand(() => client.participants.deny(requestId)),
          }
        : undefined,
  };
  const whiteboardTransport = client.whiteboard.transport();
  const whiteboard: SpaceViewProps["whiteboard"] =
    feature("whiteboard") && whiteboardOpen && canDrawWhiteboard && whiteboardTransport
      ? {
          isOpen: true,
          props: {
            canDraw: canDrawWhiteboard,
            collab: {
              canDraw: canDrawWhiteboard,
              subscribe: (listener) => whiteboardTransport.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
              submitUpdate: async (input) => whiteboardTransport.submitUpdate({ sceneId: input.sceneId, syncAll: input.syncAll, elements: input.elements.map(fromWhiteboardWireElement) }),
              sendCursor: (input) => whiteboardTransport.sendCursor(input),
              requestSnapshot: () => whiteboardTransport.requestSnapshot(),
              clear: () => whiteboardTransport.clear(),
              initiateUpload: (input) => whiteboardTransport.files.initiateUpload(input),
              finalizeUpload: (uploadId) => whiteboardTransport.files.finalizeUpload(uploadId),
              presignDownload: (fileId) => whiteboardTransport.files.getDownloadUrl(fileId),
            },
          },
        }
      : undefined;

  return (
    <SpaceView
      spaceName={props.spaceName}
      displayName={self.displayName ?? "You"}
      logoUrl={props.logoUrl}
      inviteLink={props.inviteLink}
      palette={settings.appearance.palette ?? initialPalette}
      texture={settings.appearance.texture ?? "none"}
      layout={effectiveLayout}
      onLayoutChange={updateLayout}
      participants={tiles}
      audioParticipants={toAudioParticipants(media.remote)}
      screenShare={screenShare}
      controls={controls}
      panels={panels}
      whiteboard={whiteboard}
      infoDialog={feature("info") && props.inviteLink ? { isOpen: infoOpen, onOpenChange: setInfoOpen, spaceName: props.spaceName, inviteLink: props.inviteLink, onCopyLink: () => void navigator.clipboard?.writeText(props.inviteLink!) } : undefined}
      settingsDialog={
        feature("settings")
          ? {
              isOpen: settingsOpen,
              onOpenChange: setSettingsOpen,
              settings,
              onUpdateIdentity: (updates) => {
                setSettings((current) => ({ ...current, identity: { ...current.identity, ...updates } }));
                const displayName = updates.displayName?.trim();
                if (displayName) void runCommand(() => client.participants.renameSelf(displayName));
              },
              onUpdateJoin: (updates) => {
                setSettings((current) => ({ ...current, join: { ...current.join, ...updates } }));
                const { audioEnabled, videoEnabled } = updates;
                if (audioEnabled !== undefined) void runCommand(() => client.media.setMicrophoneEnabled(audioEnabled));
                if (videoEnabled !== undefined) void runCommand(() => client.media.setCameraEnabled(videoEnabled));
              },
              onUpdateAudio: (updates) => {
                setSettings((current) => ({ ...current, audio: { ...current.audio, ...updates } }));
                const { selectedInput, selectedOutput } = updates;
                if (selectedInput) void runCommand(() => client.media.selectMicrophone(selectedInput));
                if (selectedOutput) void runCommand(() => client.media.selectSpeaker(selectedOutput));
              },
              onUpdateVideo: (updates) => {
                setSettings((current) => ({ ...current, video: { ...current.video, ...updates } }));
                const { selectedInput } = updates;
                if (selectedInput) void runCommand(() => client.media.selectCamera(selectedInput));
              },
              onUpdateAppearance: (updates) => {
                const current = settingsRef.current ?? settings;
                const next = { ...current, appearance: { ...current.appearance, ...updates } };
                if (updates.palette !== undefined) appearancePaletteExplicitRef.current = true;
                settingsRef.current = next;
                setSettings(next);
                if (updates.palette !== undefined || updates.texture !== undefined) {
                  props.onAppearanceChange?.({ palette: next.appearance.palette ?? initialPalette, texture: next.appearance.texture ?? initialTexture });
                }
                if (updates.layout === "focus" || updates.layout === "grid" || updates.layout === "presentation") updateLayout(updates.layout);
              },
              onUpdateExperience: (updates) => setSettings((current) => ({ ...current, experience: { ...current.experience, ...updates } })),
              audioInputDevices: media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" as const })),
              audioOutputDevices: media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" as const })),
              videoInputDevices: media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" as const })),
              videoTrack: media.local.camera.track,
              participantColorSeed: self.displayName ?? undefined,
            }
          : undefined
      }
      reactions={feature("reactions") && canSendReaction ? { reactions: reactions.active, onSelect: (reaction) => runCommand(() => client.reactions.send(reaction)) } : undefined}
      reconnecting={props.reconnecting ? { isVisible: true, status: "reconnecting", onLeft: () => void runCommand(() => client.leave()) } : undefined}
      onLeft={() => void runCommand(() => client.leave())}
      onEndEpisode={canEndEpisode ? () => void runCommand(() => client.endEpisode()) : undefined}
      overlay={
        <>
          {incomingMediaRequest ? <MediaRequestDialog request={incomingMediaRequest} onDecline={() => void runCommand(() => client.media.declineRequest(incomingMediaRequest.requestId))} onAllow={() => void runCommand(() => client.media.acceptRequest(incomingMediaRequest.requestId))} /> : null}
          {commandError ? (
            <p role="alert" className="absolute right-4 bottom-24 z-50 rounded bg-[var(--chalk-app-danger)]/10 p-3 text-sm text-[var(--chalk-app-danger)]">
              {commandError}
            </p>
          ) : null}
        </>
      }
    />
  );
}

function StatusView({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }): React.JSX.Element {
  return (
    <main className="grid h-full min-h-0 place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <div className="grid max-w-sm gap-4 justify-items-center">
        <p role="status" className="text-sm text-[var(--chalk-muted-text)]">
          {message}
        </p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="rounded-md bg-[var(--chalk-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--chalk-accent-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]">
            Try again
          </button>
        ) : null}
      </div>
    </main>
  );
}

function defaultJoinOptions(props: ChalkProps): JoinOptions {
  const displayName = props.displayName?.trim();
  return {
    ...(displayName ? { displayName } : {}),
    microphone: props.defaults?.microphone ?? true,
    camera: props.defaults?.camera ?? true,
  };
}

function useResolvedColorScheme(requested: ChalkColorScheme = "light"): Exclude<ChalkColorScheme, "system"> {
  const [resolved, setResolved] = useState<Exclude<ChalkColorScheme, "system">>(() => (requested === "system" ? readSystemColorScheme() : requested));

  useEffect(() => {
    if (requested !== "system") {
      setResolved(requested);
      return;
    }

    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setResolved("light");
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setResolved(mediaQuery.matches ? "dark" : "light");
    update();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener?.("change", update);
    }
    if (typeof mediaQuery.addListener !== "function") return;
    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener?.(update);
  }, [requested]);

  return requested === "system" ? resolved : requested;
}

function readSystemColorScheme(): Exclude<ChalkColorScheme, "system"> {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function useClientEvents(client: SpaceClient, callbacks: SpaceEventCallbacks): void {
  useEffect(() => client.on("participantJoined", (event) => callbacks.onParticipantJoined?.(event)), [callbacks.onParticipantJoined, client]);
  useEffect(() => client.on("participantLeft", (event) => callbacks.onParticipantLeft?.(event)), [callbacks.onParticipantLeft, client]);
  useEffect(() => client.on("episodeEnded", (event) => callbacks.onEpisodeEnded?.(event)), [callbacks.onEpisodeEnded, client]);
  useEffect(() => client.on("screenShareStarted", (event) => callbacks.onScreenShareStarted?.(event)), [callbacks.onScreenShareStarted, client]);
  useEffect(() => client.on("screenShareStopped", (event) => callbacks.onScreenShareStopped?.(event)), [callbacks.onScreenShareStopped, client]);
  useEffect(() => client.on("error", (event) => callbacks.onError?.(event)), [callbacks.onError, client]);
}

function createSettings(displayName: string, layout: SpaceLayout, palette: ThemePalette = "light", texture: ThemeTexture = "none"): SettingsDialogValue {
  return {
    identity: { displayName },
    join: { videoEnabled: true, audioEnabled: true },
    audio: { outputVolume: 100, noiseSuppression: false, echoCancellation: true, autoGainControl: true },
    video: { quality: "auto" },
    appearance: { layout, theme: palette === "light" ? "light" : "dark", palette, texture, gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: true },
    experience: { captions: false, compactMode: false, showInviteToast: true, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
  };
}
