import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ControlBar } from "../../../../sdks/typescript/react/src/components/composite/ControlBar";
import { MediaPreview } from "../../../../sdks/typescript/react/src/components/composite/MediaPreview";
import { MeetingHeader } from "../../../../sdks/typescript/react/src/components/composite/MeetingHeader";
import { MeetingHub } from "../../../../sdks/typescript/react/src/components/composite/MeetingHub";
import { ParticipantList, type ParticipantListParticipant } from "../../../../sdks/typescript/react/src/components/composite/ParticipantList/ParticipantList";
import { VideoGrid, type Participant as GridParticipant, type VideoGridProps } from "../../../../sdks/typescript/react/src/components/composite/VideoGrid";
import { WaitingRoom, type WaitingParticipant } from "../../../../sdks/typescript/react/src/components/composite/WaitingRoom";

export const Route = createFileRoute("/sdk-preview")({
  component: SdkPreviewPage,
});

type PreviewSurface = "lobby" | "conference";
type MeetingLayout = NonNullable<VideoGridProps["layout"]>;

const now = Date.now();

const initialWaitingParticipants: WaitingParticipant[] = [
  { id: "wait-1", displayName: "Mina Patel", joinedAt: new Date(now - 45_000) },
  { id: "wait-2", displayName: "Omar Reed", joinedAt: new Date(now - 4 * 60_000) },
  { id: "wait-3", displayName: "June Carter", joinedAt: new Date(now - 9 * 60_000) },
];

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
  const [surface, setSurface] = useState<PreviewSurface>("lobby");
  const [displayName, setDisplayName] = useState("Hasan");
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isWhiteboardOpen, setIsWhiteboardOpen] = useState(false);
  const [layout, setLayout] = useState<MeetingLayout>("grid");
  const [waitingParticipants, setWaitingParticipants] = useState(initialWaitingParticipants);
  const [isHubOpen, setIsHubOpen] = useState(true);
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

  const admitParticipant = (id: string) => {
    setWaitingParticipants((current) => current.filter((participant) => participant.id !== id));
  };

  const denyParticipant = (id: string) => {
    setWaitingParticipants((current) => current.filter((participant) => participant.id !== id));
  };

  return (
    <main data-chalk data-chalk-theme="dark" className="min-h-screen bg-[#09090b] text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-4 py-4 md:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div>
            <h1 className="font-sans text-xl font-semibold tracking-normal text-white">SDK preview</h1>
            <p className="mt-1 text-sm text-muted-foreground">Lobby and conference components, local state only.</p>
          </div>

          <div className="flex rounded-full border border-white/10 bg-white/5 p-1" role="tablist" aria-label="Preview surface">
            <button
              type="button"
              role="tab"
              aria-selected={surface === "lobby"}
              onClick={() => setSurface("lobby")}
              className={surface === "lobby" ? "rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-950" : "rounded-full px-4 py-2 text-sm font-semibold text-white/70 hover:text-white"}
            >
              Lobby
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={surface === "conference"}
              onClick={() => setSurface("conference")}
              className={surface === "conference" ? "rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-950" : "rounded-full px-4 py-2 text-sm font-semibold text-white/70 hover:text-white"}
            >
              Conference
            </button>
          </div>
        </header>

        {surface === "lobby" ? (
          <section className="grid flex-1 gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-h-[680px] items-center justify-center rounded-[2rem] border border-white/10 bg-[var(--chalk-lobby-gradient)] p-6 shadow-2xl">
              <div className="w-full max-w-xl rounded-[2rem] border border-[var(--chalk-lobby-glass-border)] bg-[var(--chalk-lobby-glass-bg)] p-6 shadow-2xl backdrop-blur-2xl">
                <div className="mb-6">
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Room preview</p>
                  <h2 className="mt-2 font-sans text-2xl font-semibold tracking-normal text-foreground">Design review</h2>
                </div>

                <MediaPreview userName={displayName} isAudioEnabled={!isMuted} isVideoEnabled={isVideoEnabled} audioLevel={isMuted ? 0 : 62} onToggleAudio={() => setIsMuted((value) => !value)} onToggleVideo={() => setIsVideoEnabled((value) => !value)} className="mx-auto" />

                <label className="mt-6 block text-sm font-medium text-muted-foreground" htmlFor="sdk-preview-display-name">
                  Display name
                </label>
                <input id="sdk-preview-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50" />

                <button type="button" onClick={() => setSurface("conference")} className="mt-6 h-12 w-full rounded-full bg-primary text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 hover:brightness-110">
                  Join preview room
                </button>
              </div>
            </div>

            <aside className="flex flex-col gap-4">
              <WaitingRoom participants={waitingParticipants} onAdmit={admitParticipant} onDeny={denyParticipant} onAdmitAll={() => setWaitingParticipants([])} onDenyAll={() => setWaitingParticipants([])} className="w-full" />
              <button type="button" onClick={() => setWaitingParticipants(initialWaitingParticipants)} className="h-11 rounded-full border border-white/10 px-4 text-sm font-semibold text-white/80 hover:bg-white/10">
                Reset waiting room
              </button>
            </aside>
          </section>
        ) : (
          <section className="relative flex flex-1 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-background shadow-2xl">
            <MeetingHeader roomName="Design review" duration={18 * 60 + 42} isRecording={isRecording} isTranscribing={isTranscribing} layout={layout === "screen-share" ? "grid" : layout} onLayoutChange={setLayout} onInvite={() => setIsHubOpen(true)} onSettings={() => setIsHubOpen(true)} />

            <div className="grid flex-1 min-h-[620px] grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-h-0 bg-[var(--chalk-bg-stage)] p-3">
                <VideoGrid participants={participants} layout={layout} pinnedParticipantId="nora" maxVisibleParticipants={9} className="min-h-[520px]" />
              </div>

              {isParticipantsOpen && (
                <ParticipantList
                  participants={participantList}
                  variant="sidebar"
                  canManageParticipants
                  onClose={() => setIsParticipantsOpen(false)}
                  onAddPeople={() => setIsHubOpen(true)}
                  onUpdateDisplayName={setDisplayName}
                  onMuteParticipant={() => undefined}
                  onRemoveParticipant={() => undefined}
                />
              )}
            </div>

            <div className="border-t border-border bg-background/95 px-2 py-3">
              <ControlBar
                variant="dock"
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
        )}
      </div>
    </main>
  );
}
