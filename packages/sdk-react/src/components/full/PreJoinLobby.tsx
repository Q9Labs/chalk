import { useState, useEffect, memo } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { 
  Input, 
  Spinner, 
  Toast,
  Badge
} from '../atomic';
import { 
  MediaPreview, 
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
  audioTrack,
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
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayName, setDisplayName] = useState(userName);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);

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

  return (
    <div className={cn(
      "flex flex-col items-center justify-center min-h-screen bg-[var(--chalk-bg-primary)] p-4 font-sans text-[var(--chalk-text-primary)]", 
      className
    )}>
      <div className={cn(
        "w-full max-w-lg space-y-8",
        !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-300"
      )}>
        
        <div className="text-center space-y-2">
          {roomName && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-secondary)] text-sm font-medium mb-4">
               <Badge variant="default">Joining</Badge>
               <span>{roomName}</span>
            </div>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">Ready to join?</h1>
          <p className="text-[var(--chalk-text-secondary)]">Check your audio and video settings</p>
        </div>

        <div className="space-y-6">
          <MediaPreview 
            videoTrack={isVideoEnabled ? videoTrack : null}
            audioTrack={isAudioEnabled ? audioTrack : null}
            audioLevel={isAudioEnabled ? audioLevel : 0}
            isVideoEnabled={isVideoEnabled}
            isAudioEnabled={isAudioEnabled}
            onToggleVideo={() => setIsVideoEnabled(!isVideoEnabled)}
            onToggleAudio={() => setIsAudioEnabled(!isAudioEnabled)}
            userName={displayName}
            className="w-full max-w-full mx-auto"
          />

          <div className="w-full">
            <label htmlFor="display-name" className="sr-only">Display Name</label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter your name"
              fullWidth
              disabled={isLoading}
              className="h-12 text-lg text-center"
              aria-label="Enter your display name"
            />
          </div>

          <div className="space-y-4 bg-[var(--chalk-bg-secondary)] p-4 rounded-[var(--chalk-border-radius-lg)] border border-[var(--chalk-border-color)]">
            <div className="grid grid-cols-1 gap-4">
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
               
               <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
            </div>
          </div>
        </div>

        {error && (
          <div className="w-full">
            <Toast 
              type="error" 
              message={error} 
              onDismiss={() => {}}
              duration={0}
            />
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isLoading}
              className={cn(
                "inline-flex items-center justify-center rounded-[var(--chalk-border-radius-md)] px-6 py-3 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--chalk-focus-ring)] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] hover:bg-[var(--chalk-bg-secondary)]",
                "w-full sm:w-auto"
              )}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Cancel
            </button>
          )}
          
          <button
            type="button"
            onClick={handleJoin}
            disabled={!displayName.trim() || isLoading}
            className={cn(
              "inline-flex items-center justify-center rounded-[var(--chalk-border-radius-md)] px-6 py-3 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--chalk-focus-ring)] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
              "bg-[var(--chalk-accent)] text-white hover:bg-[var(--chalk-accent-hover)] shadow-md",
              "w-full sm:w-1/2"
            )}
          >
            {isLoading ? <Spinner size="sm" className="mr-2" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            {isLoading ? "Joining..." : "Join Meeting"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const PreJoinLobby = memo(PreJoinLobbyBase);
PreJoinLobby.displayName = 'PreJoinLobby';
