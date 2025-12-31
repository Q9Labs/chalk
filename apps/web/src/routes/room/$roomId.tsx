import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useRoom,
  useParticipants,
  useMedia,
  useChat,
  useRecording,
  useTranscription,
  useSoundEffects,
  useKeyboardShortcuts,
  createMeetingShortcuts,
  useAnnouncer,
  EndScreen,
  useChalk,

} from "@q9labs/chalk-react";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams() as { roomId: string };
  const navigate = useNavigate();

  const { client, joinRoom, leaveRoom } = useChalk();
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

  const { messages } = useChat();
  const { isRecording, durationSeconds, startRecording, stopRecording } = useRecording();
  const { isTranscribing, transcripts } = useTranscription({ enabled: true });

  useSoundEffects({ enabled: true });
  useAnnouncer({});

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
    <div className="flex flex-col min-h-screen bg-neutral-900 text-white">
      <header className="flex items-center justify-between p-4 bg-neutral-800">
        <h1 className="text-lg font-semibold">Room: {roomId}</h1>
        <div className="flex items-center gap-2">
          {isRecording && (
            <span className="flex items-center gap-1 text-red-500">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              Recording
            </span>
          )}
          <span className="text-sm text-neutral-400">
            {participants.length} participant{participants.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      <main className="flex-1 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {participants.map((participant) => (
            <div
              key={participant.id}
              className="relative aspect-video bg-neutral-800 rounded-lg flex items-center justify-center"
            >
              <div className="text-center">
                <div className="w-16 h-16 bg-neutral-700 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-2xl">{participant.displayName?.[0]?.toUpperCase() || '?'}</span>
                </div>
                <p className="text-sm">{participant.displayName}</p>
                {participant.id === localParticipant?.id && (
                  <span className="text-xs text-neutral-400">(You)</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {messages.length > 0 && (
          <div className="mt-4 p-4 bg-neutral-800 rounded-lg max-h-48 overflow-y-auto">
            <h2 className="text-sm font-semibold mb-2">Chat</h2>
            {messages.map((msg) => (
              <div key={msg.id} className="text-sm mb-1">
                <span className="text-primary">{msg.senderName}: </span>
                <span>{msg.content}</span>
              </div>
            ))}
          </div>
        )}

        {isTranscribing && transcripts.length > 0 && (
          <div className="mt-4 p-4 bg-neutral-800 rounded-lg">
            <h2 className="text-sm font-semibold mb-2">Live Transcription</h2>
            <p className="text-sm text-neutral-300">{transcripts[transcripts.length - 1]?.text}</p>
          </div>
        )}
      </main>

      <footer className="flex items-center justify-center gap-4 p-4 bg-neutral-800">
        <button
          type="button"
          onClick={toggleAudio}
          className={`p-3 rounded-full ${isAudioEnabled ? 'bg-neutral-700' : 'bg-red-600'}`}
          title={isAudioEnabled ? 'Mute' : 'Unmute'}
        >
          {isAudioEnabled ? '🎤' : '🔇'}
        </button>
        <button
          type="button"
          onClick={toggleVideo}
          className={`p-3 rounded-full ${isVideoEnabled ? 'bg-neutral-700' : 'bg-red-600'}`}
          title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {isVideoEnabled ? '📹' : '📷'}
        </button>
        <button
          type="button"
          onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
          className={`p-3 rounded-full ${isScreenSharing ? 'bg-primary' : 'bg-neutral-700'}`}
          title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
        >
          🖥️
        </button>
        <button
          type="button"
          onClick={() => isRecording ? stopRecording() : startRecording()}
          className={`p-3 rounded-full ${isRecording ? 'bg-red-600' : 'bg-neutral-700'}`}
          title={isRecording ? 'Stop recording' : 'Start recording'}
        >
          ⏺️
        </button>
        <button
          type="button"
          onClick={handleLeave}
          className="px-4 py-2 bg-red-600 rounded-full hover:bg-red-700"
        >
          Leave
        </button>
      </footer>
    </div>
  );
}
