"use client";

import { createSpaceClient, type ChalkWhiteboardV1Transport, type ChatUploadFile, type ClientEventMap, type FeedbackSource, type GetAccess, type JoinOptions, type SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import { ChalkProvider } from "../../bindings/context";
import { useCan, useConnection, useMedia, useParticipants, useSelf, useSpaceClient, useWhiteboard } from "../../bindings/hooks";
import { chalkThemeStyle, type ChalkColorScheme, type ChalkTheme } from "../../theme";
import { useWhiteboardSceneSubscription } from "../../internal/useWhiteboardSceneSubscription";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import { SettingsDialog, type SettingsDialogValue } from "../composite/SettingsDialog";
import { Entrance } from "../entrance/Entrance";
import { SpaceView } from "../space-view/SpaceView";
import { SkinProvider } from "../skin-context";
import { getThemeMode, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../theme";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { FeedbackDialog } from "../feedback/FeedbackDialog";
import { StatusSurface } from "./StatusSurface";

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
  /** Join / leave / message / hand-raise / reaction cues. The user can still mute them from Settings. */
  readonly sounds?: boolean;
};

type SpaceIntegration = { readonly client: SpaceClient; readonly space?: never; readonly getAccess?: never } | { readonly client?: never; readonly space: string; readonly getAccess: GetAccess };

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
    readonly defaults?: { readonly microphone?: boolean; readonly camera?: boolean };
    readonly displayName?: string;
    readonly features?: ChalkFeatures;
    readonly theme?: ChalkTheme;
    readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
    readonly logoUrl?: string;
    readonly spaceName?: string;
    readonly inviteLink?: string;
    readonly spaceDescription?: string;
    readonly diagnosticReference?: string;
    readonly onSendFeedback?: (context: Readonly<{ diagnosticReference: string }>) => void;
    readonly layout?: SpaceLayout;
    readonly onLayoutChange?: (layout: SpaceLayout) => void;
    readonly onOpenDiagnostics?: () => void;
    readonly feedbackSource?: FeedbackSource;
  };

export function Chalk(props: ChalkProps): React.JSX.Element {
  const colorScheme = useResolvedColorScheme(props.theme?.palette ? getThemeMode(props.theme.palette) : props.theme?.colorScheme);
  const skin = props.theme?.skin ?? "classic";
  const suppliedClient = props.client;
  const getAccessRef = useRef(props.getAccess);
  getAccessRef.current = props.getAccess;
  const getLatestAccess = useCallback<GetAccess>((context) => {
    const latestGetAccess = getAccessRef.current;
    if (!latestGetAccess) return Promise.reject(new Error("Chalk cannot refresh access after getAccess was removed."));
    return latestGetAccess(context);
  }, []);
  const ownedClient = useMemo(() => {
    if (suppliedClient) return null;
    if (!props.space || !getAccessRef.current) throw new Error("Chalk requires either client or both space and getAccess.");
    return createSpaceClient({ space: props.space, getAccess: getLatestAccess });
  }, [getLatestAccess, props.space, suppliedClient]);
  const client = suppliedClient ?? ownedClient!;
  const feedbackRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ownedClient) return;
    return () => {
      void ownedClient
        .leave()
        .catch(() => undefined)
        .finally(() => ownedClient.dispose());
    };
  }, [ownedClient]);

  return (
    <SkinProvider skin={skin}>
      <div
        ref={feedbackRootRef}
        data-chalk
        data-chalk-feedback-root
        data-chalk-theme={colorScheme}
        data-chalk-palette={props.theme?.palette}
        data-chalk-texture={props.theme?.texture}
        data-chalk-skin={skin}
        className="chalk-root h-full min-h-0 w-full"
        style={chalkThemeStyle(props.theme, colorScheme)}
      >
        <ChalkProvider client={client}>
          <SpaceExperience {...props} feedbackRootRef={feedbackRootRef} resolvedColorScheme={colorScheme} />
        </ChalkProvider>
      </div>
    </SkinProvider>
  );
}

function SpaceExperience(props: ChalkProps & { readonly feedbackRootRef: React.RefObject<HTMLElement | null>; readonly resolvedColorScheme: Exclude<ChalkColorScheme, "system"> }): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
  const participants = useParticipants();
  const previousStatus = useRef(connection.status);
  const hasObservedStatus = useRef(false);
  const hasBeenLive = useRef(connection.status === "live" || connection.status === "reconnecting");
  const autoJoinAttempted = useRef(false);
  const previousClient = useRef(client);
  const [joinError, setJoinError] = useState<string | null>(null);
  const lastEpisode = useRef(connection.episode);
  const lastParticipantCount = useRef(participants.roster.length);
  const [retryPending, setRetryPending] = useState(false);
  const [episodeEnded, setEpisodeEnded] = useState(false);
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const entrance = props.entrance ?? true;
  const spaceName = props.spaceName ?? props.space ?? "Space";

  if (connection.episode) lastEpisode.current = connection.episode;
  if (participants.roster.length > 0) lastParticipantCount.current = participants.roster.length;

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
    setRetryPending(true);
    void join(defaultJoinOptions(props)).finally(() => setRetryPending(false));
  }, [join, props]);

  useEffect(() => setJoinError(null), [client]);
  useEffect(() => {
    setEpisodeEnded(false);
    setEndedAt(null);
  }, [client]);
  useEffect(
    () =>
      client.on("episodeEnded", () => {
        setEpisodeEnded(true);
        setEndedAt(new Date().toISOString());
      }),
    [client],
  );
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
    if (connection.status === "left" && previous !== "left") setEndedAt((current) => current ?? new Date().toISOString());
  }, [connection.status, props.onJoined, props.onLeft]);

  if (connection.status === "idle") {
    if (!entrance) return <StatusSurface message={joinError ?? `Entering ${spaceName}…`} onRetry={joinError ? retryAutomaticJoin : undefined} retryPending={retryPending} retryError={joinError} />;
    return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={joinError ?? undefined} theme={props.theme} onJoin={join} />;
  }
  if (connection.status === "joining")
    return entrance ? <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} joining error={joinError ?? undefined} theme={props.theme} onJoin={join} /> : <StatusSurface message={`Entering ${spaceName}…`} />;
  if (connection.status === "failed") {
    if (!hasBeenLive.current && entrance) return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={connection.lastError?.message ?? joinError ?? "Unable to enter this Space."} theme={props.theme} onJoin={join} />;
    return <StatusSurface phase="failed" message={connection.lastError?.message ?? joinError ?? "This Space is unavailable."} onRetry={retryAutomaticJoin} retryPending={retryPending} retryError={joinError} />;
  }
  if (connection.status === "leaving") return <StatusSurface phase="leaving" message={`Leaving ${spaceName}…`} spaceName={spaceName} />;
  if (connection.status === "left")
    return (
      <StatusSurface
        phase={episodeEnded ? "episode-ended" : "left"}
        message={episodeEnded ? "This Episode has ended for everyone." : "Your connection is closed. You can re-enter from here."}
        spaceName={spaceName}
        episode={lastEpisode.current}
        endedAt={endedAt}
        participantCount={lastParticipantCount.current}
        onRetry={episodeEnded ? undefined : retryAutomaticJoin}
        retryPending={retryPending}
        retryError={joinError}
      />
    );
  return <SpaceSurface {...props} spaceName={spaceName} reconnecting={connection.status === "reconnecting"} />;
}

function SpaceSurface(props: ChalkProps & { readonly feedbackRootRef: React.RefObject<HTMLElement | null>; readonly resolvedColorScheme: Exclude<ChalkColorScheme, "system">; readonly spaceName: string; readonly reconnecting: boolean }): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const media = useMedia();
  const whiteboardState = useWhiteboard();
  const canEndEpisode = useCan("endEpisode");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"appearance" | undefined>();
  const [infoOpen, setInfoOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsDialogValue>(() => createSettings(self.displayName ?? "", props.layout ?? "focus", props.theme?.skin ?? "classic", props.theme?.palette ?? (props.resolvedColorScheme === "dark" ? "warm-charcoal" : "light"), props.theme?.texture ?? "none"));
  const resolvedSkin: ThemeSkin = props.theme?.skin ?? "classic";
  const resolvedPalette: ThemePalette = props.theme?.palette ?? (props.resolvedColorScheme === "dark" ? "warm-charcoal" : "light");
  const resolvedTexture: ThemeTexture = props.theme?.texture ?? "none";
  const appearancePaletteExplicitRef = useRef(props.theme?.palette !== undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    setSettings((current) => ({
      ...current,
      identity: { displayName: self.displayName ?? current.identity.displayName },
      join: { audioEnabled: media.local.microphone.state === "enabled" || media.local.microphone.state === "requesting", videoEnabled: media.local.camera.state === "enabled" || media.local.camera.state === "requesting" },
      audio: { ...current.audio, selectedInput: media.selection.microphone ?? undefined, selectedOutput: media.selection.speaker ?? undefined },
      video: { ...current.video, selectedInput: media.selection.camera ?? undefined },
    }));
  }, [media.local.camera.state, media.local.microphone.state, media.selection.camera, media.selection.microphone, media.selection.speaker, self.displayName]);
  useEffect(() => {
    if (!props.theme?.skin && !props.theme?.palette && !props.theme?.texture) return;
    setSettings((current) => ({
      ...current,
      appearance: {
        ...current.appearance,
        skin: props.theme?.skin ?? current.appearance.skin,
        palette: props.theme?.palette ?? current.appearance.palette,
        texture: props.theme?.texture ?? current.appearance.texture,
        theme: (props.theme?.palette ?? current.appearance.palette) === "light" ? "light" : "dark",
      },
    }));
  }, [props.theme?.palette, props.theme?.skin, props.theme?.texture]);
  useEffect(() => {
    if (props.theme?.palette || appearancePaletteExplicitRef.current) return;
    const palette: ThemePalette = props.resolvedColorScheme === "dark" ? "warm-charcoal" : "light";
    setSettings((current) => (current.appearance.palette === palette ? current : { ...current, appearance: { ...current.appearance, palette, theme: palette === "light" ? "light" : "dark" } }));
  }, [props.resolvedColorScheme, props.theme?.palette, props.theme?.texture]);

  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError(null);
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "This command could not be completed.");
    }
  }, []);
  const whiteboardTransport = client.whiteboard.transport();
  const whiteboardAvailable = props.features?.whiteboard !== false;
  const whiteboardSubscription = useWhiteboardSceneSubscription(whiteboardTransport, whiteboardAvailable);
  const setWhiteboardPresentation = whiteboardSubscription.status === "ready" ? bindWhiteboardPresentation(whiteboardSubscription.transport) : undefined;
  useEffect(() => {
    if (whiteboardSubscription.status === "failed") setCommandError(whiteboardSubscription.error.message);
    else if (whiteboardSubscription.status === "loading" || whiteboardSubscription.status === "ready") setCommandError(null);
  }, [whiteboardSubscription]);
  const whiteboard =
    whiteboardAvailable && whiteboardState.engine.presenting && whiteboardSubscription.status === "ready"
      ? {
          isOpen: true,
          props: {
            canDraw: canDrawWhiteboard,
            collab: {
              canDraw: canDrawWhiteboard,
              subscribe: (listener: NonNullable<WhiteboardViewProps["collab"]>["subscribe"] extends (listener: infer T) => unknown ? T : never) => whiteboardSubscription.transport.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
              submitUpdate: async (input: NonNullable<WhiteboardViewProps["collab"]>["submitUpdate"] extends (input: infer T) => unknown ? T : never) =>
                whiteboardSubscription.transport.submitUpdate({ sceneId: input.sceneId, syncAll: input.syncAll, elements: input.elements.map(fromWhiteboardWireElement) }),
              sendCursor: (input: NonNullable<WhiteboardViewProps["collab"]>["sendCursor"] extends (input: infer T) => unknown ? T : never) => whiteboardSubscription.transport.sendCursor(input),
              requestSnapshot: () => whiteboardSubscription.transport.requestSnapshot(),
              onSubmissionError: (cause: unknown) => setCommandError(cause instanceof Error ? cause.message : "Whiteboard could not sync."),
              clear: () => whiteboardSubscription.transport.clear(),
              initiateUpload: (input: { readonly fileId: string; readonly mimeType: string; readonly byteLength: number; readonly sha256: string }) => whiteboardSubscription.transport.files.initiateUpload(input),
              finalizeUpload: (uploadId: string) => whiteboardSubscription.transport.files.finalizeUpload(uploadId),
              presignDownload: (fileId: string) => whiteboardSubscription.transport.files.getDownloadUrl(fileId),
            },
          },
        }
      : undefined;

  return (
    <SpaceView
      spaceName={props.spaceName}
      logoUrl={props.logoUrl}
      inviteLink={props.inviteLink}
      pickChatFiles={props.pickChatFiles}
      skin={settings.appearance.skin ?? resolvedSkin}
      palette={settings.appearance.palette ?? resolvedPalette}
      texture={settings.appearance.texture ?? resolvedTexture}
      generatedAvatars={settings.appearance.generatedAvatars}
      commandError={commandError ?? undefined}
      onDismissCommandError={() => setCommandError(null)}
      layout={settings.appearance.layout === "focus" || settings.appearance.layout === "grid" || settings.appearance.layout === "presentation" ? settings.appearance.layout : (props.layout ?? "focus")}
      onLayoutChange={(nextLayout) => {
        setSettings((current) => ({ ...current, appearance: { ...current.appearance, layout: nextLayout } }));
        props.onLayoutChange?.(nextLayout);
      }}
      features={{ ...props.features, sounds: props.features?.sounds !== false && settings.experience.sounds }}
      onOpenDiagnostics={props.onOpenDiagnostics}
      onOpenFeedback={() => setFeedbackOpen(true)}
      whiteboard={whiteboard}
      onToggleWhiteboard={canDrawWhiteboard && setWhiteboardPresentation ? () => void runCommand(() => setWhiteboardPresentation(!whiteboardState.engine.presenting)) : undefined}
      infoDialog={
        props.features?.info !== false && (props.inviteLink || props.diagnosticReference || props.spaceDescription)
          ? {
              isOpen: infoOpen,
              onOpenChange: setInfoOpen,
              spaceName: props.spaceName,
              spaceDescription: props.spaceDescription,
              inviteLink: props.inviteLink,
              onCopyLink: props.inviteLink ? () => void navigator.clipboard?.writeText(props.inviteLink!) : undefined,
              diagnosticReference: props.diagnosticReference,
              onCopyDiagnosticReference: (reference) => void navigator.clipboard?.writeText(reference),
              onSendFeedback: props.onSendFeedback,
            }
          : undefined
      }
      onOpenSettings={
        props.features?.settings !== false
          ? () => {
              setSettingsInitialSection(undefined);
              setSettingsOpen(true);
            }
          : undefined
      }
      settingsDialog={
        props.features?.settings !== false ? (
          <SettingsDialog
            isOpen={settingsOpen}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsInitialSection(undefined);
            }}
            initialSection={settingsInitialSection}
            settings={settings}
            onUpdateIdentity={(updates) => {
              setSettings((current) => ({ ...current, identity: { ...current.identity, ...updates } }));
              const nextDisplayName = updates.displayName?.trim();
              if (nextDisplayName) void runCommand(() => client.participants.renameSelf(nextDisplayName));
            }}
            onUpdateJoin={(updates) => {
              setSettings((current) => ({ ...current, join: { ...current.join, ...updates } }));
              if (updates.audioEnabled !== undefined) runCommand(() => client.media.setMicrophoneEnabled(updates.audioEnabled!));
              if (updates.videoEnabled !== undefined) runCommand(() => client.media.setCameraEnabled(updates.videoEnabled!));
            }}
            onUpdateAudio={(updates) => {
              setSettings((current) => ({ ...current, audio: { ...current.audio, ...updates } }));
              if (updates.selectedInput) runCommand(() => client.media.selectMicrophone(updates.selectedInput!));
              if (updates.selectedOutput) runCommand(() => client.media.selectSpeaker(updates.selectedOutput!));
            }}
            onUpdateVideo={(updates) => {
              setSettings((current) => ({ ...current, video: { ...current.video, ...updates } }));
              if (updates.selectedInput) runCommand(() => client.media.selectCamera(updates.selectedInput!));
            }}
            onUpdateAppearance={(updates) => {
              if (updates.palette !== undefined) appearancePaletteExplicitRef.current = true;
              const current = settingsRef.current;
              if (updates.skin !== undefined && updates.skin !== current.appearance.skin) setSettingsInitialSection("appearance");
              const next = { ...current, appearance: { ...current.appearance, ...updates } };
              settingsRef.current = next;
              setSettings(next);
              if (updates.layout === "focus" || updates.layout === "grid" || updates.layout === "presentation") props.onLayoutChange?.(updates.layout);
            }}
            onUpdateExperience={(updates) => setSettings((current) => ({ ...current, experience: { ...current.experience, ...updates } }))}
            audioInputDevices={media.devices.microphones.map((device) => ({ ...device, kind: "audioinput" as const }))}
            audioOutputDevices={media.devices.speakers.map((device) => ({ ...device, kind: "audiooutput" as const }))}
            videoInputDevices={media.devices.cameras.map((device) => ({ ...device, kind: "videoinput" as const }))}
            videoTrack={media.local.camera.track}
            participantColorSeed={self.displayName ?? undefined}
          />
        ) : undefined
      }
      reconnecting={props.reconnecting ? { isVisible: true, status: "reconnecting", onLeft: () => runCommand(() => client.leave()) } : undefined}
      onLeft={() => runCommand(() => client.leave())}
      onEndEpisode={canEndEpisode ? () => runCommand(() => client.endEpisode()) : undefined}
      overlay={
        <>
          {media.incomingRequests[0] ? (
            <MediaRequestDialog request={media.incomingRequests[0]} onDecline={() => void runCommand(() => client.media.declineRequest(media.incomingRequests[0]!.requestId))} onAllow={() => void runCommand(() => client.media.acceptRequest(media.incomingRequests[0]!.requestId))} />
          ) : null}
          <FeedbackDialog isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} client={client} source={props.feedbackSource} captureRootRef={props.feedbackRootRef} />
        </>
      }
    />
  );
}

function bindWhiteboardPresentation(transport: ChalkWhiteboardV1Transport): ((presenting: boolean) => Promise<void>) | undefined {
  const setPresentation = transport.setPresentation;
  if (!setPresentation) return undefined;
  return (presenting) => setPresentation.call(transport, presenting);
}

function defaultJoinOptions(props: ChalkProps): JoinOptions {
  const displayName = props.displayName?.trim();
  return { ...(displayName ? { displayName } : {}), microphone: props.defaults?.microphone ?? true, camera: props.defaults?.camera ?? true };
}

function useResolvedColorScheme(requested: ChalkColorScheme = "light"): Exclude<ChalkColorScheme, "system"> {
  const [resolved, setResolved] = useState<Exclude<ChalkColorScheme, "system">>(() => (requested === "system" ? readSystemColorScheme() : requested));
  useEffect(() => {
    if (requested !== "system") return void setResolved(requested);
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return void setResolved("light");
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setResolved(mediaQuery.matches ? "dark" : "light");
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, [requested]);
  return requested === "system" ? resolved : requested;
}

function readSystemColorScheme(): Exclude<ChalkColorScheme, "system"> {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useClientEvents(client: SpaceClient, callbacks: SpaceEventCallbacks): void {
  useEffect(() => client.on("participantJoined", (event) => callbacks.onParticipantJoined?.(event)), [callbacks.onParticipantJoined, client]);
  useEffect(() => client.on("participantLeft", (event) => callbacks.onParticipantLeft?.(event)), [callbacks.onParticipantLeft, client]);
  useEffect(() => client.on("episodeEnded", (event) => callbacks.onEpisodeEnded?.(event)), [callbacks.onEpisodeEnded, client]);
  useEffect(() => client.on("screenShareStarted", (event) => callbacks.onScreenShareStarted?.(event)), [callbacks.onScreenShareStarted, client]);
  useEffect(() => client.on("screenShareStopped", (event) => callbacks.onScreenShareStopped?.(event)), [callbacks.onScreenShareStopped, client]);
  useEffect(() => client.on("error", (event) => callbacks.onError?.(event)), [callbacks.onError, client]);
}

function createSettings(displayName: string, layout: SpaceLayout, skin: ThemeSkin, palette: ThemePalette, texture: ThemeTexture): SettingsDialogValue {
  return {
    identity: { displayName },
    join: { videoEnabled: true, audioEnabled: true },
    audio: { outputVolume: 100, noiseSuppression: false, echoCancellation: true, autoGainControl: true },
    video: { quality: "auto" },
    appearance: { layout, theme: palette === "light" ? "light" : "dark", skin, palette, texture, gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: true },
    experience: { captions: false, compactMode: false, showInviteToast: true, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false, sounds: true },
  };
}
