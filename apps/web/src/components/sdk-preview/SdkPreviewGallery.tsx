import type { ChalkChatMessage } from "@q9labsai/chalk-client";
import type React from "react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { CommandErrorAlert, JoinFailedScreen, LeaveDialog, PreviewEpisodeEnded, PreviewEntrance, PreviewJoiningScreen, PreviewSpaceView, type SpaceLayout, type ThemePalette, type ThemeTexture } from "../../../../../sdks/typescript/react/src/test-support/preview-fixtures";
import type { SettingsDialogValue } from "../../../../../sdks/typescript/react/src/components/composite/SettingsDialog";
import type { Toast } from "../../../../../sdks/typescript/react/src/components/toast-stack/ToastStack";

import { PreviewGalleryToolbar } from "./PreviewGalleryToolbar";
import {
  DISPLAY_NAME,
  INITIAL_CHAT_MESSAGES,
  INITIAL_SETTINGS,
  productionPalette,
  productionTexture,
  previewPalette,
  previewTexture,
  participantsForCount,
  panelFor,
  REACTIONS,
  SPACE_LINK,
  SPACE_NAME,
  statusOverlay,
  toParticipantList,
  TOAST_MESSAGES,
  TRANSCRIPT_FIXTURES,
  WAITING_PARTICIPANTS,
  chatPending,
} from "./sdk-preview-fixtures";
import type { PreviewSearch, PreviewSearchPatch } from "./preview-state";
import { ScreenShareMock } from "./ScreenShareMock";

export interface SdkPreviewGalleryProps {
  readonly search: PreviewSearch;
  readonly onSearchChange: (patch: PreviewSearchPatch) => void;
}

export function SdkPreviewGallery({ search, onSearchChange }: SdkPreviewGalleryProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(DISPLAY_NAME);
  const [chatMessages, setChatMessages] = useState<readonly ChalkChatMessage[]>(INITIAL_CHAT_MESSAGES);
  const mappedPalette: ThemePalette = productionPalette(search.palette);
  const mappedTexture: ThemeTexture = productionTexture(search.texture);
  const [settings, setSettings] = useState<SettingsDialogValue>(() => ({
    ...INITIAL_SETTINGS,
    appearance: { ...INITIAL_SETTINGS.appearance, layout: search.layout, palette: mappedPalette, texture: mappedTexture },
  }));
  const fixtureSearch = useMemo<PreviewSearch>(() => (search.state === "empty" ? { ...search, participants: 0 as const, chat: "empty" as const } : search), [search]);
  const participants = useMemo(() => participantsForCount(fixtureSearch.participants, fixtureSearch), [fixtureSearch]);
  const participantList = useMemo(() => toParticipantList(participants), [participants]);
  const panel = panelFor(search);
  const effectiveLayout: SpaceLayout = search.stage === "share" ? "presentation" : search.stage === "whiteboard" ? "focus" : search.layout;
  const episodeDuration = 18 * 60 + 42;

  useEffect(() => {
    setSettings((current) => {
      if (current.appearance.layout === search.layout && current.appearance.palette === mappedPalette && current.appearance.texture === mappedTexture) return current;
      return { ...current, appearance: { ...current.appearance, layout: search.layout, palette: mappedPalette, texture: mappedTexture } };
    });
  }, [mappedPalette, mappedTexture, search.layout]);

  const patch = (updates: PreviewSearchPatch) => onSearchChange(updates);
  const backToEntrance = () => patch({ view: "entrance", state: "ready", panel: "none", dialog: "none" });
  const retrySpace = () => patch({ view: "space", state: "happy" });
  const updateSettings = <Section extends keyof SettingsDialogValue>(section: Section, updates: Partial<SettingsDialogValue[Section]>) => {
    setSettings((current) => ({ ...current, [section]: { ...current[section], ...updates } }));
    if (section !== "appearance") return;
    const appearance = updates as Partial<SettingsDialogValue["appearance"]>;
    patch({
      ...(appearance.layout === "focus" || appearance.layout === "grid" || appearance.layout === "presentation" ? { layout: appearance.layout } : {}),
      ...(appearance.palette ? { palette: previewPalette(appearance.palette) } : {}),
      ...(appearance.texture ? { texture: previewTexture(appearance.texture) } : {}),
    });
  };

  if (search.view === "entrance") {
    return (
      <div data-preview-view="entrance" data-preview-state={search.state} className="relative min-h-screen">
        <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
        {search.state === "ready" || search.state === "warning" ? (
          <PreviewEntrance
            spaceName={SPACE_NAME}
            logoUrl="/brand/chalk/chalk-logo.svg"
            defaultDisplayName={displayName}
            microphone={search.mic}
            camera={search.camera}
            error={search.state === "warning" ? "Camera or microphone access failed. Turn both devices off or try again." : undefined}
            onJoin={(nextSettings) => {
              setDisplayName(nextSettings.displayName);
              patch({ view: "space", state: "happy", mic: nextSettings.microphone, camera: nextSettings.camera, panel: "none", dialog: "none" });
            }}
          />
        ) : search.state === "joining" ? (
          <PreviewJoiningScreen displayName={displayName} message={`Preparing to enter ${SPACE_NAME}`} supportingMessages={["Checking your AccessGrant", "Starting the Episode"]} />
        ) : search.state === "waiting" ? (
          <PreviewJoiningScreen displayName={displayName} message={`Waiting for admission to ${SPACE_NAME}`} supportingMessages={["Your request is with a Space collaborator"]} />
        ) : (
          <JoinFailedScreen
            title={search.state === "timeout" ? "Entrance timed out" : "Could not enter the Space"}
            message={search.state === "timeout" ? "The Entrance took too long to prepare. Try again when you’re ready." : "We could not prepare your Entrance for this Space."}
            supportCode={search.state === "timeout" ? "entrance-timeout-408" : "entrance-failure-403"}
            onRetry={() => patch({ view: "entrance", state: "ready" })}
            onBack={backToEntrance}
          />
        )}
      </div>
    );
  }

  if (search.state === "ended") {
    return (
      <div data-preview-view="space" data-preview-state="ended" className="relative min-h-screen">
        <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
        <PreviewEpisodeEnded spaceName={SPACE_NAME} duration={episodeDuration} participantCount={search.participants} onRejoin={retrySpace} onGoHome={backToEntrance} />
      </div>
    );
  }

  const toast = search.toast === "none" ? [] : ([{ id: `preview-toast-${search.toast}`, message: TOAST_MESSAGES[search.toast], type: search.toast }] satisfies Toast[]);
  const whiteboardFallback = search.stage === "whiteboard" ? <PreviewWhiteboardMock palette={mappedPalette} texture={mappedTexture} /> : null;
  const screenShareFallback =
    search.stage === "share" ? (
      <div className="absolute inset-3 z-10 overflow-hidden rounded-[10px] border border-[var(--chalk-line)] bg-[var(--chalk-stage)] sm:inset-6">
        <ScreenShareMock />
      </div>
    ) : null;
  const warningOverlay = search.state === "warning" ? <CommandErrorAlert message="Some Space actions are temporarily unavailable." /> : null;
  const confirmationOverlay = search.state === "confirmation" ? <LeaveDialog isOpen onClose={retrySpace} onConfirm={backToEntrance} palette={mappedPalette} texture={mappedTexture} /> : null;

  return (
    <div data-preview-view="space" data-preview-state={search.state} className="relative min-h-screen">
      <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
      <PreviewSpaceView
        spaceName={SPACE_NAME}
        displayName={displayName}
        logoUrl="/brand/chalk/chalk-logo.svg"
        palette={mappedPalette}
        texture={mappedTexture}
        inviteLink={SPACE_LINK}
        duration={episodeDuration}
        layout={effectiveLayout}
        onLayoutChange={(nextLayout) => patch({ layout: nextLayout })}
        participants={participants}
        controls={{
          buttons: ["mic", "video", "screenshare", "whiteboard", "handraise", "participants", "chat", "transcription", "reactions", "more", "info", "leave"],
          isMuted: !search.mic,
          isVideoEnabled: search.camera,
          isHandRaised: search.hand,
          isWhiteboardOpen: search.stage === "whiteboard",
          isScreenSharing: search.stage === "share",
          isChatOpen: search.panel === "chat",
          isParticipantsOpen: search.panel === "participants",
          unreadChatCount: fixtureSearch.chat === "ready" ? 3 : 0,
          onToggleMute: () => patch({ mic: !search.mic }),
          onToggleVideo: () => patch({ camera: !search.camera }),
          onToggleScreenShare: () => patch({ stage: search.stage === "share" ? "people" : "share", layout: "presentation" }),
          onToggleWhiteboard: () => patch({ stage: search.stage === "whiteboard" ? "people" : "whiteboard", layout: "focus" }),
          onToggleHandRaise: () => patch({ hand: !search.hand }),
          onToggleChat: () => patch({ panel: search.panel === "chat" ? "none" : "chat" }),
          onToggleParticipants: () => patch({ panel: search.panel === "participants" ? "none" : "participants" }),
          onOpenMore: () => patch({ dialog: "settings" }),
          onOpenInfo: () => patch({ dialog: "info" }),
          onOpenReactions: () => patch({ toast: "success" }),
        }}
        mobileControlButtons={["mic", "video", "participants", "chat", "handraise", "more", "leave"]}
        panels={{
          active: panel,
          onChange: (nextPanel) => patch({ panel: nextPanel === "settings" ? "none" : (nextPanel ?? "none") }),
          participants: { participants: participantList, searchable: true, canManageParticipants: true, onAddPeople: () => patch({ dialog: "invite" }), onUpdateDisplayName: setDisplayName },
          chat: {
            messages: fixtureSearch.chat === "ready" ? chatMessages : [],
            pendingMessages: chatPending(fixtureSearch),
            localParticipantId: "you",
            participantNames: Object.fromEntries(participants.map((participant) => [participant.id, participant.displayName])),
            error: fixtureSearch.chat === "failure" ? "Chat is temporarily unavailable in this Space." : undefined,
            hasOlder: fixtureSearch.chat === "loading",
            loadingOlder: fixtureSearch.chat === "loading",
            onLoadOlder: async () => undefined,
            onRetryMessage: async () => undefined,
            onSendMessage: async ({ text, attachments }) => {
              setChatMessages((current) => [
                ...current,
                { messageId: `preview-message-${current.length + 1}`, clientMessageId: `preview-client-${current.length + 1}`, sequence: String(current.length + 1), participantId: "you", displayName, text, createdAt: new Date().toISOString(), attachments: attachments ?? [] },
              ]);
            },
          },
          transcript: { transcripts: search.state === "empty" ? [] : [...TRANSCRIPT_FIXTURES], isLive: true, searchable: true, localParticipantId: "you", onExport: () => undefined, onCopyAll: () => undefined },
          admission: {
            participants: search.state === "empty" ? [] : WAITING_PARTICIPANTS,
            onAdmit: () => patch({ toast: "success" }),
            onDeny: () => patch({ toast: "info" }),
            onAdmitAll: () => patch({ toast: "success" }),
            onDenyAll: () => patch({ toast: "info" }),
            loading: search.state === "reconnecting",
          },
        }}
        infoDialog={{
          isOpen: search.dialog === "info",
          onOpenChange: (open) => patch({ dialog: open ? "info" : "none" }),
          spaceName: SPACE_NAME,
          inviteLink: SPACE_LINK,
          onCopyLink: () => {
            void navigator.clipboard?.writeText(SPACE_LINK);
            patch({ toast: "success" });
          },
          duration: episodeDuration,
        }}
        settingsDialog={{
          isOpen: search.dialog === "settings",
          onOpenChange: (open) => patch({ dialog: open ? "settings" : "none" }),
          settings,
          onUpdateIdentity: (updates) => {
            updateSettings("identity", updates);
            if (updates.displayName) setDisplayName(updates.displayName);
          },
          onUpdateJoin: (updates) => updateSettings("join", updates),
          onUpdateAudio: (updates) => updateSettings("audio", updates),
          onUpdateVideo: (updates) => updateSettings("video", updates),
          onUpdateAppearance: (updates) => updateSettings("appearance", updates),
          onUpdateExperience: (updates) => updateSettings("experience", updates),
          videoTrack: null,
          participantColorSeed: displayName,
        }}
        inviteDialog={{ isOpen: search.dialog === "invite", onOpenChange: (open) => patch({ dialog: open ? "invite" : "none" }), inviteLink: SPACE_LINK, onCopyLink: () => patch({ toast: "success" }) }}
        reactions={{ reactions: REACTIONS, allowedReactions: ["👍", "❤️", "😂", "😮", "😢", "🎉"], onSelect: async () => patch({ toast: "success" }) }}
        toasts={toast}
        onDismissToast={() => patch({ toast: "none" })}
        reconnecting={statusOverlay(search, retrySpace, backToEntrance)}
        overlay={
          <Fragment>
            {screenShareFallback}
            {whiteboardFallback}
            {warningOverlay}
            {confirmationOverlay}
          </Fragment>
        }
        onLeft={backToEntrance}
      />
    </div>
  );
}

function PreviewWhiteboardMock({ palette, texture }: { readonly palette: ThemePalette; readonly texture: ThemeTexture }): React.JSX.Element {
  return (
    <div
      data-testid="preview-whiteboard"
      data-preview-whiteboard="local"
      data-preview-palette={palette}
      data-preview-texture={texture}
      className="absolute inset-3 z-10 overflow-hidden rounded-[10px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)] sm:inset-6"
    >
      <div className="flex items-center justify-between border-b border-[var(--chalk-line)] bg-[var(--chalk-chrome)] px-4 py-3 text-xs text-[var(--chalk-muted-text)]">
        <span className="font-semibold text-[var(--chalk-text)]">Whiteboard preview</span>
        <span>Local fixture · {texture}</span>
      </div>
      <div
        className="relative h-[calc(100%-49px)] overflow-hidden bg-[var(--chalk-canvas)]"
        style={{ backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--chalk-line) 35%, transparent) 1px, transparent 1px), linear-gradient(color-mix(in srgb, var(--chalk-line) 35%, transparent) 1px, transparent 1px)", backgroundSize: "32px 32px" }}
      >
        <div className="absolute left-[18%] top-[22%] h-28 w-48 rotate-[-3deg] rounded-xl border-2 border-[var(--chalk-accent)] bg-[var(--chalk-surface)] p-4 shadow-[var(--chalk-shadow)]">
          <p className="text-sm font-semibold text-[var(--chalk-text)]">Shared direction</p>
          <p className="mt-2 text-xs leading-5 text-[var(--chalk-muted-text)]">A calm local canvas for the SDK preview.</p>
        </div>
        <div className="absolute right-[18%] top-[42%] h-24 w-40 rotate-[4deg] rounded-xl border-2 border-[var(--chalk-positive)] bg-[var(--chalk-surface)] p-4 shadow-[var(--chalk-shadow)]">
          <p className="text-sm font-semibold text-[var(--chalk-text)]">Next step</p>
          <p className="mt-2 text-xs leading-5 text-[var(--chalk-muted-text)]">No network canvas loaded.</p>
        </div>
      </div>
    </div>
  );
}
