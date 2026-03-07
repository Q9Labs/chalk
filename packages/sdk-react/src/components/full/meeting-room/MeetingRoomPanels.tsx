import { cn } from "../../../utils/cn";
import { ChatPanel, MobilePanel, ParticipantList, TranscriptionPanel } from "../../composite";
import type { ChatMessage, MeetingPanel, Participant, TranscriptEntry } from "./types";

interface MeetingRoomPanelsProps {
  isMobile: boolean;
  activePanel: MeetingPanel | null;
  onClosePanel: () => void;
  allParticipants: Participant[];
  canManageParticipants: boolean;
  onToggleParticipantMute?: (participantId: string) => void;
  onRemoveParticipant?: (participantId: string) => void;
  onAddPeople: () => void;
  chatMessages: ChatMessage[];
  onSendMessage?: (content: string) => void;
  transcripts: TranscriptEntry[];
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  localParticipantColorSeed?: string;
}

const NOOP = () => {};

export function MeetingRoomPanels({ isMobile, activePanel, onClosePanel, allParticipants, canManageParticipants, onToggleParticipantMute, onRemoveParticipant, onAddPeople, chatMessages, onSendMessage, transcripts, participantVolumes, onParticipantVolumeChange, localParticipantColorSeed }: MeetingRoomPanelsProps) {
  const localParticipantId = allParticipants.find((participant) => participant.isLocal)?.id;

  return (
    <>
      {!isMobile && activePanel && (
        <div className={cn("w-[360px] shrink-0 h-full rounded-3xl overflow-hidden flex flex-col bg-card/80 backdrop-blur-xl border border-border/50 shadow-xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)]", "animate-in slide-in-from-right-10 fade-in duration-300")}>
          {activePanel === "chat" && <ChatPanel messages={chatMessages} onSendMessage={onSendMessage || NOOP} localParticipantId={localParticipantId} onClose={onClosePanel} participantColorSeed={localParticipantColorSeed} />}
          {activePanel === "participants" && (
            <ParticipantList
              participants={allParticipants}
              canManageParticipants={canManageParticipants}
              onMuteParticipant={onToggleParticipantMute}
              onRemoveParticipant={onRemoveParticipant}
              onClose={onClosePanel}
              variant="sidebar"
              onAddPeople={onAddPeople}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={onParticipantVolumeChange}
              participantColorSeed={localParticipantColorSeed}
            />
          )}
          {activePanel === "transcription" && <TranscriptionPanel transcripts={transcripts} onClose={onClosePanel} variant="sidebar" participantColorSeed={localParticipantColorSeed} />}
        </div>
      )}

      {isMobile && activePanel === "chat" && (
        <MobilePanel title="Chat" onClose={onClosePanel}>
          <ChatPanel messages={chatMessages} onSendMessage={onSendMessage || NOOP} localParticipantId={localParticipantId} variant="mobile" participantColorSeed={localParticipantColorSeed} />
        </MobilePanel>
      )}
      {isMobile && activePanel === "participants" && (
        <MobilePanel title="People" onClose={onClosePanel}>
          <ParticipantList
            participants={allParticipants}
            canManageParticipants={canManageParticipants}
            onMuteParticipant={onToggleParticipantMute}
            onRemoveParticipant={onRemoveParticipant}
            variant="mobile"
            onAddPeople={onAddPeople}
            participantVolumes={participantVolumes}
            onParticipantVolumeChange={onParticipantVolumeChange}
            participantColorSeed={localParticipantColorSeed}
          />
        </MobilePanel>
      )}
      {isMobile && activePanel === "transcription" && (
        <MobilePanel title="Transcript" onClose={onClosePanel}>
          <TranscriptionPanel transcripts={transcripts} variant="mobile" participantColorSeed={localParticipantColorSeed} />
        </MobilePanel>
      )}
    </>
  );
}
