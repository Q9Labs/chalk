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
  type JoinSettings,
  ParticipantList,
  ReactionPicker,
  ReactionBubble,
  GuidedTour,
  NotificationStack,
  type Notification,
} from "@q9labs/chalk-react";
import type { Reaction } from "@q9labs/chalk-core";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff,
  MoreHorizontal, PhoneOff, Hand, MessageSquare,
  Info, ThumbsUp, LayoutTemplate, X, Users, Circle, Square, HelpCircle
} from 'lucide-react';

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams() as { roomId: string };
  const navigate = useNavigate();

  // SDK Hooks
  const { joinRoom, leaveRoom, removeParticipant } = useChalk();
  const { room, isConnected } = useRoom();
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

  // Effects - auto-subscribe plays sounds on room events
  const { playClick, playHandRaise, playRecordingStart, playRecordingStop } = useSoundEffects({ enabled: true, autoSubscribe: true });
  useAnnouncer({});

  // Local State
  const [hasJoined, setHasJoined] = useState(false);
  const [showEndScreen, setShowEndScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  
  // UI State
  const [activePanel, setActivePanel] = useState<'chat' | 'info' | 'participants' | null>(null);
  const [layout, setLayout] = useState<'grid' | 'spotlight'>('grid');
  const [isHandRaised, setIsHandRaised] = useState(false);

  // Reactions State
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
  const [activeReactions, setActiveReactions] = useState<Array<{ id: string; emoji: string; participantName: string }>>([]);

  // Guided Tour State
  const [showTour, setShowTour] = useState(() => {
    return !localStorage.getItem('chalk_tour_completed');
  });

  // Notifications State
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Unread Messages State
  const [unreadCount, setUnreadCount] = useState(0);
  const lastMessageCountRef = useRef(0);
  
  // Session Timer
  const [sessionSeconds, setSessionSeconds] = useState(0); 

  useEffect(() => {
    if (hasJoined) {
        const timer = setInterval(() => setSessionSeconds(s => s + 1), 1000);
        return () => clearInterval(timer);
    }
  }, [hasJoined]);

  // Listen to reaction events from the room
  useEffect(() => {
    if (!room) return;

    const handleReaction = (reaction: Reaction) => {
      const id = `${reaction.participantId}-${Date.now()}`;
      setActiveReactions(prev => [...prev, { id, emoji: reaction.emoji, participantName: reaction.participantName }]);

      // Auto-remove after animation completes
      setTimeout(() => {
        setActiveReactions(prev => prev.filter(r => r.id !== id));
      }, 2500);
    };

    room.on('reaction', handleReaction);
    return () => {
      room.off('reaction', handleReaction);
    };
  }, [room]);

  // Listen to hand raise events
  useEffect(() => {
    if (!room) return;

    const handleHandRaised = (data: { participantId: string }) => {
      if (data.participantId !== localParticipant?.id) {
        const participant = participants.find(p => p.id === data.participantId);
        const name = participant?.displayName || 'Someone';
        const id = `notif-${Date.now()}`;
        setNotifications(prev => [...prev, { id, message: `${name} raised their hand`, type: 'info' as const, duration: 4000 }]);
      }
    };

    room.on('hand-raised', handleHandRaised);
    return () => {
      room.off('hand-raised', handleHandRaised);
    };
  }, [room, localParticipant?.id, participants]);

  // Track new messages for unread badge and notifications
  useEffect(() => {
    const currentCount = messages.length;
    const previousCount = lastMessageCountRef.current;

    if (currentCount > previousCount && previousCount > 0) {
      const newMessages = messages.slice(previousCount);

      for (const msg of newMessages) {
        // Only notify for messages from others
        if (msg.senderId !== localParticipant?.id) {
          // If chat panel is closed, increment unread count
          if (activePanel !== 'chat') {
            setUnreadCount(prev => prev + 1);

            // Show notification for new message
            const id = `msg-${Date.now()}`;
            setNotifications(prev => [...prev, {
              id,
              message: `${msg.senderName}: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? '...' : ''}`,
              type: 'info' as const,
              duration: 4000
            }]);
          }
        }
      }
    }

    lastMessageCountRef.current = currentCount;
  }, [messages, activePanel, localParticipant?.id]);

  // Clear unread count when opening chat
  useEffect(() => {
    if (activePanel === 'chat') {
      setUnreadCount(0);
    }
  }, [activePanel]);

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

  // Send reaction via SDK
  const handleSendReaction = useCallback((emoji: string) => {
    if (room) {
      room.sendReaction(emoji as any);
      // Show own reaction locally
      const id = `local-${Date.now()}`;
      setActiveReactions(prev => [...prev, { id, emoji, participantName: 'You' }]);
      setTimeout(() => {
        setActiveReactions(prev => prev.filter(r => r.id !== id));
      }, 2500);
    }
    setIsReactionPickerOpen(false);
  }, [room]);

  // Toggle hand raise via SDK
  const handleHandRaise = useCallback(() => {
    if (room) {
      if (isHandRaised) {
        room.lowerHand();
      } else {
        room.raiseHand();
        playHandRaise();
      }
      setIsHandRaised(!isHandRaised);
    }
  }, [room, isHandRaised, playHandRaise]);

  // Notification helpers
  const addNotification = useCallback((message: string, type: Notification['type'] = 'info') => {
    const id = `notif-${Date.now()}`;
    setNotifications(prev => [...prev, { id, message, type, duration: 4000 }]);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // Participant management handlers
  const handleRemoveParticipant = useCallback(async (participantId: string) => {
    console.log('[Chalk] Attempting to remove participant:', participantId);
    try {
      await removeParticipant(participantId);
      addNotification('Participant removed', 'success');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Chalk] Failed to remove participant:', { participantId, error: errorMsg, err });
      addNotification(`Failed: ${errorMsg}`, 'error');
    }
  }, [removeParticipant, addNotification]);

  // Tour completion handler
  const handleTourComplete = useCallback(() => {
    localStorage.setItem('chalk_tour_completed', 'true');
    setShowTour(false);
  }, []);

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
    return {
      ...p,
      connectionQuality: (p.connectionQuality && p.connectionQuality > 0) ? (p.connectionQuality as 1 | 2 | 3 | 4) : undefined,
      // For local participant use our local state, for remote use SDK's handRaised property (real-time from WebSocket)
      isHandRaised: p.id === localParticipant?.id ? isHandRaised : p.handRaised,
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

  // Screen share detection
  const screenSharer = participants.find(p => p.isScreenSharing && p.screenShareTrack);
  const showScreenShare = !!screenSharer;

  return (
    <div className="flex flex-col h-screen bg-[#0D0D0D] font-sans text-white overflow-hidden relative">
      
      {/* Content Area */}
      <div className="flex-1 flex relative min-h-0 p-4 gap-4">
         
         {/* Video Grid */}
         <div className="flex-1 flex flex-col min-w-0 transition-all duration-500 ease-in-out" data-tour="video-grid">
            <div className={`w-full h-full grid gap-4 transition-all duration-500 ${
                layout === 'spotlight' 
                  ? 'grid-cols-1' 
                  : participants.length <= 1 ? 'grid-cols-1'
                  : participants.length <= 2 ? 'grid-cols-2'
                  : 'grid-cols-3'
            }`}>
                {showScreenShare && screenSharer ? (
                   // Screen Share View (takes priority)
                   <div className="relative w-full h-full rounded-[32px] overflow-hidden border border-green-500/50 bg-gradient-to-b from-[#0a2e0a] to-[#0a0a0a] shadow-2xl">
                      <VideoTile
                          participant={mapToVideoTileParticipant(screenSharer)}
                          videoTrack={screenSharer.screenShareTrack}
                          mirror={false}
                          aspectRatio="16:9"
                          className="w-full h-full bg-transparent"
                          showStatus={false}
                          showName={false}
                      />
                      <div className="absolute bottom-8 left-8 px-5 py-3 bg-green-500/20 backdrop-blur-2xl rounded-2xl border border-green-500/30 shadow-[0_4px_30px_rgba(0,0,0,0.1)] flex items-center gap-2">
                           <Monitor size={18} className="text-green-400" />
                           <h3 className="text-white font-bold text-xl tracking-wide">{screenSharer.displayName}'s screen</h3>
                      </div>
                   </div>
                ) : layout === 'spotlight' ? (
                   // Spotlight View
                   <div className="relative w-full h-full rounded-[32px] overflow-hidden border border-white/80 bg-gradient-to-b from-[#2e0046] to-[#0a0a0a] shadow-2xl">
                      <VideoTile
                          participant={mapToVideoTileParticipant(mainParticipant)}
                          videoTrack={mainParticipant.videoTrack}
                          mirror={mainParticipant.isLocal}
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
                              videoTrack={p.videoTrack}
                              mirror={p.isLocal}
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
               {activePanel === 'participants' && (
                  <div className="h-full rounded-[32px] overflow-hidden border border-white/10 shadow-2xl ring-1 ring-white/5">
                     <ParticipantList
                        participants={participants.map(p => ({
                            id: p.id,
                            displayName: p.displayName,
                            isLocal: p.id === localParticipant?.id,
                            isMuted: p.id === localParticipant?.id ? !isAudioEnabled : !(p as any).isAudioEnabled,
                            role: p.id === localParticipant?.id ? 'host' : 'participant',
                        }))}
                        onClose={() => setActivePanel(null)}
                        onAddPeople={() => {}}
                        onRemoveParticipant={handleRemoveParticipant}
                        canManageParticipants={true}
                        variant="sidebar"
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
                        onClick={() => { playClick(); toggleAudio(); }}
                        className={`transition-all duration-300 ${!isAudioEnabled ? 'bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label={isAudioEnabled ? "Mute" : "Unmute"}
                        data-tour="controls-mic"
                    />
                    <ControlButton
                        icon={isVideoEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                        onClick={() => { playClick(); toggleVideo(); }}
                        className={`transition-all duration-300 ${!isVideoEnabled ? 'bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label={isVideoEnabled ? "Stop Video" : "Start Video"}
                        data-tour="controls-video"
                    />
                    <ControlButton
                        icon={isScreenSharing ? <MonitorOff size={20} /> : <Monitor size={20} />}
                        onClick={() => { playClick(); isScreenSharing ? stopScreenShare() : startScreenShare(); }}
                        className={`transition-all duration-300 ${isScreenSharing ? 'bg-purple-500/80 text-white shadow-[0_0_15px_rgba(168,85,247,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label="Share Screen"
                        data-tour="controls-screenshare"
                    />
                    <div className="w-px h-8 bg-white/10 mx-1" />
                    <ControlButton
                        icon={isRecording ? <Square size={18} fill="currentColor" /> : <Circle size={20} fill="currentColor" />}
                        onClick={() => {
                            if (isRecording) {
                                playRecordingStop();
                                stopRecording();
                            } else {
                                playRecordingStart();
                                startRecording();
                            }
                        }}
                        className={`transition-all duration-300 ${isRecording ? 'bg-red-500/80 text-white hover:bg-red-600 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse' : 'bg-transparent hover:bg-white/10 text-red-400'}`}
                        size="md"
                        label={isRecording ? "Stop Recording" : "Record"}
                    />
                    <ControlButton
                        icon={<LayoutTemplate size={20} />}
                        onClick={() => { playClick(); setLayout(l => l === 'grid' ? 'spotlight' : 'grid'); }}
                        className={`transition-all duration-300 ${layout === 'spotlight' ? 'bg-white/20' : 'bg-transparent hover:bg-white/10'} text-white`}
                        size="md"
                        label={layout === 'grid' ? "Spotlight" : "Grid"}
                    />
                    <ControlButton
                        icon={<Hand size={20} />}
                        onClick={handleHandRaise}
                        className={`transition-all duration-300 ${isHandRaised ? 'bg-yellow-500/80 text-white shadow-[0_0_15px_rgba(234,179,8,0.5)]' : 'bg-transparent hover:bg-white/10 text-white'}`}
                        size="md"
                        label={isHandRaised ? "Lower Hand" : "Raise Hand"}
                        data-tour="controls-hand"
                    />
                    <ControlButton
                        icon={<MoreHorizontal size={20} />}
                        onClick={() => { playClick(); }}
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
                        data-tour="controls-leave"
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
                      icon={<Users size={20} />}
                      onClick={() => setActivePanel(p => p === 'participants' ? null : 'participants')}
                      className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === 'participants' ? 'bg-white/20' : 'bg-white/5 hover:bg-white/10'}`}
                      size="sm"
                      label="People"
                      data-tour="controls-participants"
                  />
                  <div className="relative">
                      <ControlButton
                          icon={<MessageSquare size={20} />}
                          onClick={() => setActivePanel(p => p === 'chat' ? null : 'chat')}
                          className={`backdrop-blur-xl border border-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${activePanel === 'chat' ? 'bg-white/20' : 'bg-white/5 hover:bg-white/10'}`}
                          size="sm"
                          label="Chat"
                          data-tour="controls-chat"
                      />
                      {unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                              {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                      )}
                  </div>
                  <div className="relative">
                      <ControlButton
                          icon={<ThumbsUp size={20} />}
                          onClick={() => setIsReactionPickerOpen(!isReactionPickerOpen)}
                          className={`backdrop-blur-xl border border-white/10 rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)] ${isReactionPickerOpen ? 'bg-white/20 text-yellow-400' : 'bg-white/5 hover:bg-white/10 text-yellow-500'}`}
                          size="sm"
                          label="Reactions"
                          data-tour="reactions-button"
                      />
                      <ReactionPicker
                          isOpen={isReactionPickerOpen}
                          onClose={() => setIsReactionPickerOpen(false)}
                          onSelect={handleSendReaction}
                          position="top"
                      />
                  </div>
                  {/* Help button to restart tour */}
                  <ControlButton
                      icon={<HelpCircle size={20} />}
                      onClick={() => setShowTour(true)}
                      className="bg-white/5 backdrop-blur-xl border border-white/10 hover:bg-white/10 text-white rounded-full w-10 h-10 transition-all duration-300 shadow-[0_4px_15px_rgba(0,0,0,0.2)]"
                      size="sm"
                      label="Help"
                  />
              </div>
          </div>
      </div>

      {/* Floating Reaction Bubbles */}
      <div className="fixed bottom-32 right-8 flex flex-col-reverse gap-2 pointer-events-none z-50">
        {activeReactions.map((reaction) => (
          <ReactionBubble
            key={reaction.id}
            emoji={reaction.emoji}
            className="relative bottom-auto right-auto"
          />
        ))}
      </div>

      {/* Notification Stack */}
      <NotificationStack
        notifications={notifications}
        onDismiss={dismissNotification}
        position="top-right"
        maxVisible={3}
      />

      {/* Guided Tour */}
      {hasJoined && (
        <GuidedTour
          isOpen={showTour}
          onComplete={handleTourComplete}
          onSkip={handleTourComplete}
          showProgress
          showSkip
        />
      )}
    </div>
  );
};

export default RoomPage;
