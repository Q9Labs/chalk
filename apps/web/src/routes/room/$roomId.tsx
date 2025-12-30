import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useRoom,
  useParticipants,
  useMedia,
  useSoundEffects,
  useKeyboardShortcuts,
  createMeetingShortcuts,
  useAnnouncer,
  EndScreen,
  useChalk,
  VideoTile,
  ControlButton,
  ChatPanel,
  useChat,
  useRecording,
  PreJoinLobby,
  type JoinSettings
} from "@q9labs/chalk-react";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { 
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff, 
  MoreHorizontal, PhoneOff, Hand, MessageSquare, 
  Info, ThumbsUp, LayoutTemplate, X
} from 'lucide-react';

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams() as { roomId: string };
  const navigate = useNavigate();

  // SDK Hooks
  const { joinRoom, leaveRoom } = useChalk();
  const { isConnected } = useRoom();
  const { participants, localParticipant, activeSpeaker } = useParticipants();
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
  const { isRecording, durationSeconds: recordingDuration, startRecording, stopRecording } = useRecording();

  // Effects
  useSoundEffects({ enabled: true });
  useAnnouncer({});

  // Local State
  const [hasJoined, setHasJoined] = useState(false);
  const [showEndScreen, setShowEndScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  
  // UI State
  const [activePanel, setActivePanel] = useState<'chat' | 'info' | null>(null);
  const [layout, setLayout] = useState<'grid' | 'spotlight'>('grid');
  const [isHandRaised, setIsHandRaised] = useState(false);
  
  // Session Timer
  const [sessionSeconds, setSessionSeconds] = useState(0); 

  useEffect(() => {
    if (hasJoined) {
        const timer = setInterval(() => setSessionSeconds(s => s + 1), 1000);
        return () => clearInterval(timer);
    }
  }, [hasJoined]);

  const joinAttempted = useRef(false);

  // Local Preview Tracks & Devices for Lobby
  const [previewVideoTrack, setPreviewVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [previewAudioTrack, setPreviewAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>("");
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>("");
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>("");

  // Load Devices
  useEffect(() => {
    if (hasJoined) return;

    const loadDevices = async () => {
      try {
        // Request permissions first to ensure we get labels
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        stream.getTracks().forEach(t => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
        setAudioInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setAudioOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
        
        if (!selectedVideoDevice) {
            const vid = devices.find(d => d.kind === 'videoinput');
            if (vid) setSelectedVideoDevice(vid.deviceId);
        }
        if (!selectedAudioInput) {
            const mic = devices.find(d => d.kind === 'audioinput');
            if (mic) setSelectedAudioInput(mic.deviceId);
        }
        if (!selectedAudioOutput) {
            const spk = devices.find(d => d.kind === 'audiooutput');
            if (spk) setSelectedAudioOutput(spk.deviceId);
        }
      } catch (e) {
        console.error("Failed to load devices", e);
      }
    };
    loadDevices();
    
    // Listen for device changes
    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [hasJoined]);

  // Initialize Preview Stream for Lobby
  useEffect(() => {
    if (hasJoined) {
       if (previewStream) {
         previewStream.getTracks().forEach(t => t.stop());
         setPreviewStream(null);
         setPreviewVideoTrack(null);
         setPreviewAudioTrack(null);
       }
       return;
    }

    let mounted = true;
    
    const startPreview = async () => {
        try {
            if (previewStream) {
                previewStream.getTracks().forEach(t => t.stop());
            }

            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: selectedVideoDevice ? { deviceId: { exact: selectedVideoDevice } } : true, 
                audio: selectedAudioInput ? { deviceId: { exact: selectedAudioInput } } : true 
            });
            
            if (mounted) {
                setPreviewStream(stream);
                setPreviewVideoTrack(stream.getVideoTracks()[0] || null);
                setPreviewAudioTrack(stream.getAudioTracks()[0] || null);
            } else {
                stream.getTracks().forEach(t => t.stop());
            }
        } catch (err) {
            console.error("Failed to get local stream", err);
        }
    };

    if (selectedVideoDevice || selectedAudioInput) {
        startPreview();
    }

    return () => {
        mounted = false;
    };
  }, [hasJoined, selectedVideoDevice, selectedAudioInput]);

  // Clean up preview on unmount
  useEffect(() => {
      return () => {
          if (previewStream) {
              previewStream.getTracks().forEach(t => t.stop());
          }
      };
  }, [previewStream]);


  const handleJoinRoom = async (settings: JoinSettings) => {
    if (joinAttempted.current) return;
    joinAttempted.current = true;
    setIsJoining(true);

    try {
        sessionStorage.setItem('chalk_display_name', settings.displayName);
        
        // Stop preview tracks before joining so they don't conflict
        if (previewStream) {
            previewStream.getTracks().forEach(t => t.stop());
            setPreviewStream(null);
        }

        // Join initially with no media to prevent default device capture if specific one needed
        // We will enable media with specific devices after joining
        const room = await joinRoom(roomId, {
          displayName: settings.displayName,
          video: false,
          audio: false,
        });

        // Apply device selection and enable media
        if (settings.videoEnabled) {
            if (settings.selectedVideoDevice) {
                await room.selectCamera(settings.selectedVideoDevice);
            } else {
                await room.toggleVideo();
            }
        }

        if (settings.audioEnabled) {
            if (settings.selectedAudioInput) {
                await room.selectMicrophone(settings.selectedAudioInput);
            } else {
                await room.toggleAudio();
            }
        }

        setHasJoined(true);
        setError(null);
      } catch (err) {
        console.error("Failed to join:", err);
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        if (errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
          setError("API demo mode is disabled. Set CHALK_ENABLE_DEMO=true in apps/api/.env and restart the API server.");
        } else if (errorMessage.includes("fetch") || errorMessage.includes("network")) {
          setError("Cannot connect to API server. Make sure the API is running on http://localhost:8080");
        } else {
          setError(errorMessage);
        }
        joinAttempted.current = false;
      } finally {
        setIsJoining(false);
      }
  };

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
    enabled: hasJoined
  });

  const formatDuration = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}hr ${minutes}min ${seconds}s`;
    return `${minutes}min ${seconds}s`;
  };

  const mapToVideoTileParticipant = (p: typeof participants[0]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remoteHandRaised = 'isHandRaised' in p ? (p as any).isHandRaised : undefined;
    
    return {
      ...p,
      connectionQuality: (p.connectionQuality && p.connectionQuality > 0) ? (p.connectionQuality as 1 | 2 | 3 | 4) : undefined,
      isHandRaised: p.id === localParticipant?.id ? isHandRaised : remoteHandRaised,
      isSpeaking: p.id === activeSpeaker?.id || p.isSpeaking,
    };
  };

  // --------------------------------------------------------------------------------
  // LOBBY VIEW
  // --------------------------------------------------------------------------------
  if (!hasJoined && !error) {
    return (
        <PreJoinLobby 
            roomName={roomId}
            userName={sessionStorage.getItem('chalk_display_name') || ''}
            onJoin={handleJoinRoom}
            onCancel={() => navigate({ to: "/" })}
            videoTrack={previewVideoTrack}
            audioTrack={previewAudioTrack}
            videoDevices={videoDevices}
            audioInputDevices={audioInputDevices}
            audioOutputDevices={audioOutputDevices}
            selectedVideoDevice={selectedVideoDevice}
            selectedAudioInput={selectedAudioInput}
            selectedAudioOutput={selectedAudioOutput}
            onVideoDeviceChange={setSelectedVideoDevice}
            onAudioInputChange={setSelectedAudioInput}
            onAudioOutputChange={setSelectedAudioOutput}
            isLoading={isJoining}
            initialVideoEnabled={true}
            initialAudioEnabled={true}
        />
    );
  }

  // --------------------------------------------------------------------------------
  // ERROR VIEW
  // --------------------------------------------------------------------------------
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1c1c1c] text-white">
        <div className="text-center max-w-lg p-6 bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-2xl">
          <div className="text-red-500 text-4xl mb-4">Connection Error</div>
          <p className="text-red-200 mb-6">{error}</p>
          <div className="space-x-4">
            <button
              type="button"
              onClick={() => {
                setError(null);
                joinAttempted.current = false;
              }}
              className="px-6 py-2 bg-primary text-white rounded-full hover:bg-primary/80 transition-all"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: "/demo" })}
              className="px-6 py-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition-all"
            >
              Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (showEndScreen) {
    return (
      <EndScreen
        roomName={roomId}
        duration={sessionSeconds}
        participantCount={participants.length}
        onRejoin={() => {
            setShowEndScreen(false);
            setHasJoined(false);
            joinAttempted.current = false;
        }}
        onGoHome={() => navigate({ to: "/" })}
      />
    );
  }

  if (!isConnected || !localParticipant) {
     return (
        <div className="flex items-center justify-center min-h-screen bg-[#1c1c1c] text-white">
           <div className="flex flex-col items-center p-8 rounded-3xl bg-black/40 backdrop-blur-xl border border-white/5">
              <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full mb-4"></div>
              <p className="text-white/80 font-medium">Joining {roomId}...</p>
           </div>
        </div>
     );
  }

  // Layout Logic
  const visibleParticipants = layout === 'grid' ? participants : participants.slice(0, 6);
  const mainParticipant = participants.find(p => p.id === activeSpeaker?.id) || participants[0] || localParticipant;

  return (
    <div className="flex flex-col h-screen bg-[#0D0D0D] font-sans text-white overflow-hidden relative">
      
      {/* Content Area */}
      <div className="flex-1 flex relative min-h-0 p-4 gap-4">
         
         {/* Video Grid */}
         <div className="flex-1 flex flex-col min-w-0 transition-all duration-500 ease-in-out">
            <div className={`w-full h-full grid gap-4 transition-all duration-500 ${
                layout === 'spotlight' 
                  ? 'grid-cols-1' 
                  : participants.length <= 1 ? 'grid-cols-1'
                  : participants.length <= 4 ? 'grid-cols-2'
                  : 'grid-cols-3'
            }`}>
                {layout === 'spotlight' ? (
                   // Spotlight View
                   <div className="relative w-full h-full rounded-[32px] overflow-hidden border border-white/80 bg-gradient-to-b from-[#2e0046] to-[#0a0a0a] shadow-2xl">
                      <VideoTile 
                          participant={mapToVideoTileParticipant(mainParticipant)}
                          className="w-full h-full bg-transparent"
                          showStatus={false}
                          showName={false}
                      />
                      <div className="absolute bottom-8 left-8 px-5 py-3 bg-white/5 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
                           <h3 className="text-white font-bold text-xl tracking-wide">{mainParticipant.displayName}</h3>
                      </div>
                   </div>
                ) : (
                   // Grid View
                   visibleParticipants.map(p => (
                      <div key={p.id} className="relative w-full h-full rounded-[32px] overflow-hidden border border-white/10 bg-gradient-to-b from-[#2e0046] to-[#0a0a0a] shadow-xl group">
                          <VideoTile 
                              participant={mapToVideoTileParticipant(p)}
                              className="w-full h-full bg-transparent"
                              showStatus={false}
                              showName={false}
                          />
                          <div className="absolute bottom-6 left-6 transition-transform duration-300 group-hover:scale-105">
                               <div className="px-4 py-2 bg-white/5 backdrop-blur-2xl rounded-xl border border-white/10 flex items-center gap-2 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
                                  {p.isSpeaking && <Mic size={14} className="text-green-400" />}
                                  <h3 className="text-white font-bold text-lg tracking-wide">{p.displayName} {p.id === localParticipant.id && '(You)'}</h3>
                               </div>
                          </div>
                      </div>
                   ))
                )}
            </div>
         </div>

         {/* Side Panels (Chat / Info) - Liquid Glass Style */}
         {activePanel && (
            <div className="w-80 sm:w-96 flex-shrink-0 animate-in slide-in-from-right duration-300 relative z-20">
               {activePanel === 'chat' && (
                  <div className="h-full rounded-[32px] overflow-hidden border border-white/10 shadow-2xl ring-1 ring-white/5">
                     <ChatPanel
                        messages={messages}
                        onSendMessage={(message) => sendMessage(message)}
                        className="h-full border-none"
                     />
                  </div>
               )}
               {activePanel === 'info' && (
                  <div className="h-full rounded-[32px] p-6 border border-white/10 bg-black/40 backdrop-blur-3xl shadow-2xl ring-1 ring-white/5 text-white">
                     <div className="flex items-center justify-between mb-6">
                        <h2 className="text-xl font-bold">Meeting Info</h2>
                        <button onClick={() => setActivePanel(null)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                           <X size={20} />
                        </button>
                     </div>
                     <div className="space-y-4">
                        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
                           <p className="text-sm text-gray-400 mb-1">Room ID</p>
                           <p className="font-mono text-lg select-all text-white/90">{roomId}</p>
                        </div>
                        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
                           <p className="text-sm text-gray-400 mb-1">Duration</p>
                           <p className="font-mono text-lg text-white/90">{formatDuration(sessionSeconds)}</p>
                        </div>
                     </div>
                  </div>
               )}
            </div>
         )}

      </div>

      {/* Bottom Control Bar Area - Fixed Floating Glass */}
      <div className="h-24 flex items-center justify-center px-6 relative z-50">
          <div className="flex items-center  w-full  mx-auto">
              
              {/* Left: Timer */}
              <div className="hidden md:flex items-center gap-3 bg-white/5 backdrop-blur-3xl border border-white/10 rounded-full px-5 py-3 min-w-[160px] justify-center shadow-[0_8px_32px_0_rgba(0,0,0,0.36)] ring-1 ring-white/5 transition-transform hover:scale-105 cursor-pointer" onClick={() => isRecording ? stopRecording() : startRecording()}>
                  <div className={`w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${isRecording ? 'bg-red-500 text-red-500 animate-pulse' : 'bg-green-500 text-green-500'}`} />
                  <span className="text-sm font-semibold tracking-wide text-white/90">
                      {isRecording ? formatDuration(recordingDuration) : formatDuration(sessionSeconds)}
                  </span>
              </div>

              {/* Center: Main Controls */}
              <div className="flex items-center gap-2 md:gap-4 bg-white/3 backdrop-blur-3xl border border-white/10 rounded-full px-4 md:px-6 py-2 md:py-3 shadow-[0_8px_32px_0_rgba(0,0,0,0.36)] mx-auto ring-1 ring-white/5 transition-all hover:bg-white/10 hover:shadow-[0_8px_40px_0_rgba(0,0,0,0.45)]">
                    <ControlButton 
                        icon={isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                        onClick={toggleAudio}
                        className={`transition-all duration-300 ${!isAudioEnabled ? 'bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label={isAudioEnabled ? "Mute" : "Unmute"}
                    />
                    <ControlButton 
                        icon={isVideoEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                        onClick={toggleVideo}
                        className={`transition-all duration-300 ${!isVideoEnabled ? 'bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label={isVideoEnabled ? "Stop Video" : "Start Video"}
                    />
                    <ControlButton 
                        icon={isScreenSharing ? <MonitorOff size={20} /> : <Monitor size={20} />}
                        onClick={isScreenSharing ? stopScreenShare : startScreenShare}
                        className={`transition-all duration-300 ${isScreenSharing ? 'bg-purple-500/80 text-white shadow-[0_0_15px_rgba(168,85,247,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label="Share Screen"
                    />
                    <div className="w-px h-8 bg-white/10 mx-1" />
                    <ControlButton 
                        icon={<LayoutTemplate size={20} />}
                        onClick={() => setLayout(l => l === 'grid' ? 'spotlight' : 'grid')} 
                        className={`transition-all duration-300 ${layout === 'spotlight' ? 'bg-white/20' : 'bg-transparent hover:bg-white/10'} text-white`}
                        size="md"
                        label={layout === 'grid' ? "Spotlight" : "Grid"}
                    />
                    <ControlButton 
                        icon={<Hand size={20} />}
                        onClick={() => setIsHandRaised(!isHandRaised)} 
                        className={`transition-all duration-300 ${isHandRaised ? 'bg-yellow-500/80 text-white shadow-[0_0_15px_rgba(234,179,8,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label="Raise Hand"
                    />
                    <ControlButton 
                        icon={<MoreHorizontal size={20} />}
                        onClick={() => {}} 
                        className="bg-transparent hover:bg-white/10 text-white transition-all duration-300"
                        size="md"
                        label="More"
                    />
                    <ControlButton 
                        icon={<PhoneOff size={20} />}
                        onClick={handleLeave}
                        className="bg-red-500/90 text-white hover:bg-red-600 shadow-[0_4px_15px_rgba(239,68,68,0.4)] ml-2 backdrop-blur-md border border-red-400/20"
                        size="md"
                        label="Leave"
                        danger
                    />
              </div>

              {/* Right: Secondary Actions */}
              <div className="hidden md:flex items-center gap-2">
                  <ControlButton 
                      icon={<Info size={20} />} 
                      onClick={() => setActivePanel(p => p === 'info' ? null : 'info')}
                      className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === 'info' ? 'bg-white/20' : 'bg-white/5 hover:bg-white/10'}`}
                      size="sm"
                      label="Info"
                  />
                  <ControlButton 
                      icon={<MessageSquare size={20} />} 
                      onClick={() => setActivePanel(p => p === 'chat' ? null : 'chat')}
                      className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === 'chat' ? 'bg-white/20' : 'bg-white/5 hover:bg-white/10'}`}
                      size="sm"
                      label="Chat"
                  />
                  <ControlButton 
                      icon={<ThumbsUp size={20} />} 
                      onClick={() => {}}
                      className="bg-white/5 backdrop-blur-xl border border-white/10 hover:bg-white/10 text-yellow-500 rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)]"
                      size="sm"
                      label="Reactions"
                  />
              </div>
          </div>
      </div>
    </div>
  );
};

export default RoomPage;
