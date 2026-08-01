import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ControlBar } from "../../../../sdks/typescript/react/src/components/composite/ControlBar";
import { MeetingHeader } from "../../../../sdks/typescript/react/src/components/composite/MeetingHeader";
import { MeetingHub } from "../../../../sdks/typescript/react/src/components/composite/MeetingHub";
import { ParticipantList, type ParticipantListParticipant } from "../../../../sdks/typescript/react/src/components/composite/ParticipantList/ParticipantList";
import { VideoGrid, type Participant as GridParticipant, type VideoGridProps } from "../../../../sdks/typescript/react/src/components/composite/VideoGrid";
import { PreJoinLobby, type PreJoinSettings } from "../../../../sdks/typescript/react/src/components/full/PreJoinLobby";
import { useIsMobile } from "../../../../sdks/typescript/react/src/internal/useMediaQuery";

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

  if (surface === "lobby") {
    return <PreJoinLobby roomName="Design review" logoUrl="/brand/chalk/chalk-logo.svg" defaultDisplayName={displayName} initialMicrophoneEnabled={!isMuted} initialCameraEnabled={isVideoEnabled} onJoin={joinPreview} />;
  }

  return (
    <main data-chalk data-chalk-theme="light" className="h-dvh min-h-[620px] bg-[#f7f6f2] text-[#0c0e12]">
      <section className="relative mx-auto flex h-full w-full max-w-[1440px] flex-col overflow-hidden border-x border-[#deddd7] bg-[#fbfaf7]">
        <MeetingHeader roomName="Design review" logoUrl="/brand/chalk/chalk-logo.svg" duration={18 * 60 + 42} isRecording={isRecording} isTranscribing={isTranscribing} layout={layout === "screen-share" ? "grid" : layout} onLayoutChange={setLayout} />

        <div className={`mx-auto grid min-h-0 w-full max-w-[1320px] flex-1 grid-cols-1 gap-0 overflow-hidden px-3 pt-5 lg:px-8 lg:pt-6 ${isParticipantsOpen ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
          <div className="min-h-0 bg-[#fbfaf7]">
            <VideoGrid participants={participants} layout={layout} pinnedParticipantId="nora" maxVisibleParticipants={9} className="h-full" />
          </div>

          {isParticipantsOpen && (
            <ParticipantList participants={participantList} variant="sidebar" canManageParticipants onClose={() => setIsParticipantsOpen(false)} onAddPeople={() => setIsHubOpen(true)} onUpdateDisplayName={setDisplayName} onMuteParticipant={() => undefined} onRemoveParticipant={() => undefined} />
          )}
        </div>

        <div className="bg-[#fbfaf7] pt-3">
          <ControlBar
            variant={isMobile ? "mobile" : "dock"}
            buttons={["mic", "video", "screenshare", "participants", "chat", "more", "leave"]}
            meetingDuration={18 * 60 + 42}
            isMuted={isMuted}
            isVideoEnabled={isVideoEnabled}
            isRecording={isRecording}
            isChatOpen={isChatOpen}
            isParticipantsOpen={isParticipantsOpen}
            isTranscriptionEnabled={isTranscribing}
            isHandRaised={isHandRaised}
            isWhiteboardOpen={isWhiteboardOpen}
            unreadChatCount={3}
            selectedAudioInput="default-mic"
            selectedAudioOutput="default-speaker"
            selectedVideoInput="default-camera"
            onToggleMute={() => setIsMuted((value) => !value)}
            onToggleVideo={() => setIsVideoEnabled((value) => !value)}
            onToggleScreenShare={() => setLayout((value) => (value === "screen-share" ? "grid" : "screen-share"))}
            onToggleRecording={() => setIsRecording((value) => !value)}
            onToggleChat={() => setIsChatOpen((value) => !value)}
            onToggleParticipants={() => setIsParticipantsOpen((value) => !value)}
            onToggleTranscription={() => setIsTranscribing((value) => !value)}
            onToggleHandRaise={() => setIsHandRaised((value) => !value)}
            onToggleWhiteboard={() => setIsWhiteboardOpen((value) => !value)}
            onOpenReactions={() => undefined}
            onOpenMore={() => setIsHubOpen(true)}
            onOpenSettings={() => setIsHubOpen(true)}
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
      </section>
    </main>
  );
}
