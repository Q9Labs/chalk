"use client";

import { createSpaceClient, type ChatUploadFile, type ClientEventMap, type GetAccess, type JoinOptions, type SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import { ChalkProvider } from "../../bindings/context";
import { useCan, useConnection, useMedia, useSelf, useSpaceClient } from "../../bindings/hooks";
import { chalkThemeStyle, type ChalkColorScheme, type ChalkTheme } from "../../theme";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";
import { SettingsDialog, type SettingsDialogValue } from "../composite/SettingsDialog";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { Entrance } from "../entrance/Entrance";
import { SpaceView } from "../space-view/SpaceView";
import { SkinProvider, useSkin } from "../skin-context";
import { getThemeMode, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../theme";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { ChalkButton } from "../chalk-ui";

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
    readonly layout?: SpaceLayout;
    readonly onLayoutChange?: (layout: SpaceLayout) => void;
    readonly onOpenDiagnostics?: () => void;
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
      <div data-chalk data-chalk-theme={colorScheme} data-chalk-palette={props.theme?.palette} data-chalk-texture={props.theme?.texture} data-chalk-skin={skin} className="chalk-root h-full min-h-0 w-full" style={chalkThemeStyle(props.theme, colorScheme)}>
        <ChalkProvider client={client}>
          <SpaceExperience {...props} resolvedColorScheme={colorScheme} />
        </ChalkProvider>
      </div>
    </SkinProvider>
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

  useEffect(() => setJoinError(null), [client]);
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
    return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={joinError ?? undefined} theme={props.theme} onJoin={join} />;
  }
  if (connection.status === "joining")
    return entrance ? <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} joining error={joinError ?? undefined} theme={props.theme} onJoin={join} /> : <StatusView message={`Entering ${spaceName}…`} />;
  if (connection.status === "failed") {
    if (!hasBeenLive.current && entrance) return <Entrance spaceName={spaceName} logoUrl={props.logoUrl} defaultDisplayName={props.displayName} defaults={props.defaults} error={connection.lastError?.message ?? joinError ?? "Unable to enter this Space."} theme={props.theme} onJoin={join} />;
    return <StatusView message={connection.lastError?.message ?? joinError ?? "This Space is unavailable."} onRetry={() => void join(defaultJoinOptions(props))} />;
  }
  if (connection.status === "leaving") return <StatusView message={`Leaving ${spaceName}…`} />;
  if (connection.status === "left") return <StatusView message="You have left this Space." onRetry={() => void join(defaultJoinOptions(props))} />;
  return <SpaceSurface {...props} spaceName={spaceName} reconnecting={connection.status === "reconnecting"} />;
}

function SpaceSurface(props: ChalkProps & { readonly resolvedColorScheme: Exclude<ChalkColorScheme, "system">; readonly spaceName: string; readonly reconnecting: boolean }): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const media = useMedia();
  const canEndEpisode = useCan("endEpisode");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"appearance" | undefined>();
  const [infoOpen, setInfoOpen] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
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
  const whiteboard =
    props.features?.whiteboard !== false && whiteboardOpen && canDrawWhiteboard && whiteboardTransport
      ? {
          isOpen: true,
          props: {
            canDraw: canDrawWhiteboard,
            collab: {
              canDraw: canDrawWhiteboard,
              subscribe: (listener: NonNullable<WhiteboardViewProps["collab"]>["subscribe"] extends (listener: infer T) => unknown ? T : never) => whiteboardTransport.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
              submitUpdate: async (input: NonNullable<WhiteboardViewProps["collab"]>["submitUpdate"] extends (input: infer T) => unknown ? T : never) => whiteboardTransport.submitUpdate({ sceneId: input.sceneId, syncAll: input.syncAll, elements: input.elements.map(fromWhiteboardWireElement) }),
              sendCursor: (input: NonNullable<WhiteboardViewProps["collab"]>["sendCursor"] extends (input: infer T) => unknown ? T : never) => whiteboardTransport.sendCursor(input),
              requestSnapshot: () => whiteboardTransport.requestSnapshot(),
              clear: () => whiteboardTransport.clear(),
              initiateUpload: (input: { readonly fileId: string; readonly mimeType: string; readonly byteLength: number; readonly sha256: string }) => whiteboardTransport.files.initiateUpload(input),
              finalizeUpload: (uploadId: string) => whiteboardTransport.files.finalizeUpload(uploadId),
              presignDownload: (fileId: string) => whiteboardTransport.files.getDownloadUrl(fileId),
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
      layout={settings.appearance.layout === "focus" || settings.appearance.layout === "grid" || settings.appearance.layout === "presentation" ? settings.appearance.layout : (props.layout ?? "focus")}
      onLayoutChange={(nextLayout) => {
        setSettings((current) => ({ ...current, appearance: { ...current.appearance, layout: nextLayout } }));
        props.onLayoutChange?.(nextLayout);
      }}
      features={props.features}
      onOpenDiagnostics={props.onOpenDiagnostics}
      whiteboard={whiteboard}
      onToggleWhiteboard={() => setWhiteboardOpen((open) => !open)}
      infoDialog={props.features?.info !== false && props.inviteLink ? { isOpen: infoOpen, onOpenChange: setInfoOpen, spaceName: props.spaceName, inviteLink: props.inviteLink, onCopyLink: () => void navigator.clipboard?.writeText(props.inviteLink!) } : undefined}
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
          <CommandErrorAlert message={commandError ?? undefined} />
        </>
      }
    />
  );
}

function StatusView({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }): React.JSX.Element {
  const skin = useSkin();
  return (
    <main data-chalk-skin={skin} className="grid h-full min-h-0 place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <div className="grid max-w-sm gap-4 justify-items-center">
        <p role="status" className="text-sm text-[var(--chalk-muted-text)]">
          {message}
        </p>
        {onRetry ? (
          <ChalkButton type="button" onClick={onRetry} variant="solid" tone="accent" className="text-sm font-semibold text-[var(--chalk-accent-text)]">
            Try again
          </ChalkButton>
        ) : null}
      </div>
    </main>
  );
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
    experience: { captions: false, compactMode: false, showInviteToast: true, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
  };
}
