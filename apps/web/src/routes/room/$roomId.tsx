import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { 
  MeetingRoom, 
  useRoom, 
  useParticipants, 
  useMedia, 
  useChat, 
  useRecording, 
  useTranscription, 
  useTour, 
  useSoundEffects,
  useKeyboardShortcuts,
  createMeetingShortcuts,
  useAnnouncer,
  EndScreen,
  useChalk,
  DEFAULT_MEETING_TOUR_STEPS
} from "@q9labs/chalk-react";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";

// @ts-expect-error - Route type generation might lag
export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams() as { roomId: string };
  const navigate = useNavigate();
  
  const { client, joinRoom, leaveRoom, connectionStatus } = useChalk();
  const { isConnected } = useRoom();
  const { participants, localParticipant } = useParticipants();
  const { 
    isVideoEnabled, 
    isAudioEnabled, 
    isScreenSharing, 
    toggleVideo, 
    toggleAudio, 
    startScreenShare,
    stopScreenShare
  } = useMedia();
  
  const { messages, sendMessage } = useChat();
  const { isRecording, durationSeconds, startRecording, stopRecording } = useRecording();
  const { isTranscribing, transcripts, setEnabled: setTranscriptionEnabled } = useTranscription({ enabled: true });
  
  useSoundEffects({ enabled: true });
  useAnnouncer({});
  
  const tour = useTour({
    steps: DEFAULT_MEETING_TOUR_STEPS,
    onComplete: () => console.log("Tour completed"),
  });

  const [hasJoined, setHasJoined] = useState(false);
  const [showEndScreen, setShowEndScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinAttempted = useRef(false);

  useEffect(() => {
    // Wait for client to be initialized and only attempt once
    if (!client || joinAttempted.current || isConnected || hasJoined) {
      return;
    }
    
    joinAttempted.current = true;
    
    const init = async () => {
      try {
        const displayName = sessionStorage.getItem('chalk_display_name') || "Demo User"; 
        const videoEnabled = sessionStorage.getItem('chalk_video_enabled') !== 'false';
        const audioEnabled = sessionStorage.getItem('chalk_audio_enabled') !== 'false';
        
        await joinRoom(roomId, {
          displayName,
          video: videoEnabled,
          audio: audioEnabled,
        });
        setHasJoined(true);
        setError(null);
      } catch (err) {
        console.error("Failed to join:", err);
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        
        // Provide helpful error messages
        if (errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
          setError("API demo mode is disabled. Set CHALK_ENABLE_DEMO=true in apps/api/.env and restart the API server.");
        } else if (errorMessage.includes("fetch") || errorMessage.includes("network")) {
          setError("Cannot connect to API server. Make sure the API is running on http://localhost:8080");
        } else {
          setError(errorMessage);
        }
      }
    };
    init();
  }, [client, roomId, isConnected, hasJoined, joinRoom]);

  const handleLeave = useCallback(async () => {
    await leaveRoom();
    setShowEndScreen(true);
  }, [leaveRoom]);

  const shortcuts = useMemo(() => createMeetingShortcuts({
    onToggleMute: toggleAudio,
    onToggleVideo: toggleVideo,
    onToggleScreenShare: () => isScreenSharing ? stopScreenShare() : startScreenShare(),
    onLeave: handleLeave,
  }), [toggleAudio, toggleVideo, isScreenSharing, stopScreenShare, startScreenShare, handleLeave]);

  useKeyboardShortcuts({
    shortcuts,
    enabled: true
  });

  if (showEndScreen) {
    return (
      <EndScreen 
        roomName={roomId}
        duration={durationSeconds} 
        participantCount={participants.length}
        onRejoin={() => {
            setShowEndScreen(false);
            setHasJoined(false);
        }}
        onGoHome={() => navigate({ to: "/" })}
      />
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-neutral-900 text-white">
        <div className="text-center max-w-lg p-6">
          <div className="text-red-500 text-4xl mb-4">Connection Error</div>
          <p className="text-red-300 mb-6">{error}</p>
          <div className="space-x-4">
            <button
              type="button"
              onClick={() => {
                setError(null);
                joinAttempted.current = false;
              }}
              className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/80"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: "/demo" })}
              className="px-4 py-2 bg-neutral-700 text-white rounded hover:bg-neutral-600"
            >
              Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isConnected || !localParticipant) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-neutral-900 text-white">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"></div>
          <p>Connecting to {roomId}...</p>
        </div>
      </div>
    );
  }
  
  return (
    <MeetingRoom
      roomName={roomId}
      // @ts-expect-error - Types might slightly mismatch in dev
      localParticipant={localParticipant}
      // @ts-expect-error - Types might slightly mismatch in dev
      participants={participants}
      isMuted={!isAudioEnabled}
      isVideoEnabled={isVideoEnabled}
      isScreenSharing={isScreenSharing}
      isRecording={isRecording}
      recordingDuration={durationSeconds}
      isTranscribing={isTranscribing}
      transcripts={transcripts}
      chatMessages={messages}
      onSendMessage={sendMessage}
      onToggleMute={toggleAudio}
      onToggleVideo={toggleVideo}
      onToggleScreenShare={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
      onToggleRecording={isRecording ? stopRecording : startRecording}
      onToggleTranscription={() => setTranscriptionEnabled(!isTranscribing)}
      onLeave={handleLeave}
      // @ts-expect-error - Connection status string vs enum mismatch
      connectionStatus={connectionStatus}
      onRetryConnection={() => window.location.reload()}
      enableTour={true}
      showTourOnFirstVisit={true}
      onTourComplete={tour.complete}
    />
  );
}
