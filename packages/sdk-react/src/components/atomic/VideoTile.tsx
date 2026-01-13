import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { cn } from '../../utils/cn';
import { MicOff, Monitor, Hand } from 'lucide-react';
import { Avatar } from './Avatar';
import { NameTag } from './NameTag';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { getParticipantGradient, getParticipantBorder } from '../../utils/colorGenerator';

export interface VideoTileProps {
  participant: {
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
  };
  videoTrack?: MediaStreamTrack | null;
  mirror?: boolean;
  showName?: boolean;
  showStatus?: boolean;
  aspectRatio?: '16:9' | '4:3' | '1:1';
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinned?: boolean;
  className?: string;
  children?: React.ReactNode;
  showAvatar?: boolean;
}

/**
 * Check if a track is usable (live and enabled)
 */
function isTrackUsable(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.readyState === 'live' && track.enabled;
}

const aspectRatioClasses = {
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
};

export const VideoTile = React.memo(({
  participant,
  videoTrack,
  mirror,
  showName = true,
  showStatus = true,
  showAvatar = true,
  aspectRatio = '16:9',
  onClick,
  onDoubleClick,
  pinned,
  className,
  children,
}: VideoTileProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [trackError, setTrackError] = useState<string | null>(null);
  // Track ID used to detect when the actual track changes (not just reference)
  const [, setCurrentTrackId] = useState<string | null>(null);
  // Force re-render counter for track state changes
  const [, forceUpdate] = useState(0);

  // Memoized track attachment function
  const attachTrack = useCallback((videoEl: HTMLVideoElement, track: MediaStreamTrack) => {
    // Create new MediaStream with the track
    const stream = new MediaStream([track]);
    videoEl.srcObject = stream;

    // Use play() with retry logic for autoplay restrictions
    const attemptPlay = () => {
      videoEl.play().catch((err) => {
        // AbortError is common during rapid track changes - ignore it
        if (err.name === 'AbortError') return;

        const errorMsg = err instanceof Error ? err.message : 'Play failed';
        // Only set error for non-transient issues
        if (!errorMsg.includes('interrupted')) {
          setTrackError(errorMsg);
        }
      });
    };

    attemptPlay();
  }, []);

  // Effect to handle track changes and lifecycle
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    // Clear previous error state
    setTrackError(null);

    // Check if we should display video
    const shouldShowVideo = participant.isVideoEnabled && videoTrack;

    if (!shouldShowVideo) {
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    // Validate track is usable
    if (!isTrackUsable(videoTrack)) {
      // Track exists but not usable - don't show error immediately, it might recover
      // This handles React StrictMode double-mount where track temporarily becomes unavailable
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    // Track the current track ID to detect actual track changes
    const trackId = videoTrack.id;
    setCurrentTrackId(trackId);

    // Attach the track
    attachTrack(videoEl, videoTrack);

    // Handle track ending
    const handleEnded = () => {
      setTrackError('Track ended');
      forceUpdate(n => n + 1);
    };

    // Handle track mute/unmute (some browsers use this instead of ended)
    const handleMute = () => {
      forceUpdate(n => n + 1);
    };

    const handleUnmute = () => {
      // Re-attach track when it becomes unmuted
      if (isTrackUsable(videoTrack)) {
        attachTrack(videoEl, videoTrack);
        setTrackError(null);
      }
    };

    videoTrack.addEventListener('ended', handleEnded);
    videoTrack.addEventListener('mute', handleMute);
    videoTrack.addEventListener('unmute', handleUnmute);

    return () => {
      videoTrack.removeEventListener('ended', handleEnded);
      videoTrack.removeEventListener('mute', handleMute);
      videoTrack.removeEventListener('unmute', handleUnmute);
    };
  }, [videoTrack, participant.isVideoEnabled, attachTrack]);

  // Compute display state
  const isTrackValid = isTrackUsable(videoTrack);
  const showVideo = participant.isVideoEnabled && videoTrack && isTrackValid && !trackError;

  // Generate consistent color for this participant
  const participantGradient = useMemo(() => getParticipantGradient(participant.id), [participant.id]);
  const participantBorder = useMemo(() => getParticipantBorder(participant.id), [participant.id]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[32px] shadow-2xl transition-all duration-300',
        aspectRatioClasses[aspectRatio],
        (participant.isSpeaking || pinned) && 'ring-2 ring-[#151515]',
        onClick && 'cursor-pointer hover:scale-[1.01]',
        className
      )}
      style={{
        background: participantGradient,
        border: `1px solid ${participantBorder}`
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-tour={participant.isLocal ? 'local-video' : 'video-grid'}
      role="region"
      aria-label={`Video tile for ${participant.displayName}`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            'h-full w-full object-cover',
            mirror && 'scale-x-[-1]'
          )}
        />
      ) : showAvatar ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative">
            <Avatar
              name={participant.displayName}
              src={participant.avatarUrl}
              size="2xl"
            />
          </div>
        </div>
      ) : null}

      {children}

      <div 
        className="absolute inset-x-0 bottom-0 p-6 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.4) 100%)'
        }}
      >
        <div className="flex items-center justify-between">
          {showName && (
            <NameTag
              name={participant.displayName}
              size="lg"
              className="font-bold text-lg text-white/90"
            />
          )}
          <div className="flex-1" />
          {showStatus && (
            <div className="flex items-center gap-2">
              {participant.isMuted && (
                <div className="rounded-full bg-black/40 p-2 text-white backdrop-blur-md border border-white/10">
                  <MicOff size={16} />
                </div>
              )}
              {participant.isHandRaised && (
                <div className={cn(
                  "rounded-full bg-[#151515] p-2 text-white backdrop-blur-md",
                  !prefersReducedMotion && "chalk-animate-hand-bounce"
                )}>
                  <Hand size={16} />
                </div>
              )}
              {participant.isScreenSharing && (
                <div className="rounded-full bg-green-500 p-2 text-white backdrop-blur-md">
                  <Monitor size={16} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

VideoTile.displayName = 'VideoTile';
