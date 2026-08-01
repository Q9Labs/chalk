import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { ChalkChatMessage } from "../../../../sdks/typescript/client/src/room-actions/types";
import { ChatPanel } from "../../../../sdks/typescript/react/src/components/composite/ChatPanel";
import { ControlBar } from "../../../../sdks/typescript/react/src/components/composite/ControlBar";
import { MeetingHeader } from "../../../../sdks/typescript/react/src/components/composite/MeetingHeader";
import { MeetingHub } from "../../../../sdks/typescript/react/src/components/composite/MeetingHub";
import { NotificationStack, type Notification } from "../../../../sdks/typescript/react/src/components/composite/NotificationStack";
import { ParticipantList, type ParticipantListParticipant } from "../../../../sdks/typescript/react/src/components/composite/ParticipantList/ParticipantList";
import { VideoGrid, type Participant as GridParticipant, type VideoGridProps } from "../../../../sdks/typescript/react/src/components/composite/VideoGrid";
import { PreJoinLobby, type PreJoinSettings } from "../../../../sdks/typescript/react/src/components/full/PreJoinLobby";
import { WhiteboardPanel } from "../../../../sdks/typescript/react/src/components/full/WhiteboardPanel";
import { useIsMobile } from "../../../../sdks/typescript/react/src/internal/useMediaQuery";
import { MeetingSettingsModal } from "../components/sdk-preview/MeetingSettingsModal";
import { PreviewTweaker } from "../components/sdk-preview/PreviewTweaker";
import { ScreenShareMock } from "../components/sdk-preview/ScreenShareMock";
import "../styles/chalk-excalidraw.css";

export const Route = createFileRoute("/sdk-preview")({
  component: SdkPreviewPage,
});

type PreviewSurface = "lobby" | "conference";
type MeetingLayout = NonNullable<VideoGridProps["layout"]>;

const roomParticipants: GridParticipant[] = [
  {
    id: "you",
    displayName: "Hasan",
    isLocal: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "host",
    connectionQuality: 4,
  } as GridParticipant & { role: "host" },
  {
    id: "nora",
    displayName: "Nora Williams",
    isSpeaking: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "co-host",
    connectionQuality: 4,
  } as GridParticipant & { role: "co-host" },
  {
    id: "akash",
    displayName: "Akash Jain",
    isMuted: true,
    isVideoEnabled: false,
    isHandRaised: true,
    role: "participant",
    connectionQuality: 3,
  } as GridParticipant & { role: "participant" },
  {
    id: "sofia",
    displayName: "Sofia Chen",
    isMuted: false,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 2,
  } as GridParticipant & { role: "participant" },
  {
    id: "malik",
    displayName: "Malik Brooks",
    isMuted: true,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 4,
  } as GridParticipant & { role: "participant" },
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

function SdkPreviewPage() {
  const isMobile = useIsMobile();
  const [surface, setSurface] = useState<PreviewSurface>("lobby");
  const [displayName, setDisplayName] = useState("Hasan");
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isWhiteboardOpen, setIsWhiteboardOpen] = useState(false);
  const [layout, setLayout] = useState<MeetingLayout>("spotlight");
  const [isHubOpen, setIsHubOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [chatMessages, setChatMessages] = useState(INITIAL_CHAT_MESSAGES);
  const previewUrl = typeof window === "undefined" ? "http://localhost:3070/sdk-preview" : `${window.location.origin}/sdk-preview`;

  const participants = useMemo(() => {
    return roomParticipants.map((participant) => {
      if (participant.id !== "you") return participant;
      return {
        ...participant,
        displayName,
        isMuted,
        isVideoEnabled,
        isHandRaised,
      };
    });
  }, [displayName, isHandRaised, isMuted, isVideoEnabled]);

  const participantList = participants.map<ParticipantListParticipant>((participant) => ({
    id: participant.id,
    displayName: participant.displayName,
    isLocal: participant.isLocal,
    isMuted: participant.isMuted,
    isVideoEnabled: participant.isVideoEnabled,
    isHandRaised: participant.isHandRaised,
    role: participant.id === "you" ? "host" : participant.id === "nora" ? "co-host" : "participant",
  }));

  const joinPreview = (settings: PreJoinSettings) => {
    setDisplayName(settings.displayName);
    setIsMuted(!settings.microphoneEnabled);
    setIsVideoEnabled(settings.cameraEnabled);
    setSurface("conference");
  };

  const showNotification = (type: NonNullable<Notification["type"]>) => {
    const messages: Record<NonNullable<Notification["type"]>, string> = {
      info: "Nora joined from a new device.",
      success: "Meeting link copied to your clipboard.",
      warning: "Akash raised a hand.",
      error: "Your network connection is unstable.",
    };
    setNotifications((current) => [...current, { id: `${type}-${Date.now()}`, message: messages[type], type }]);
  };

  if (surface === "lobby") {
    return <PreJoinLobby roomName="Design review" logoUrl="/brand/chalk/chalk-logo.svg" defaultDisplayName={displayName} initialMicrophoneEnabled={!isMuted} initialCameraEnabled={isVideoEnabled} onJoin={joinPreview} />;
  }

  return (
    <main data-chalk data-chalk-theme="light" className="h-dvh min-h-[620px] bg-[#f7f6f2] text-[#0c0e12]">
      <section className="relative mx-auto flex h-full w-full max-w-[1440px] flex-col overflow-hidden border-x border-[#deddd7] bg-[#fbfaf7]">
        <MeetingHeader roomName="Design review" logoUrl="/brand/chalk/chalk-logo.svg" duration={18 * 60 + 42} isRecording={isRecording} isTranscribing={isTranscribing} layout={layout === "screen-share" ? "grid" : layout} onLayoutChange={setLayout} onInfo={() => setIsHubOpen(true)} />

        <div className={`mx-auto grid min-h-0 w-full max-w-[1320px] flex-1 grid-cols-1 gap-3 overflow-hidden px-3 pt-5 lg:px-8 lg:pt-6 ${isParticipantsOpen || isChatOpen ? "lg:grid-cols-[minmax(0,1fr)_340px]" : ""}`}>
          <div className="min-h-0 bg-[#fbfaf7]">
            {isWhiteboardOpen ? (
              <WhiteboardPanel canDraw theme="light" localParticipantColor="#55aac9" excalidrawCssPath="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css" className="h-full min-h-0" />
            ) : (
              <VideoGrid participants={participants} layout={layout} pinnedParticipantId="nora" maxVisibleParticipants={9} className="h-full" screenShareContent={layout === "screen-share" ? <ScreenShareMock /> : undefined} />
            )}
          </div>

          {isParticipantsOpen && (
            <aside className="absolute inset-x-3 top-20 bottom-24 z-40 min-h-0 overflow-hidden rounded-[10px] border border-[#deddd7] bg-white shadow-[0_8px_30px_rgba(12,14,18,0.06)] lg:static">
              <ParticipantList participants={participantList} variant="sidebar" canManageParticipants onClose={() => setIsParticipantsOpen(false)} onAddPeople={() => setIsHubOpen(true)} onUpdateDisplayName={setDisplayName} onMuteParticipant={() => undefined} onRemoveParticipant={() => undefined} />
            </aside>
          )}

          {isChatOpen && (
            <aside className="absolute inset-x-3 top-20 bottom-24 z-40 min-h-0 overflow-hidden rounded-[10px] border border-[#deddd7] bg-white shadow-[0_8px_30px_rgba(12,14,18,0.06)] lg:static">
              <ChatPanel
                messages={chatMessages}
                localParticipantId="you"
                participantNames={Object.fromEntries(participants.map((participant) => [participant.id, participant.displayName]))}
                onClose={() => setIsChatOpen(false)}
                onSendMessage={async ({ text, attachments }) => {
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
                }}
              />
            </aside>
          )}
        </div>

        <div className="z-30 shrink-0">
          <ControlBar
            variant={isMobile ? "mobile" : "dock"}
            buttons={["mic", "video", "screenshare", "whiteboard", "participants", "chat", "more", "leave"]}
            meetingDuration={18 * 60 + 42}
            isMuted={isMuted}
            isVideoEnabled={isVideoEnabled}
            isRecording={isRecording}
            isChatOpen={isChatOpen}
            isParticipantsOpen={isParticipantsOpen}
            isTranscriptionEnabled={isTranscribing}
            isHandRaised={isHandRaised}
            isWhiteboardOpen={isWhiteboardOpen}
            isScreenSharing={layout === "screen-share"}
            unreadChatCount={3}
            selectedAudioInput="default-mic"
            selectedAudioOutput="default-speaker"
            selectedVideoInput="default-camera"
            onToggleMute={() => setIsMuted((value) => !value)}
            onToggleVideo={() => setIsVideoEnabled((value) => !value)}
            onToggleScreenShare={() => {
              setIsWhiteboardOpen(false);
              setLayout((value) => (value === "screen-share" ? "grid" : "screen-share"));
            }}
            onToggleRecording={() => setIsRecording((value) => !value)}
            onToggleChat={() => {
              setIsParticipantsOpen(false);
              setIsChatOpen((value) => !value);
            }}
            onToggleParticipants={() => {
              setIsChatOpen(false);
              setIsParticipantsOpen((value) => !value);
            }}
            onToggleTranscription={() => setIsTranscribing((value) => !value)}
            onToggleHandRaise={() => setIsHandRaised((value) => !value)}
            onToggleWhiteboard={() => {
              setIsWhiteboardOpen((value) => !value);
              setLayout("spotlight");
            }}
            onOpenReactions={() => undefined}
            onOpenMore={() => setIsSettingsOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenDiagnostics={() => setIsHubOpen(true)}
            onLeave={() => setSurface("lobby")}
          />
        </div>

        <MeetingHub
          isOpen={isHubOpen}
          onClose={() => setIsHubOpen(false)}
          roomName="Design review"
          meetingUrl={previewUrl}
          onCopyLink={() => {
            void navigator.clipboard?.writeText(previewUrl);
          }}
          isRecording={isRecording}
          isTranscribing={isTranscribing}
          meetingDuration={18 * 60 + 42}
        />
        <MeetingSettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        <NotificationStack notifications={notifications} onDismiss={(id) => setNotifications((current) => current.filter((notification) => notification.id !== id))} />
        <PreviewTweaker
          onNotify={showNotification}
          onShowPeople={() => {
            setIsChatOpen(false);
            setIsParticipantsOpen(true);
          }}
          onShowChat={() => {
            setIsParticipantsOpen(false);
            setIsChatOpen(true);
          }}
          onShowScreenShare={() => {
            setIsWhiteboardOpen(false);
            setLayout("screen-share");
          }}
          onShowWhiteboard={() => {
            setIsWhiteboardOpen(true);
            setLayout("spotlight");
          }}
          onShowMeetingInfo={() => setIsHubOpen(true)}
          onShowSettings={() => setIsSettingsOpen(true)}
          onToggleHand={() => setIsHandRaised((value) => !value)}
        />
      </section>
    </main>
  );
}
