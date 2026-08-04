import type { ChalkChatMessage } from "@q9labsai/chalk-client";
import { CommandErrorAlert, ConferenceView as SpaceView, EndScreen, getThemeMode, JoinFailedScreen, JoiningScreen, LeaveDialog, PreJoinScreen, type ConferenceLayout as SpaceLayout, type SettingsDialogValue, type Toast } from "@q9labsai/chalk-react/components";
import type React from "react";
import { Fragment, useMemo, useState } from "react";

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
  const [settings, setSettings] = useState<SettingsDialogValue>(() => ({ ...INITIAL_SETTINGS }));
  const fixtureSearch = useMemo<PreviewSearch>(() => (search.state === "empty" ? { ...search, participants: 0 as const, chat: "empty" as const } : search), [search]);
  const participants = useMemo(() => participantsForCount(fixtureSearch.participants, fixtureSearch), [fixtureSearch]);
  const participantList = useMemo(() => toParticipantList(participants), [participants]);
  const panel = panelFor(search);
  const effectiveLayout: SpaceLayout = search.stage === "share" ? "presentation" : search.stage === "whiteboard" ? "focus" : search.layout;
  const mappedPalette = productionPalette(search.palette);
  const mappedTexture = productionTexture(search.texture);
  const episodeDuration = 18 * 60 + 42;

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
          <PreJoinScreen
            roomName={SPACE_NAME}
            logoUrl="/brand/chalk/chalk-logo.svg"
            defaultDisplayName={displayName}
            initialMicrophoneEnabled={search.mic}
            initialCameraEnabled={search.camera}
            error={search.state === "warning" ? "Camera or microphone access failed. Turn both devices off or try again." : undefined}
            onJoin={(nextSettings) => {
              setDisplayName(nextSettings.displayName);
              patch({ view: "space", state: "happy", mic: nextSettings.microphoneEnabled, camera: nextSettings.cameraEnabled, panel: "none", dialog: "none" });
            }}
          />
        ) : search.state === "joining" ? (
          <JoiningScreen displayName={displayName} message={`Preparing to enter ${SPACE_NAME}`} supportingMessages={["Checking your AccessGrant", "Starting the Episode"]} />
        ) : search.state === "waiting" ? (
          <JoiningScreen displayName={displayName} message={`Waiting for admission to ${SPACE_NAME}`} supportingMessages={["Your request is with a Space collaborator"]} />
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
        <EndScreen roomName={SPACE_NAME} duration={episodeDuration} participantCount={search.participants} onRejoin={retrySpace} onNewMeeting={retrySpace} onGoHome={backToEntrance} />
      </div>
    );
  }

  const toast = search.toast === "none" ? [] : ([{ id: `preview-toast-${search.toast}`, message: TOAST_MESSAGES[search.toast], type: search.toast }] satisfies Toast[]);
  const whiteboard =
    search.stage === "whiteboard" ? { isOpen: true, props: { canDraw: true, theme: getThemeMode(mappedPalette), localParticipantColor: "#55aac9", excalidrawCssPath: "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css", className: "h-full min-h-0" } } : undefined;
  const screenShareFallback =
    search.stage === "share" ? (
      <div className="absolute inset-3 z-10 overflow-hidden rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-stage)] sm:inset-6">
        <ScreenShareMock />
      </div>
    ) : null;
  const warningOverlay = search.state === "warning" ? <CommandErrorAlert message="Some Space actions are temporarily unavailable." /> : null;
  const confirmationOverlay = search.state === "confirmation" ? <LeaveDialog isOpen onClose={retrySpace} onConfirm={backToEntrance} palette={mappedPalette} texture={mappedTexture} /> : null;

  return (
    <div data-preview-view="space" data-preview-state={search.state} className="relative min-h-screen">
      <PreviewGalleryToolbar search={search} onChange={onSearchChange} />
      <SpaceView
        roomName={SPACE_NAME}
        displayName={displayName}
        logoUrl="/brand/chalk/chalk-logo.svg"
        logoUrlOnDark="/brand/chalk/chalk-logo-on-dark.svg"
        palette={mappedPalette}
        texture={mappedTexture}
        meetingLink={SPACE_LINK}
        duration={episodeDuration}
        layout={effectiveLayout}
        onLayoutChange={(nextLayout) => patch({ layout: nextLayout })}
        participants={participants}
        whiteboard={whiteboard}
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
                { messageId: `preview-message-${current.length + 1}`, clientMessageId: `preview-client-${current.length + 1}`, sequence: String(current.length + 1), participantSessionId: "you", displayName, text, createdAt: new Date().toISOString(), attachments: attachments ?? [] },
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
          roomName: SPACE_NAME,
          meetingUrl: SPACE_LINK,
          onCopyLink: () => {
            void navigator.clipboard?.writeText(SPACE_LINK);
            patch({ toast: "success" });
          },
          meetingDuration: episodeDuration,
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
        inviteDialog={{ isOpen: search.dialog === "invite", onOpenChange: (open) => patch({ dialog: open ? "invite" : "none" }), meetingLink: SPACE_LINK, onCopyLink: () => patch({ toast: "success" }) }}
        reactions={{ reactions: REACTIONS, allowedReactions: ["👍", "❤️", "😂", "😮", "😢", "🎉"], onSelect: async () => patch({ toast: "success" }) }}
        toasts={toast}
        onDismissToast={() => patch({ toast: "none" })}
        reconnecting={statusOverlay(search, retrySpace, backToEntrance)}
        overlay={
          <Fragment>
            {screenShareFallback}
            {warningOverlay}
            {confirmationOverlay}
          </Fragment>
        }
        onLeave={backToEntrance}
      />
    </div>
  );
}
