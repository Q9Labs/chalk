import type React from "react";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MediaRequestDialog } from "../../../../../sdks/typescript/react/src/components/media-request-dialog/MediaRequestDialog";
import { SettingsDialog, type SettingsDialogValue } from "../../../../../sdks/typescript/react/src/components/composite/SettingsDialog";
import type { Toast } from "../../../../../sdks/typescript/react/src/components/toast-stack/ToastStack";
import { ToastStack } from "../../../../../sdks/typescript/react/src/components/toast-stack/ToastStack";
import { CommandErrorAlert, LeaveDialog, PreviewEpisodeEnded, PreviewEntrance, PreviewSpaceView, PreviewStatus, type SpaceLayout, type ThemePalette, type ThemeSkin, type ThemeTexture } from "../../../../../sdks/typescript/react/src/test-support/preview-fixtures";
import { createPreviewClient, type PreviewClientCommand } from "../../../../../sdks/typescript/react/src/test-support/preview-client";
import { COSMIC_CHALK_THEME } from "../../../../../sdks/typescript/react/src/theme";

import { PreviewGalleryToolbar } from "./PreviewGalleryToolbar";
import { DIAGNOSTIC_REFERENCE, DISPLAY_NAME, INITIAL_SETTINGS, SPACE_DESCRIPTION, SPACE_LINK, SPACE_NAME, TOAST_MESSAGES, buildPreviewSnapshot, panelFor, participantsForCount, productionPalette, productionTexture, statusOverlay, type PreviewSnapshotTracks } from "./sdk-preview-fixtures";
import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { createPreviewMediaAdapter, type PreviewTrackBundle } from "./preview-media-adapter";
import { createPreviewWhiteboard, createPreviewWhiteboardAdapter } from "./preview-whiteboard";

export interface SdkPreviewGalleryProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
}

const PREVIEW_EPISODE_DURATION_SECONDS = 18 * 60 + 42;

export function SdkPreviewGallery({ search, onSearchChange }: SdkPreviewGalleryProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(DISPLAY_NAME);
  const [keepAppearanceOpen, setKeepAppearanceOpen] = useState(false);
  const [diagnosticsToastVisible, setDiagnosticsToastVisible] = useState(false);
  const searchRef = useRef(search);
  searchRef.current = search;
  const skin: ThemeSkin = search.skin;
  const mappedPalette: ThemePalette = productionPalette(search.palette);
  const mappedTexture: ThemeTexture = productionTexture(search.texture);
  const entranceTheme = mappedPalette === "cosmic-chalk" ? { ...COSMIC_CHALK_THEME, skin, palette: mappedPalette, texture: mappedTexture } : { skin, palette: mappedPalette, texture: mappedTexture };
  const [settings, setSettings] = useState<SettingsDialogValue>(() => ({ ...INITIAL_SETTINGS, appearance: { ...INITIAL_SETTINGS.appearance, layout: search.layout, skin, palette: mappedPalette, texture: mappedTexture } }));
  const participants = useMemo(() => participantsForCount(search.participants, search), [search]);
  const panel = panelFor(search);
  const effectiveLayout: SpaceLayout = search.stage === "whiteboard" ? "focus" : search.layout;
  const episodeDuration = PREVIEW_EPISODE_DURATION_SECONDS;

  const mediaAdapter = useMemo(() => createPreviewMediaAdapter(), []);
  useEffect(() => () => mediaAdapter.dispose(), [mediaAdapter]);

  const effectiveScreenShare = !search.features.screenShare ? "none" : search.screenShare === "none" && search.stage === "share" ? "remote" : search.screenShare;
  const remoteTrackSelections = useMemo(() => {
    const selections: Record<string, { readonly microphone: boolean; readonly camera: boolean; readonly screen: boolean }> = {};
    for (const participant of participants) {
      if (participant.isLocal) continue;
      selections[participant.id] = {
        microphone: !participant.isMuted,
        // The gallery has no remote camera footage. Let the canonical tile render
        // the Participant avatar instead of presenting a fabricated camera image.
        camera: false,
        screen: Boolean(effectiveScreenShare === "remote" && participant.isScreenSharing),
      };
    }
    return selections;
  }, [effectiveScreenShare, participants]);
  const trackBundle = useMemo<PreviewTrackBundle>(
    () =>
      mediaAdapter.createTrackBundle({
        local: {
          microphone: search.mic === "enabled" || search.mic === "requesting",
          camera: search.camera === "enabled" || search.camera === "requesting",
          screen: effectiveScreenShare === "local",
        },
        remote: remoteTrackSelections,
      }),
    [effectiveScreenShare, mediaAdapter, remoteTrackSelections, search.camera, search.mic],
  );
  useEffect(() => () => trackBundle.stop(), [trackBundle]);

  const snapshotTracks = useMemo<PreviewSnapshotTracks>(
    () => ({
      local: { microphone: trackBundle.local.microphone?.track ?? null, camera: trackBundle.local.camera?.track ?? null, screen: trackBundle.local.screen?.track ?? null },
      remote: new Map([...trackBundle.remote.entries()].map(([participantId, tracks]) => [participantId, { microphone: tracks.microphone?.track ?? null, camera: tracks.camera?.track ?? null, screen: tracks.screen?.track ?? null }])),
    }),
    [trackBundle],
  );
  const gallerySnapshot = useMemo(() => buildPreviewSnapshot({ participants, search, displayName, episodeDuration, tracks: snapshotTracks }), [displayName, episodeDuration, participants, search, snapshotTracks]);

  const observeCommand = useCallback(
    (command: PreviewClientCommand) => {
      switch (command.type) {
        case "setMicrophoneEnabled":
          onSearchChange({ mic: command.enabled ? "enabled" : "disabled" });
          return;
        case "setCameraEnabled":
          onSearchChange({ camera: command.enabled ? "enabled" : "disabled" });
          return;
        case "setScreenShareEnabled":
          onSearchChange(command.enabled ? { screenShare: "local" } : { screenShare: "none", ...(searchRef.current.stage === "share" ? { stage: "people" } : {}) });
          return;
        case "raiseHand":
          onSearchChange({ hand: true });
          return;
        case "lowerHand":
          onSearchChange({ hand: false });
          return;
        case "renameSelf":
          setDisplayName(command.displayName);
          return;
        case "acceptRequest": {
          const requestKind = searchRef.current.incomingMediaRequest;
          onSearchChange(requestKind === "unmute" ? { incomingMediaRequest: "none", mic: "enabled" } : { incomingMediaRequest: "none", camera: "enabled" });
          return;
        }
        case "declineRequest":
          onSearchChange({ incomingMediaRequest: "none" });
          return;
        case "leave":
          onSearchChange({ view: "space", state: "leaving" });
          return;
        case "endEpisode":
          onSearchChange({ view: "space", state: "ended" });
          return;
        default:
          return;
      }
    },
    [onSearchChange],
  );
  const previewClient = useMemo(() => createPreviewClient(gallerySnapshot, { onCommand: observeCommand }), [observeCommand]);
  const [clientSnapshot, setClientSnapshot] = useState<SpaceSnapshot>(gallerySnapshot);
  useEffect(() => {
    previewClient.setSnapshot(gallerySnapshot);
  }, [gallerySnapshot, previewClient]);
  useEffect(() => {
    setClientSnapshot(gallerySnapshot);
    return previewClient.subscribe(() => setClientSnapshot(previewClient.getSnapshot()));
  }, [gallerySnapshot, previewClient]);

  const canDrawWhiteboard = gallerySnapshot.self.can("drawWhiteboard");
  const whiteboardAdapter = useMemo(() => createPreviewWhiteboardAdapter({ canDraw: canDrawWhiteboard }), [canDrawWhiteboard]);
  useEffect(() => () => whiteboardAdapter.dispose(), [whiteboardAdapter]);
  const whiteboard = search.stage === "whiteboard" && search.features.whiteboard && canDrawWhiteboard ? createPreviewWhiteboard({ adapter: whiteboardAdapter, isOpen: true }) : undefined;

  useEffect(() => {
    setSettings((current) => {
      if (current.appearance.layout === search.layout && current.appearance.skin === skin && current.appearance.palette === mappedPalette && current.appearance.texture === mappedTexture) return current;
      return { ...current, appearance: { ...current.appearance, layout: search.layout, skin, palette: mappedPalette, texture: mappedTexture } };
    });
  }, [mappedPalette, mappedTexture, search.layout, skin]);
  useEffect(() => {
    if (search.dialog !== "settings") setKeepAppearanceOpen(false);
  }, [search.dialog]);

  const patch = (updates: PreviewSearchPatch) => onSearchChange(updates);
  const backToEntrance = () => patch({ view: "entrance", state: "ready", panel: "none", dialog: "none" });
  const retrySpace = () => patch({ view: "space", state: "happy" });
  const leaveSpace = () => void previewClient.leave();
  const endEpisode = () => void previewClient.endEpisode();
  const updateSettings = <Section extends keyof SettingsDialogValue>(section: Section, updates: Partial<SettingsDialogValue[Section]>) => {
    setSettings((current) => ({ ...current, [section]: { ...current[section], ...updates } }));
  };
  const updateAppearance = (updates: Partial<SettingsDialogValue["appearance"]>) => {
    updateSettings("appearance", updates);
    if (updates.skin) setKeepAppearanceOpen(true);
    patch({
      ...(updates.layout === "focus" || updates.layout === "grid" || updates.layout === "presentation" ? { layout: updates.layout } : {}),
      ...(updates.skin === "classic" || updates.skin === "chalk" ? { skin: updates.skin } : {}),
      ...(updates.palette ? { palette: updates.palette } : {}),
      ...(updates.texture ? { texture: updates.texture } : {}),
    });
  };

  const entrancePreviewStream = useMemo(() => {
    const cameraTrack = trackBundle.local.camera?.track;
    if (!cameraTrack || search.camera === "disabled" || search.camera === "failed" || typeof MediaStream === "undefined") return null;
    try {
      return new MediaStream([cameraTrack]);
    } catch {
      return null;
    }
  }, [search.camera, trackBundle]);

  if (search.view === "entrance") {
    const joining = search.state === "joining" || search.state === "waiting";
    const lifecycleError = search.state === "failure" ? "We could not prepare your Entrance for this Space." : search.state === "timeout" ? "The Entrance took too long to prepare. Try again when you’re ready." : search.state === "waiting" ? "Your request is with a Space collaborator." : undefined;
    const mediaError = search.state === "warning" || search.mic === "failed" || search.camera === "failed" ? "Preview is unavailable. You can still enter with devices disabled." : undefined;
    return (
      <div data-preview-view="entrance" data-preview-state={search.state} className="relative h-screen overflow-hidden">
        <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
        <PreviewEntrance
          spaceName={SPACE_NAME}
          logoUrl="/brand/chalk/chalk-logo.svg"
          defaultDisplayName={displayName}
          joining={joining}
          microphone={search.mic === "enabled" || search.mic === "requesting"}
          camera={search.camera === "enabled" || search.camera === "requesting"}
          previewError={mediaError}
          previewStream={entrancePreviewStream}
          audioInputDevices={trackBundle.devices.microphones}
          videoInputDevices={trackBundle.devices.cameras}
          audioOutputDevices={trackBundle.devices.speakers}
          error={lifecycleError}
          theme={entranceTheme}
          onJoin={(nextSettings) => {
            setDisplayName(nextSettings.displayName);
            patch({ view: "space", state: "happy", mic: nextSettings.microphone ? "enabled" : "disabled", camera: nextSettings.camera ? "enabled" : "disabled", panel: "none", dialog: "none" });
          }}
          onCancel={backToEntrance}
        />
      </div>
    );
  }

  if (search.state === "failure" || search.state === "leaving" || search.state === "left") {
    const status = search.state === "failure" ? "failed" : search.state;
    return (
      <div data-preview-view="space" data-preview-state={search.state} className="relative h-screen overflow-hidden">
        <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
        <PreviewStatus state={status} spaceName={SPACE_NAME} theme={entranceTheme} error="The Space connection failed before recovery completed." onRetry={retrySpace} />
      </div>
    );
  }

  if (search.state === "ended") {
    return (
      <div data-preview-view="space" data-preview-state="ended" className="relative h-screen overflow-hidden">
        <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
        <PreviewEpisodeEnded spaceName={SPACE_NAME} duration={episodeDuration} participantCount={search.participants} onRejoin={retrySpace} onGoHome={backToEntrance} />
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-[var(--chalk-muted-text)]">Embedding-app callback fixture state</p>
      </div>
    );
  }

  const baseToast = search.toast === "none" ? [] : ([{ id: `preview-toast-${search.toast}`, message: TOAST_MESSAGES[search.toast], type: search.toast }] satisfies Toast[]);
  const diagnosticsToast = diagnosticsToastVisible ? ([{ id: "preview-diagnostics-toast", message: "Diagnostics invoked locally for this preview.", type: "info" }] satisfies Toast[]) : [];
  const warningOverlay = search.state === "warning" ? <CommandErrorAlert message="Some Space actions are temporarily unavailable." /> : null;
  const canEndEpisode = gallerySnapshot.self.can("endEpisode");
  const confirmationOverlay = search.state === "confirmation" ? <LeaveDialog isOpen onClose={retrySpace} onConfirm={leaveSpace} onEndEpisode={canEndEpisode ? endEpisode : undefined} palette={mappedPalette} texture={mappedTexture} /> : null;
  const incomingRequest = clientSnapshot.media.incomingRequests[0];

  return (
    <div data-preview-view="space" data-preview-state={search.state} className="relative h-screen overflow-hidden">
      <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
      <PreviewSpaceView
        client={previewClient}
        spaceName={SPACE_NAME}
        logoUrl="/brand/chalk/chalk-logo.svg"
        skin={skin}
        palette={mappedPalette}
        texture={mappedTexture}
        stageBackground={search.stageBackground}
        inviteLink={SPACE_LINK}
        layout={effectiveLayout}
        onLayoutChange={(nextLayout) => patch({ layout: nextLayout })}
        generatedAvatars={settings.appearance.generatedAvatars}
        initialPanel={panel}
        features={search.features}
        onOpenDiagnostics={search.diagnostics ? () => setDiagnosticsToastVisible(true) : undefined}
        onOpenSettings={search.features.settings ? () => patch({ dialog: "settings" }) : undefined}
        onToggleWhiteboard={() => patch({ stage: search.stage === "whiteboard" ? "people" : "whiteboard" })}
        whiteboard={whiteboard}
        infoDialog={
          search.features.info
            ? {
                isOpen: search.dialog === "info",
                onOpenChange: (open) => patch({ dialog: open ? "info" : "none" }),
                spaceName: SPACE_NAME,
                spaceDescription: SPACE_DESCRIPTION,
                inviteLink: SPACE_LINK,
                onCopyLink: () => {
                  void navigator.clipboard?.writeText(SPACE_LINK);
                  patch({ toast: "success" });
                },
                diagnosticReference: DIAGNOSTIC_REFERENCE,
                onCopyDiagnosticReference: (reference) => void navigator.clipboard?.writeText(reference),
                onSendFeedback: () => setDiagnosticsToastVisible(true),
                duration: episodeDuration,
                stats: { resolution: "1080p · 30fps", latency: 28, packetLoss: 0.1, region: "Frankfurt, DE" },
              }
            : undefined
        }
        settingsDialog={
          search.features.settings ? (
            <SettingsDialog
              isOpen={search.dialog === "settings"}
              onClose={() => {
                setKeepAppearanceOpen(false);
                patch({ dialog: "none" });
              }}
              settings={settings}
              initialSection={keepAppearanceOpen ? "appearance" : undefined}
              onUpdateIdentity={(updates) => {
                updateSettings("identity", updates);
                if (updates.displayName) void previewClient.participants.renameSelf(updates.displayName);
              }}
              onUpdateJoin={(updates) => {
                updateSettings("join", updates);
                if (updates.audioEnabled !== undefined) void previewClient.media.setMicrophoneEnabled(updates.audioEnabled);
                if (updates.videoEnabled !== undefined) void previewClient.media.setCameraEnabled(updates.videoEnabled);
              }}
              onUpdateAudio={(updates) => {
                updateSettings("audio", updates);
                if (updates.selectedInput) void previewClient.media.selectMicrophone(updates.selectedInput);
                if (updates.selectedOutput) void previewClient.media.selectSpeaker(updates.selectedOutput);
              }}
              onUpdateVideo={(updates) => {
                updateSettings("video", updates);
                if (updates.selectedInput) void previewClient.media.selectCamera(updates.selectedInput);
              }}
              onUpdateAppearance={updateAppearance}
              onUpdateExperience={(updates) => updateSettings("experience", updates)}
              audioInputDevices={mediaAdapter.devices.microphones.map((device) => selectableDevice(device, "audioinput"))}
              audioOutputDevices={mediaAdapter.devices.speakers.map((device) => selectableDevice(device, "audiooutput"))}
              videoInputDevices={mediaAdapter.devices.cameras.map((device) => selectableDevice(device, "videoinput"))}
              videoTrack={trackBundle.local.camera?.track ?? null}
              participantColorSeed={displayName}
            />
          ) : undefined
        }
        inviteDialog={{ isOpen: search.dialog === "invite", onOpenChange: (open) => patch({ dialog: open ? "invite" : "none" }), inviteLink: SPACE_LINK, onCopyLink: () => patch({ toast: "success" }) }}
        reconnecting={statusOverlay(search, retrySpace, leaveSpace)}
        onLeft={leaveSpace}
        onEndEpisode={canEndEpisode ? endEpisode : undefined}
        overlay={
          <Fragment>
            {incomingRequest ? <MediaRequestDialog request={incomingRequest} onDecline={() => void previewClient.media.declineRequest(incomingRequest.requestId)} onAllow={() => void previewClient.media.acceptRequest(incomingRequest.requestId)} /> : null}
            {warningOverlay}
            {confirmationOverlay}
            <ToastStack
              toasts={[...baseToast, ...diagnosticsToast]}
              onDismiss={(id) => {
                if (id === "preview-diagnostics-toast") setDiagnosticsToastVisible(false);
                else patch({ toast: "none" });
              }}
              palette={mappedPalette}
              texture={mappedTexture}
            />
          </Fragment>
        }
      />
    </div>
  );
}

function selectableDevice(device: { readonly deviceId: string; readonly label: string }, kind: "audioinput" | "audiooutput" | "videoinput"): Pick<MediaDeviceInfo, "deviceId" | "kind" | "label"> {
  return { ...device, kind };
}
