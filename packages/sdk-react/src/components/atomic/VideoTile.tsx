import React, { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '../../utils/cn';
import { MicOff, Monitor, Hand, Pin, AlertTriangle } from 'lucide-react';
import { Avatar } from './Avatar';
import { ConnectionQuality } from './ConnectionQuality';
import { NameTag } from './NameTag';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

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
  const isPoorConnection = participant.connectionQuality && participant.connectionQuality < 3;

  // Show warning only when video should be on but track is genuinely problematic
  // Don't show warning during brief state transitions
  const showTrackWarning = participant.isVideoEnabled && trackError;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[var(--chalk-border-radius-lg)] bg-[var(--chalk-bg-secondary)] shadow-sm transition-all',
        aspectRatioClasses[aspectRatio],
        participant.isSpeaking && !prefersReducedMotion && 'chalk-animate-speaking ring-2 ring-[var(--chalk-accent)]',
        participant.isSpeaking && prefersReducedMotion && 'ring-2 ring-[var(--chalk-accent)]',
        pinned && 'ring-2 ring-[var(--chalk-accent)]',
        onClick && 'cursor-pointer hover:opacity-95',
        className
      )}
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
          <Avatar
            name={participant.displayName}
            src={participant.avatarUrl}
            size="xl"
          />
        </div>
      ) : null}

      {children}

      <div className="absolute inset-0 p-3 flex flex-col justify-between pointer-events-none">
        <div className="flex justify-end gap-2">
          {showStatus && (
            <>
              {showTrackWarning && (
                <div
                  className="rounded-full bg-[var(--chalk-warning,#f59e0b)] p-1.5 text-white backdrop-blur-sm"
                  title={trackError || 'Video track unavailable'}
                >
                  <AlertTriangle size={16} />
                </div>
              )}
              {participant.isMuted && (
                <div className="rounded-full bg-black/50 p-1.5 text-white backdrop-blur-sm">
                  <MicOff size={16} />
                </div>
              )}
              {participant.isHandRaised && (
                <div className={cn(
                  "rounded-full bg-[var(--chalk-accent)] p-1.5 text-white backdrop-blur-sm",
                  !prefersReducedMotion && "chalk-animate-hand-bounce"
                )}>
                  <Hand size={16} />
                </div>
              )}
              {participant.isScreenSharing && (
                <div className="rounded-full bg-[var(--chalk-success)] p-1.5 text-white backdrop-blur-sm">
                  <Monitor size={16} />
                </div>
              )}
              {pinned && (
                <div className="rounded-full bg-[var(--chalk-accent)] p-1.5 text-white backdrop-blur-sm">
                  <Pin size={16} />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-end justify-between gap-2">
          {showName && (
            <NameTag
              name={participant.displayName}
              isLocal={participant.isLocal}
              size="sm"
            />
          )}
          
          {showStatus && isPoorConnection && participant.connectionQuality && (
             <div className="rounded-[var(--chalk-border-radius-sm)] bg-black/50 p-1 backdrop-blur-sm">
               <ConnectionQuality
                 quality={participant.connectionQuality}
                 size="sm"
               />
             </div>
          )}
        </div>
      </div>
    </div>
  );
});

VideoTile.displayName = 'VideoTile';
