import { useState, useEffect, memo } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MoreVertical,
  ChevronDown,
  X
} from 'lucide-react';
import {
  Spinner,
  Toast,
  Avatar,
  VideoTile,
  ControlButton,
  Input
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
  initialShowSettings?: boolean;

  isLoading?: boolean;
  error?: string;

  className?: string;
}

function PreJoinLobbyBase({
  roomName: _roomName,
  userName = 'Guest',
  onJoin,
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
  initialShowSettings = false,
  isLoading = false,
  error,
  className,
}: PreJoinLobbyProps) {
  const [displayName, setDisplayName] = useState(userName);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);
  const [showSettings, setShowSettings] = useState(initialShowSettings);

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
  const toggleSettings = () => setShowSettings(!showSettings);

  return (
    <div className={cn(
      "min-h-screen bg-[#0b0b0c] text-foreground font-sans flex flex-col overflow-hidden",
      className
    )}>
       {/* Settings Modal/Overlay */}
       {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center  p-4">
          <div className="bg-card rounded-2xl border border-border p-6 w-full max-w-md shadow-2xl relative animate-in fade-in zoom-in-95 duration-200 bg-background">
            <button
              onClick={() => setShowSettings(false)}
              className="absolute top-4 right-4 p-2 hover:bg-muted rounded-full transition-colors text-muted-foreground hover:text-foreground"
            >
              <X size={20} />
            </button>

            <h2 className="text-xl font-bold text-foreground mb-6">Media Settings</h2>

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
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-center px-6 py-5 w-full max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
              <img
                src="/chalk-logo.svg"
                alt="Chalk"
                className="h-8 w-auto"
                draggable={false}
              />
          </div>

          <div className="flex items-center gap-3 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 hover:bg-white/10 transition-colors cursor-pointer">
              <Avatar name={displayName || "Guest"} size="xs" className="!w-6 !h-6" />
              <span className="font-medium text-sm text-foreground">{displayName || "Guest"}</span>
              <ChevronDown size={14} className="text-muted-foreground" />
          </div>
      </div>

      {/* Main Content */}
        <div className="flex-1 w-full max-w-6xl mx-auto flex items-center px-6 pb-12">
          <div className="grid w-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-10 items-center">
          {/* Left Column: Video Preview */}
          <div className="w-full">
              <VideoTile
                  participant={{
                      id: 'lobby-me',
                      displayName: displayName || 'You',
                      isVideoEnabled: isVideoEnabled,
                      isLocal: true,
                  }}
                  videoTrack={videoTrack}
                  className="w-full bg-[#16181b] aspect-video rounded-2xl border border-white/10 overflow-hidden shadow-2xl"
                  showStatus={false}
                  showName={false}
                  showAvatar={false}
                  aspectRatio="16:9"
              >
                  {/* Overlay Controls */}

                  {/* Top Left: Name Badge */}
                  <div className="absolute top-4 left-4 z-10">
                      <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
                          <div className={cn(
                            "w-2 h-2 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]",
                            isAudioEnabled ? "bg-green-500" : "bg-red-500"
                          )}></div>
                          <span className="text-sm font-medium text-foreground">{displayName || "You"}</span>
                      </div>
                  </div>


                  {/* Center State: Camera Off */}
                  {!isVideoEnabled && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-4">
                          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-2">
                             <Avatar name={displayName} size="xl" className="!w-20 !h-20 text-3xl opacity-50" />
                          </div>
                          <span className="text-lg font-medium text-muted-foreground">Camera Is Off</span>
                      </div>
                  )}

                  {/* Bottom Center: Media Controls */}
              </VideoTile>
              <div className="mt-5 flex items-center justify-center gap-4">
                <ControlButton
                    icon={isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                    label={isAudioEnabled ? "Mute" : "Unmute"}
                    onClick={toggleAudio}
                    className={cn(
                      "border border-white/10 w-12 h-12 rounded-full transition-all duration-200",
                      !isAudioEnabled
                        ? "bg-[#ea4335] text-white hover:bg-[#d83b2f] border-transparent"
                        : "bg-[#202124] text-white hover:bg-[#2a2c30]"
                    )}
                    size="lg"
                />
                <ControlButton
                    icon={isVideoEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                    label={isVideoEnabled ? "Stop Video" : "Start Video"}
                    onClick={toggleVideo}
                    className={cn(
                      "border border-white/10 w-12 h-12 rounded-full transition-all duration-200",
                      !isVideoEnabled
                        ? "bg-[#ea4335] text-white hover:bg-[#d83b2f] border-transparent"
                        : "bg-[#202124] text-white hover:bg-[#2a2c30]"
                    )}
                    size="lg"
                />
                <ControlButton
                    icon={<MoreVertical size={18} />}
                    label="Settings"
                    size="lg"
                    onClick={toggleSettings}
                    className="border border-white/10 w-12 h-12 rounded-full bg-[#202124] text-white hover:bg-[#2a2c30] transition-all duration-200"
                />
              </div>
          </div>

          {/* Right Column: Join Actions */}
          <div className="flex flex-col items-start text-left space-y-6 w-full max-w-sm lg:justify-self-end">
              <div className="space-y-2 text-left">
                  <h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-foreground">Ready to join?</h1>
                  <p className="text-muted-foreground text-base">You'll be in a waiting room before entering the call</p>
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
                      className="h-11 text-base text-left bg-[#1f2226] border border-white/10 text-foreground placeholder:text-muted-foreground focus:border-white/20"
                    />
                  </div>

                  <button
                      onClick={handleJoin}
                      disabled={!displayName.trim() || isLoading}
                      className="w-full h-11 bg-[var(--chalk-accent)] hover:bg-[var(--chalk-accent-hover)] text-white rounded-full font-semibold text-base transition-all shadow-lg hover:shadow-[var(--chalk-accent)]/20 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                      {isLoading ? <Spinner size="sm" className="mr-2" /> : null}
                      {isLoading ? "Joining..." : "Ask to join"}
                  </button>

                  <button
                      className="w-full h-11 bg-[#202124] hover:bg-[#2a2c30] text-white/90 rounded-full font-medium flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
                  >
                      Other ways to join
                      <ChevronDown size={16} className="text-secondary-foreground/70" />
                  </button>
              </div>

              {/* Participants Stack */}
              {/* <div className="flex items-center gap-4 pt-2">
                   <div className="flex -space-x-3">
                       {[1, 2, 3].map(i => (
                           <div key={i} className="rounded-full border-2 border-background bg-muted">
                               <Avatar
                                  name={`User ${i}`}
                                  src={`https://i.pravatar.cc/100?img=${i+10}`}
                                  size="md"
                                  className="!w-9 !h-9"
                               />
                           </div>
                       ))}
                       <div className="relative rounded-full border-2 border-background bg-card">
                          <div className="w-9 h-9 flex items-center justify-center rounded-full bg-card text-xs font-bold text-foreground">
                             +3
                          </div>
                       </div>
                   </div>
                   <span className="text-muted-foreground font-medium text-sm">6 others are already here</span>
              </div> */}
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
