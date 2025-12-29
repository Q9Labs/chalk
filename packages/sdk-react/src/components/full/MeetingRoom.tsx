import React, { useState, useEffect, useMemo, memo } from 'react';
import { 
  VideoGrid, 
  ScreenShareView, 
  MeetingHeader, 
  ControlBar, 
  ParticipantList, 
  ChatPanel, 
  TranscriptionPanel, 
  NotificationStack, 
  ConnectionLostOverlay, 
  ReactionPicker
} from '../composite';
import { cn } from '../../utils/cn';
import { GuidedTour } from './GuidedTour';

export interface Participant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  connectionQuality?: 1 | 2 | 3 | 4;
  avatarUrl?: string;
  videoTrack?: MediaStreamTrack | null;
  role?: 'host' | 'co-host' | 'participant';
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  isLocal?: boolean;
}

export interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
}

export interface MeetingRoomProps {
  roomName: string;
  localParticipant: Participant;
  participants: Participant[];
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isHandRaised?: boolean;
  isRecording?: boolean;
  recordingDuration?: number;
  canRecord?: boolean;
  isTranscribing?: boolean;
  transcripts?: TranscriptEntry[];
  chatMessages?: ChatMessage[];
  onSendMessage?: (content: string) => void;
  enableChat?: boolean;
  enableRecording?: boolean;
  enableScreenShare?: boolean;
  enableHandRaise?: boolean;
  enableReactions?: boolean;
  enableTranscription?: boolean;
  enableTour?: boolean;
  defaultLayout?: 'grid' | 'spotlight' | 'sidebar';
  defaultChatOpen?: boolean;
  defaultParticipantsOpen?: boolean;
  defaultTranscriptionOpen?: boolean;
  showTourOnFirstVisit?: boolean;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onToggleRecording?: () => void;
  onToggleHandRaise?: () => void;
  onSendReaction?: (emoji: string) => void;
  onToggleTranscription?: () => void;
  onLeave?: () => void;
  onTourComplete?: () => void;
  connectionStatus?: 'connected' | 'connecting' | 'reconnecting' | 'failed';
  onRetryConnection?: () => void;
  theme?: 'light' | 'dark' | 'system';
  className?: string;
}

const MeetingRoomBase: React.FC<MeetingRoomProps> = ({
  roomName,
  localParticipant,
  participants,
  isMuted = false,
  isVideoEnabled = false,
  isScreenSharing = false,
  isHandRaised = false,
  isRecording = false,
  recordingDuration = 0,
  canRecord = false,
  isTranscribing = false,
  transcripts = [],
  chatMessages = [],
  onSendMessage,
  enableChat = true,
  enableRecording = true,
  enableScreenShare = true,
  enableHandRaise = true,
  enableReactions = true,
  enableTranscription = true,
  enableTour = true,
  defaultLayout = 'grid',
  defaultChatOpen = false,
  defaultParticipantsOpen = false,
  defaultTranscriptionOpen = false,
  showTourOnFirstVisit = true,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  onToggleRecording,
  onToggleHandRaise,
  onSendReaction,
  onToggleTranscription,
  onLeave,
  onTourComplete,
  connectionStatus = 'connected',
  onRetryConnection,
  theme = 'system',
  className,
}) => {
  const [activePanel, setActivePanel] = useState<'chat' | 'participants' | 'transcription' | null>(() => {
    if (defaultChatOpen) return 'chat';
    if (defaultParticipantsOpen) return 'participants';
    if (defaultTranscriptionOpen) return 'transcription';
    return null;
  });

  const [layout, setLayout] = useState<'grid' | 'spotlight' | 'sidebar'>(defaultLayout || 'grid');
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
  const [showTour, setShowTour] = useState(false);
  
  useEffect(() => {
    if (enableTour && showTourOnFirstVisit) {
      const hasSeenTour = localStorage.getItem('chalk-tour-completed');
      if (!hasSeenTour) {
        setShowTour(true);
      }
    }
  }, [enableTour, showTourOnFirstVisit]);

  const togglePanel = (panel: 'chat' | 'participants' | 'transcription') => {
    setActivePanel(current => current === panel ? null : panel);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'm':
          onToggleMute?.();
          break;
        case 'v':
          onToggleVideo?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleMute, onToggleVideo]);
  
  const screenSharer = participants.find(p => p.isScreenSharing);
  const showScreenShare = !!screenSharer;
  
  const allParticipants = useMemo(() => {
    return [localParticipant, ...participants];
  }, [localParticipant, participants]);

  const handleTourComplete = () => {
    setShowTour(false);
    localStorage.setItem('chalk-tour-completed', 'true');
    onTourComplete?.();
  };

  return (
    <div 
      className={cn(
        "flex flex-col h-screen w-full bg-neutral-900 text-white overflow-hidden",
        className
      )}
      data-chalk-theme={theme}
    >
      <div className="flex-none z-10">
        <MeetingHeader
          roomName={roomName}
          isRecording={isRecording}
          duration={recordingDuration}
          isTranscribing={isTranscribing}
          layout={layout}
          onLayoutChange={setLayout}
        />
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        <div 
          className="flex-1 relative bg-neutral-950 flex items-center justify-center p-4"
          data-tour="video-grid"
        >
          {showScreenShare ? (
            <ScreenShareView
              screenShareTrack={screenSharer?.videoTrack || new MediaStreamTrack()}
              sharedByName={screenSharer?.displayName || 'Unknown'}
              participants={allParticipants}
            />
          ) : (
            <VideoGrid
              participants={allParticipants}
              layout={layout}
            />
          )}
          
          <div className="absolute top-4 right-4 z-50">
            <NotificationStack 
              notifications={[]} 
              onDismiss={() => {}}
            />
          </div>
        </div>

        {activePanel && (
          <div className="w-80 border-l border-neutral-800 bg-neutral-900 flex flex-col transition-all duration-300 ease-in-out">
            {activePanel === 'chat' && (
              <ChatPanel
                messages={chatMessages}
                onSendMessage={onSendMessage || (() => {})}
                onClose={() => setActivePanel(null)}
              />
            )}
            {activePanel === 'participants' && (
              <ParticipantList
                participants={allParticipants}
                onClose={() => setActivePanel(null)}
              />
            )}
            {activePanel === 'transcription' && (
              <TranscriptionPanel
                transcripts={transcripts}
                onClose={() => setActivePanel(null)}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex-none z-10 relative">
        <ControlBar
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          isScreenSharing={isScreenSharing}
          isHandRaised={isHandRaised}
          isRecording={isRecording}
          onToggleMute={onToggleMute}
          onToggleVideo={onToggleVideo}
          onToggleScreenShare={enableScreenShare ? onToggleScreenShare : undefined}
          onToggleRecording={enableRecording && canRecord ? onToggleRecording : undefined}
          onToggleHandRaise={enableHandRaise ? onToggleHandRaise : undefined}
          onLeave={onLeave}
          onToggleChat={enableChat ? () => togglePanel('chat') : undefined}
          onToggleParticipants={() => togglePanel('participants')}
          onToggleTranscription={enableTranscription ? () => {
            togglePanel('transcription');
            onToggleTranscription?.();
          } : undefined}
        />
        
        {enableReactions && (
          <div className="absolute right-4 bottom-24 z-50">
             <button
                className="p-3 rounded-full bg-neutral-800 hover:bg-neutral-700 text-white transition-colors shadow-lg"
                onClick={() => setIsReactionPickerOpen(!isReactionPickerOpen)}
                data-tour="reactions-button"
                aria-label="Reactions"
             >
                 <span className="text-xl">😀</span>
             </button>
             <ReactionPicker 
               isOpen={isReactionPickerOpen}
               onClose={() => setIsReactionPickerOpen(false)}
               onSelect={(emoji) => {
                 onSendReaction?.(emoji);
                 setIsReactionPickerOpen(false);
               }}
               position="top"
               className="right-0 left-auto translate-x-0 bottom-full mb-2"
             />
          </div>
        )}
      </div>

      <ConnectionLostOverlay
        isVisible={connectionStatus === 'reconnecting' || connectionStatus === 'failed'}
        status={connectionStatus === 'reconnecting' ? 'reconnecting' : 'failed'}
        onRetry={onRetryConnection}
      />

      {enableTour && (
        <GuidedTour
          isOpen={showTour}
          onComplete={handleTourComplete}
          onSkip={handleTourComplete}
          showSkip={true}
        />
      )}
    </div>
  );
};

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = 'MeetingRoom';

export default MeetingRoom;
