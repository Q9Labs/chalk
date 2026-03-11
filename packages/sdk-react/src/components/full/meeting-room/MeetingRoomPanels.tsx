import { cn } from "../../../utils/cn";
import type { ParticipantGradientPreference } from "../../../utils/colorGenerator";
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
  onUpdateDisplayName?: (displayName: string) => void;
  onAddPeople: () => void;
  chatMessages: ChatMessage[];
  onSendMessage?: (content: string) => void;
  onSendMessageWithAttachments?: (content: string, files: File[]) => Promise<void>;
  onResolveChatAttachmentUrl?: (attachmentId: string) => Promise<string>;
  transcripts: TranscriptEntry[];
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  localParticipantColorSeed?: string;
  localParticipantGradientPreference?: ParticipantGradientPreference;
}

const NOOP = () => {};

export function MeetingRoomPanels({
  isMobile,
  activePanel,
  onClosePanel,
  allParticipants,
  canManageParticipants,
  onToggleParticipantMute,
  onRemoveParticipant,
  onUpdateDisplayName,
  onAddPeople,
  chatMessages,
  onSendMessage,
  onSendMessageWithAttachments,
  onResolveChatAttachmentUrl,
  transcripts,
  participantVolumes,
  onParticipantVolumeChange,
  localParticipantColorSeed,
  localParticipantGradientPreference,
}: MeetingRoomPanelsProps) {
  const localParticipantId = allParticipants.find((participant) => participant.isLocal)?.id;

  return (
    <>
      {!isMobile && activePanel && (
        <div className={cn("flex min-h-0 w-[360px] shrink-0 flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-xl transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)]", "animate-in slide-in-from-right-10 fade-in duration-300")}>
          {activePanel === "chat" && (
            <ChatPanel
              messages={chatMessages}
              onSendMessage={onSendMessage || NOOP}
              onSendMessageWithAttachments={onSendMessageWithAttachments}
              onResolveAttachmentUrl={onResolveChatAttachmentUrl}
              localParticipantId={localParticipantId}
              onClose={onClosePanel}
              participantColorSeed={localParticipantColorSeed}
              participantGradientPreference={localParticipantGradientPreference}
            />
          )}
          {activePanel === "participants" && (
            <ParticipantList
              participants={allParticipants}
              canManageParticipants={canManageParticipants}
              onMuteParticipant={onToggleParticipantMute}
              onRemoveParticipant={onRemoveParticipant}
              onUpdateDisplayName={onUpdateDisplayName}
              onClose={onClosePanel}
              variant="sidebar"
              onAddPeople={onAddPeople}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={onParticipantVolumeChange}
              participantColorSeed={localParticipantColorSeed}
              participantGradientPreference={localParticipantGradientPreference}
            />
          )}
          {activePanel === "transcription" && <TranscriptionPanel transcripts={transcripts} onClose={onClosePanel} variant="sidebar" participantColorSeed={localParticipantColorSeed} participantGradientPreference={localParticipantGradientPreference} />}
        </div>
      )}

      {isMobile && activePanel === "chat" && (
        <MobilePanel title="Chat" onClose={onClosePanel}>
          <ChatPanel
            messages={chatMessages}
            onSendMessage={onSendMessage || NOOP}
            onSendMessageWithAttachments={onSendMessageWithAttachments}
            onResolveAttachmentUrl={onResolveChatAttachmentUrl}
            localParticipantId={localParticipantId}
            variant="mobile"
            participantColorSeed={localParticipantColorSeed}
            participantGradientPreference={localParticipantGradientPreference}
          />
        </MobilePanel>
      )}
      {isMobile && activePanel === "participants" && (
        <MobilePanel title="People" onClose={onClosePanel}>
          <ParticipantList
            participants={allParticipants}
            canManageParticipants={canManageParticipants}
            onMuteParticipant={onToggleParticipantMute}
            onRemoveParticipant={onRemoveParticipant}
            onUpdateDisplayName={onUpdateDisplayName}
            variant="mobile"
            onAddPeople={onAddPeople}
            participantVolumes={participantVolumes}
            onParticipantVolumeChange={onParticipantVolumeChange}
            participantColorSeed={localParticipantColorSeed}
            participantGradientPreference={localParticipantGradientPreference}
          />
        </MobilePanel>
      )}
      {isMobile && activePanel === "transcription" && (
        <MobilePanel title="Transcript" onClose={onClosePanel}>
          <TranscriptionPanel transcripts={transcripts} variant="mobile" participantColorSeed={localParticipantColorSeed} participantGradientPreference={localParticipantGradientPreference} />
        </MobilePanel>
      )}
    </>
  );
}
