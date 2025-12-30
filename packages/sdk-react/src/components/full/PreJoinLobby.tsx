import { useState, useEffect, memo } from 'react';
import { 
  ArrowLeft, 
  Pencil, 
  Mic, 
  MicOff, 
  Video, 
  VideoOff,
  Settings,
  X
} from 'lucide-react';
import { 
  Input, 
  Spinner, 
  Toast,
  Avatar,
  VideoTile,
  ControlButton
} from '../atomic';
import { 
  DeviceSelector 
} from '../composite';
import { cn } from '../../utils/cn';

export interface JoinSettings {
  displayName: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
}

export interface PreJoinLobbyProps {
  roomName?: string;
  userName?: string;
  onJoin: (settings: JoinSettings) => void;
  onCancel?: () => void;
  
  videoTrack?: MediaStreamTrack | null;
  audioTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  
  videoDevices?: MediaDeviceInfo[];
  audioInputDevices?: MediaDeviceInfo[];
  audioOutputDevices?: MediaDeviceInfo[];
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  onVideoDeviceChange?: (deviceId: string) => void;
  onAudioInputChange?: (deviceId: string) => void;
  onAudioOutputChange?: (deviceId: string) => void;
  
  initialVideoEnabled?: boolean;
  initialAudioEnabled?: boolean;
  
  isLoading?: boolean;
  error?: string;
  
  className?: string;
}

function PreJoinLobbyBase({
  roomName,
  userName = '',
  onJoin,
  onCancel,
  videoTrack,
  audioLevel = 0,
  videoDevices = [],
  audioInputDevices = [],
  audioOutputDevices = [],
  selectedVideoDevice,
  selectedAudioInput,
  selectedAudioOutput,
  onVideoDeviceChange = () => {},
  onAudioInputChange = () => {},
  onAudioOutputChange = () => {},
  initialVideoEnabled = true,
  initialAudioEnabled = true,
  isLoading = false,
  error,
  className,
}: PreJoinLobbyProps) {
  const [displayName, setDisplayName] = useState(userName);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (userName && !displayName) setDisplayName(userName);
  }, [userName]);

  const handleJoin = () => {
    if (!displayName.trim()) return;
    
    onJoin({
      displayName,
      videoEnabled: isVideoEnabled,
      audioEnabled: isAudioEnabled,
      selectedVideoDevice,
      selectedAudioInput,
      selectedAudioOutput,
    });
  };

  const hasVideoDevices = videoDevices.length > 0;
  const hasAudioInput = audioInputDevices.length > 0;
  const hasAudioOutput = audioOutputDevices.length > 0;

  // Toggle handlers
  const toggleVideo = () => setIsVideoEnabled(!isVideoEnabled);
  const toggleAudio = () => setIsAudioEnabled(!isAudioEnabled);

  return (
    <div className={cn(
      "min-h-screen bg-[#0D0D0D] text-white font-sans flex flex-col p-6 overflow-hidden", 
      className
    )}>
       {/* Settings Modal/Overlay */}
       {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#1a1a1a] rounded-2xl border border-white/10 p-6 w-full max-w-md shadow-2xl relative">
            <button 
              onClick={() => setShowSettings(false)}
              className="absolute top-4 right-4 p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X size={20} className="text-gray-400" />
            </button>
            
            <h2 className="text-xl font-bold text-white mb-6">Media Settings</h2>
            
            <div className="space-y-4">
               {hasVideoDevices && (
                 <DeviceSelector
                   type="videoinput"
                   label="Camera"
                   devices={videoDevices}
                   selectedDeviceId={selectedVideoDevice}
                   onChange={onVideoDeviceChange}
                   disabled={isLoading || !isVideoEnabled}
                 />
               )}
               
               {hasAudioInput && (
                 <DeviceSelector
                   type="audioinput"
                   label="Microphone"
                   devices={audioInputDevices}
                   selectedDeviceId={selectedAudioInput}
                   onChange={onAudioInputChange}
                   audioLevel={isAudioEnabled ? audioLevel : 0}
                   disabled={isLoading || !isAudioEnabled}
                 />
               )}
               
               {hasAudioOutput && (
                 <DeviceSelector
                   type="audiooutput"
                   label="Speaker"
                   devices={audioOutputDevices}
                   selectedDeviceId={selectedAudioOutput}
                   onChange={onAudioOutputChange}
                   disabled={isLoading}
                 />
               )}
            </div>
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 bg-[#6E00E6] text-white rounded-lg hover:bg-[#5a00bd] transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#A020F0] rounded-[14px] flex items-center justify-center transform -rotate-3 shadow-lg">
                  <Pencil className="text-white w-5 h-5" fill="white" />
              </div>
              <span className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 bg-clip-text text-transparent">Chalk</span>
              {roomName && (
                <div className="ml-4 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-sm font-medium text-gray-300">
                   {roomName}
                </div>
              )}
          </div>
          
          <div className="flex items-center gap-3">
              <Avatar name={displayName || "Guest"} size="md" className="!w-10 !h-10 border-2 border-white/10" />
              <div className="flex flex-col">
                  <span className="font-bold text-sm leading-none">{displayName || "Guest"}</span>
                  <span className="text-xs text-gray-400 font-medium mt-1">Participant</span>
              </div>
          </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center gap-20">
          
          {/* Left Column: Video Preview */}
          <div className="relative w-[640px] h-[400px] bg-[#1a1a1a] rounded-[32px] overflow-hidden border border-white/5 shadow-2xl flex flex-col group">
              <VideoTile 
                  participant={{
                      id: 'lobby-me',
                      displayName: displayName || 'You',
                      isVideoEnabled: isVideoEnabled,
                      isLocal: true,
                  }}
                  videoTrack={videoTrack}
                  className="w-full h-full bg-[#1a1a1a]"
                  showStatus={false}
                  showName={false}
                  showAvatar={false}
                  aspectRatio="16:9"
              >
                  {/* Overlay Controls */}
                  <div className="absolute top-6 left-6 z-10">
                      <div className="flex items-center gap-2 bg-[#1a1a1a]/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/5">
                          <div className={cn(
                            "w-2 h-2 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]",
                            isAudioEnabled ? "bg-green-500" : "bg-red-500"
                          )}></div>
                          <span className="text-sm font-medium text-white/90">{displayName || "You"}</span>
                      </div>
                  </div>

                  <div className="absolute top-6 right-6 z-10">
                       <ControlButton 
                           icon={<Settings size={18} />}
                           label="Settings"
                           className="bg-[#1a1a1a]/60 backdrop-blur-md text-white/80 hover:bg-white/10 border border-white/5"
                           size="sm"
                           onClick={() => setShowSettings(true)}
                       />
                  </div>

                  {!isVideoEnabled && (
                      <div className="absolute inset-0 flex items-center justify-center z-0">
                          <span className="text-xl font-medium text-white/60">Camera Is Off</span>
                      </div>
                  )}

                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 z-20">
                      <ControlButton 
                          icon={isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                          label={isAudioEnabled ? "Mute" : "Unmute"}
                          onClick={toggleAudio}
                          className={`backdrop-blur-md border border-white/5 ${!isAudioEnabled ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-[#1a1a1a]/80 text-white hover:bg-white/10'}`}
                          size="lg"
                      />
                      <ControlButton 
                          icon={isVideoEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                          label={isVideoEnabled ? "Stop Video" : "Start Video"}
                          onClick={toggleVideo}
                          className={`backdrop-blur-md border border-white/5 ${!isVideoEnabled ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-[#1a1a1a]/80 text-white hover:bg-white/10'}`}
                          size="lg"
                      />
                  </div>
              </VideoTile>
          </div>

          {/* Right Column: Join Actions */}
          <div className="flex flex-col items-center text-center space-y-8 max-w-sm w-full">
              <div className="space-y-3">
                  <h1 className="text-4xl font-semibold tracking-tight text-white">Ready To Join?</h1>
                  <p className="text-gray-400 font-medium">You'll be in a waiting room before entering the call</p>
              </div>

              <div className="w-full space-y-4">
                  <div className="w-full">
                    <label htmlFor="display-name" className="sr-only">Display Name</label>
                    <Input
                      id="display-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Enter your name"
                      fullWidth
                      disabled={isLoading}
                      className="h-12 text-lg text-center bg-[#1a1a1a] border-white/10 text-white placeholder:text-gray-500 focus:border-purple-500/50"
                    />
                  </div>

                  <button 
                      onClick={handleJoin}
                      disabled={!displayName.trim() || isLoading}
                      className="w-full py-4 bg-[#6E00E6] hover:bg-[#5a00bd] text-white rounded-full font-semibold text-lg transition-all shadow-lg hover:shadow-purple-500/25 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                      {isLoading ? <Spinner size="sm" className="mr-2" /> : null}
                      {isLoading ? "Joining..." : "Ask to join"}
                  </button>

                  {onCancel && (
                      <button 
                          onClick={onCancel}
                          disabled={isLoading}
                          className="w-full py-4 bg-[#1a1a1a] hover:bg-[#252525] text-white rounded-full font-medium flex items-center justify-center gap-2 border border-white/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                          <ArrowLeft size={18} />
                          Back
                      </button>
                  )}
              </div>

              {/* Placeholder for other participants - static as per design request */}
              <div className="flex items-center gap-4 pt-4">
                   <div className="flex -space-x-3">
                       {[1, 2, 3].map(i => (
                           <div key={i} className="rounded-full border-2 border-[#0D0D0D] bg-gray-700">
                               <Avatar 
                                  name={`User ${i}`}
                                  src={`https://i.pravatar.cc/100?img=${i+10}`}
                                  size="md"
                                  className="!w-10 !h-10"
                               />
                           </div>
                       ))}
                       <div className="relative">
                          <Avatar 
                              name="More"
                              src="https://i.pravatar.cc/100?img=15"
                              size="md"
                              className="!w-10 !h-10 border-2 border-[#0D0D0D] opacity-50"
                          />
                          <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">+3</span>
                       </div>
                   </div>
                   <span className="text-gray-300 font-medium text-sm">6 others are already here</span>
              </div>
          </div>

      </div>
      
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-md z-50">
          <Toast 
            type="error" 
            message={error} 
            onDismiss={() => {}}
            duration={0}
          />
        </div>
      )}
    </div>
  );
}

export const PreJoinLobby = memo(PreJoinLobbyBase);
PreJoinLobby.displayName = 'PreJoinLobby';
