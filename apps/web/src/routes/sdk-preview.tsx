import type { ChalkChatMessage, ChalkRoomReaction } from "@q9labsai/chalk-client";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ConferenceView, PreJoinScreen, type ConferenceLayout, type ConferencePanel, type Participant, type ParticipantListParticipant, type SettingsDialogValue, type Toast } from "@q9labsai/chalk-react/components";
import { PreviewTweaker } from "../components/sdk-preview/PreviewTweaker";
import { ScreenShareMock } from "../components/sdk-preview/ScreenShareMock";
import "../styles/chalk-excalidraw.css";

export const Route = createFileRoute("/sdk-preview")({
  component: SdkPreviewPage,
});

type PreviewSurface = "lobby" | "conference";
type PreviewParticipant = Participant & { readonly role: "host" | "co-host" | "participant" };

const roomParticipants: PreviewParticipant[] = [
  {
    id: "you",
    displayName: "Hasan",
    isLocal: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "host",
    connectionQuality: 4,
  },
  {
    id: "nora",
    displayName: "Nora Williams",
    isSpeaking: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "co-host",
    connectionQuality: 4,
  },
  {
    id: "akash",
    displayName: "Akash Jain",
    isMuted: true,
    isVideoEnabled: false,
    isHandRaised: true,
    role: "participant",
    connectionQuality: 3,
  },
  {
    id: "sofia",
    displayName: "Sofia Chen",
    isMuted: false,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 2,
  },
  {
    id: "malik",
    displayName: "Malik Brooks",
    isMuted: true,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 4,
  },
];

const INITIAL_CHAT_MESSAGES: ChalkChatMessage[] = [
  {
    messageId: "preview-message-1",
    clientMessageId: "preview-client-1",
    sequence: "1",
    participantSessionId: "nora",
    displayName: "Nora Williams",
    text: "The new room direction feels much calmer.",
    createdAt: "2026-08-01T10:12:00.000Z",
    attachments: [],
  },
  {
    messageId: "preview-message-2",
    clientMessageId: "preview-client-2",
    sequence: "2",
    participantSessionId: "you",
    displayName: "Hasan",
    text: "Agreed. Let’s keep the controls out of the stage.",
    createdAt: "2026-08-01T10:13:00.000Z",
    attachments: [],
  },
  {
    messageId: "preview-message-3",
    clientMessageId: "preview-client-3",
    sequence: "3",
    participantSessionId: "sofia",
    displayName: "Sofia Chen",
    text: "I’ll share the revised agenda here after the call.",
    createdAt: "2026-08-01T10:14:00.000Z",
    attachments: [],
  },
];

const INITIAL_SETTINGS: SettingsDialogValue = {
  identity: { displayName: "Hasan" },
  join: { videoEnabled: true, audioEnabled: true },
  audio: { selectedInput: "default-mic", selectedOutput: "default-speaker", outputVolume: 68, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  video: { selectedInput: "default-camera", quality: "auto" },
  appearance: { layout: "focus", theme: "light", gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: false },
  experience: { captions: false, compactMode: false, showInviteToast: false, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
};

const previewTrack = {} as MediaStreamTrack;

function SdkPreviewPage() {
  const [surface, setSurface] = useState<PreviewSurface>("lobby");
  const [displayName, setDisplayName] = useState("Hasan");
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [activePanel, setActivePanel] = useState<ConferencePanel | null>(null);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isInfoOpen, setInfoOpen] = useState(false);
  const [isWhiteboardOpen, setWhiteboardOpen] = useState(false);
  const [layout, setLayout] = useState<ConferenceLayout>("focus");
  const [notifications, setNotifications] = useState<Toast[]>([]);
  const [chatMessages, setChatMessages] = useState(INITIAL_CHAT_MESSAGES);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const previewUrl = typeof window === "undefined" ? "http://localhost:3070/sdk-preview" : `${window.location.origin}/sdk-preview`;

  const participants = useMemo<PreviewParticipant[]>(
    () =>
      roomParticipants.map((participant) =>
        participant.id === "you"
          ? {
              ...participant,
              displayName,
              isMuted,
              isVideoEnabled,
              isHandRaised,
            }
          : participant,
      ),
    [displayName, isHandRaised, isMuted, isVideoEnabled],
  );
  const participantList = useMemo<ParticipantListParticipant[]>(
    () =>
      participants.map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        isLocal: participant.isLocal,
        isMuted: participant.isMuted,
        isVideoEnabled: participant.isVideoEnabled,
        isHandRaised: participant.isHandRaised,
        role: participant.role,
      })),
    [participants],
  );
  const reactions = useMemo<ChalkRoomReaction[]>(
    () => [
      {
        eventId: "preview-reaction-1",
        participantSessionId: "nora",
        displayName: "Nora Williams",
        reaction: "🎉",
        occurredAt: "2026-08-01T10:15:00.000Z",
        expiresAt: "2026-08-01T10:16:00.000Z",
      },
    ],
    [],
  );

  const showNotification = (type: NonNullable<Toast["type"]>) => {
    const messages: Record<NonNullable<Toast["type"]>, string> = {
      info: "Nora joined from a new device.",
      success: "Meeting link copied to your clipboard.",
      warning: "Akash raised a hand.",
      error: "Your network connection is unstable.",
    };
    setNotifications((current) => [...current, { id: `${type}-${Date.now()}`, message: messages[type], type }]);
  };

  const updateSettings = <Section extends keyof SettingsDialogValue>(section: Section, updates: Partial<SettingsDialogValue[Section]>) => {
    setSettings((current) => ({ ...current, [section]: { ...current[section], ...updates } }));
  };

  if (surface === "lobby") {
    return (
      <PreJoinScreen
        roomName="Design review"
        logoUrl="/brand/chalk/chalk-logo.svg"
        defaultDisplayName={displayName}
        initialMicrophoneEnabled={!isMuted}
        initialCameraEnabled={isVideoEnabled}
        onJoin={(nextSettings) => {
          setDisplayName(nextSettings.displayName);
          setIsMuted(!nextSettings.microphoneEnabled);
          setIsVideoEnabled(nextSettings.cameraEnabled);
          setSurface("conference");
        }}
      />
    );
  }

  return (
    <>
      <ConferenceView
        roomName="Design review"
        displayName={displayName}
        logoUrl="/brand/chalk/chalk-logo.svg"
        meetingLink={previewUrl}
        duration={18 * 60 + 42}
        layout={layout}
        onLayoutChange={(nextLayout) => {
          setLayout(nextLayout);
          updateSettings("appearance", { layout: nextLayout });
        }}
        participants={participants}
        screenShare={layout === "presentation" ? { screenShareTrack: previewTrack, sharedByName: "Nora Williams", content: <ScreenShareMock /> } : undefined}
        whiteboard={isWhiteboardOpen ? { isOpen: true, props: { canDraw: true, theme: "light", localParticipantColor: "#55aac9", excalidrawCssPath: "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css", className: "h-full min-h-0" } } : undefined}
        controls={{
          buttons: ["mic", "video", "screenshare", "whiteboard", "participants", "chat", "reactions", "more", "leave"],
          isMuted,
          isVideoEnabled,
          isHandRaised,
          isWhiteboardOpen,
          isScreenSharing: layout === "presentation",
          isChatOpen: activePanel === "chat",
          isParticipantsOpen: activePanel === "participants",
          unreadChatCount: 3,
          onToggleMute: () => setIsMuted((value) => !value),
          onToggleVideo: () => setIsVideoEnabled((value) => !value),
          onToggleScreenShare: () => {
            setWhiteboardOpen(false);
            setLayout((value) => (value === "presentation" ? "focus" : "presentation"));
          },
          onToggleWhiteboard: () => {
            setWhiteboardOpen((value) => !value);
            setLayout("focus");
          },
          onToggleHandRaise: () => setIsHandRaised((value) => !value),
          onToggleChat: () => setActivePanel((value) => (value === "chat" ? null : "chat")),
          onToggleParticipants: () => setActivePanel((value) => (value === "participants" ? null : "participants")),
          onOpenMore: () => setSettingsOpen(true),
        }}
        mobileControlButtons={["mic", "video", "participants", "chat", "more", "leave"]}
        panels={{
          active: activePanel,
          onChange: setActivePanel,
          participants: {
            participants: participantList,
            searchable: true,
            canManageParticipants: true,
            onAddPeople: () => setInfoOpen(true),
            onUpdateDisplayName: setDisplayName,
          },
          chat: {
            messages: chatMessages,
            localParticipantId: "you",
            participantNames: Object.fromEntries(participants.map((participant) => [participant.id, participant.displayName])),
            onSendMessage: async ({ text, attachments }) => {
              setChatMessages((current) => [
                ...current,
                {
                  messageId: `preview-message-${current.length + 1}`,
                  clientMessageId: `preview-client-${current.length + 1}`,
                  sequence: String(current.length + 1),
                  participantSessionId: "you",
                  displayName,
                  text,
                  createdAt: new Date().toISOString(),
                  attachments: attachments ?? [],
                },
              ]);
            },
          },
        }}
        infoDialog={{
          isOpen: isInfoOpen,
          onOpenChange: setInfoOpen,
          roomName: "Design review",
          meetingUrl: previewUrl,
          onCopyLink: () => {
            void navigator.clipboard?.writeText(previewUrl);
          },
          meetingDuration: 18 * 60 + 42,
        }}
        settingsDialog={{
          isOpen: isSettingsOpen,
          onOpenChange: setSettingsOpen,
          settings,
          onUpdateIdentity: (updates) => updateSettings("identity", updates),
          onUpdateJoin: (updates) => updateSettings("join", updates),
          onUpdateAudio: (updates) => updateSettings("audio", updates),
          onUpdateVideo: (updates) => updateSettings("video", updates),
          onUpdateAppearance: (updates) => updateSettings("appearance", updates),
          onUpdateExperience: (updates) => updateSettings("experience", updates),
          videoTrack: previewTrack,
          participantColorSeed: displayName,
        }}
        reactions={{ reactions, allowedReactions: ["👍", "❤️", "😂", "😮", "😢", "🎉"], onSelect: () => showNotification("success") }}
        toasts={notifications}
        onDismissToast={(id) => setNotifications((current) => current.filter((toast) => toast.id !== id))}
        onLeave={() => setSurface("lobby")}
      />
      <PreviewTweaker
        onNotify={showNotification}
        onShowPeople={() => setActivePanel("participants")}
        onShowChat={() => setActivePanel("chat")}
        onShowScreenShare={() => {
          setWhiteboardOpen(false);
          setLayout("presentation");
        }}
        onShowWhiteboard={() => {
          setWhiteboardOpen(true);
          setLayout("focus");
        }}
        onShowMeetingInfo={() => setInfoOpen(true)}
        onShowSettings={() => setSettingsOpen(true)}
        onToggleHand={() => setIsHandRaised((value) => !value)}
      />
    </>
  );
}
