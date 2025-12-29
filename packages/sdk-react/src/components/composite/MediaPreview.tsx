import { Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { cn } from '../../utils/cn';
import { VideoTile, AudioIndicator, ControlButton } from '../atomic';

export interface MediaPreviewProps {
  videoTrack?: MediaStreamTrack | null;
  audioTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  isVideoEnabled?: boolean;
  isAudioEnabled?: boolean;
  onToggleVideo?: () => void;
  onToggleAudio?: () => void;
  userName?: string;
  className?: string;
}

export const MediaPreview = ({
  videoTrack,
  audioLevel = 0,
  isVideoEnabled = true,
  isAudioEnabled = true,
  onToggleVideo,
  onToggleAudio,
  userName,
  className,
}: MediaPreviewProps) => {
  return (
    <div className={cn("flex flex-col gap-4 w-full max-w-md", className)}>
      <div className="relative aspect-video rounded-xl overflow-hidden bg-background-secondary border border-border shadow-sm">
        <VideoTile
          participant={{
            id: 'local-preview',
            displayName: userName || 'You',
            isLocal: true,
            isVideoEnabled: isVideoEnabled,
            isMuted: !isAudioEnabled,
            connectionQuality: 4,
          }}
          videoTrack={videoTrack}
          mirror={true}
          showName={!!userName}
          className="w-full h-full"
        />
        
        <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between">
           <div className={cn(
             "flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-md transition-colors",
             isAudioEnabled ? "bg-black/40" : "bg-red-500/20"
           )}>
             <div className={cn(
                "p-1 rounded-full",
                !isAudioEnabled && "text-red-500"
             )}>
                {isAudioEnabled ? <Mic size={14} className="text-white" /> : <MicOff size={14} />}
             </div>
             {isAudioEnabled && (
                <div className="w-24">
                   <AudioIndicator level={audioLevel} />
                </div>
             )}
           </div>
        </div>
      </div>

      <div className="flex justify-center gap-4">
        <ControlButton
          icon={isAudioEnabled ? <Mic /> : <MicOff />}
          label={isAudioEnabled ? "Mute" : "Unmute"}
          danger={!isAudioEnabled}
          onClick={onToggleAudio}
          className="w-32"
        />
        <ControlButton
          icon={isVideoEnabled ? <Video /> : <VideoOff />}
          label={isVideoEnabled ? "Stop Video" : "Start Video"}
          danger={!isVideoEnabled}
          onClick={onToggleVideo}
          className="w-32"
        />
      </div>
    </div>
  );
};
