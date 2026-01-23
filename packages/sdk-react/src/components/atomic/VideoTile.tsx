import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { cn } from '../../utils/cn';
import { MicrophoneOff01Icon, Monitor01Icon, HandIcon } from '../../utils/icons';
import { Avatar } from './Avatar';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { getParticipantGradient } from '../../utils/colorGenerator';

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
  aspectRatio?: '16:9' | '4:3' | '1:1' | 'fill';
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinned?: boolean;
  className?: string;
  children?: React.ReactNode;
  showAvatar?: boolean;
}

function isTrackUsable(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.readyState === 'live' && track.enabled;
}

const aspectRatioClasses = {
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  'fill': '',
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
  const [, setCurrentTrackId] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const attachTrack = useCallback((videoEl: HTMLVideoElement, track: MediaStreamTrack) => {
    const stream = new MediaStream([track]);
    videoEl.srcObject = stream;

    const attemptPlay = () => {
      videoEl.play().catch((err) => {
        if (err.name === 'AbortError') return;
        const errorMsg = err instanceof Error ? err.message : 'Play failed';
        if (!errorMsg.includes('interrupted')) {
          setTrackError(errorMsg);
        }
      });
    };

    attemptPlay();
  }, []);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    setTrackError(null);

    const shouldShowVideo = participant.isVideoEnabled && videoTrack;

    if (!shouldShowVideo) {
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    if (!isTrackUsable(videoTrack)) {
      videoEl.srcObject = null;
      setCurrentTrackId(null);
      return;
    }

    const trackId = videoTrack.id;
    setCurrentTrackId(trackId);

    attachTrack(videoEl, videoTrack);

    const handleEnded = () => {
      setTrackError('Track ended');
      forceUpdate(n => n + 1);
    };

    const handleMute = () => {
      forceUpdate(n => n + 1);
    };

    const handleUnmute = () => {
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

  const isTrackValid = isTrackUsable(videoTrack);
  const showVideo = participant.isVideoEnabled && videoTrack && isTrackValid && !trackError;

  const participantGradient = useMemo(() => getParticipantGradient(participant.id), [participant.id]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border-0 outline-none',
        aspectRatioClasses[aspectRatio],
        pinned && 'ring-2 ring-primary/50',
        onClick && 'cursor-pointer',
        className
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-tour={participant.isLocal ? 'local-video' : 'video-grid'}
      role="region"
      aria-label={`Video tile for ${participant.displayName}`}
    >
      {/* Video element (always rendered, visibility controlled by CSS) */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn(
          'h-full w-full object-cover',
          mirror && 'scale-x-[-1]',
          !showVideo && 'hidden'
        )}
      />

      {/* Avatar background when video is off */}
      {!showVideo && showAvatar && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: participantGradient }}
        >
          <Avatar
            name={participant.displayName}
            src={participant.avatarUrl}
            size="xl"
            className="opacity-90"
          />
        </div>
      )}

      {children}

      {/* Compact bottom-left info chip */}
      {(showName || showStatus) && (
        <div className="absolute bottom-3 left-3 right-3 pointer-events-none">
          <div
            className="inline-flex items-center gap-2 px-2 py-1.5 rounded-full backdrop-blur-md"
            style={{
              background: 'rgba(0, 0, 0, 0.5)',
            }}
          >
            {/* Small avatar when video is off */}
            {!showVideo && showAvatar && (
              <Avatar
                name={participant.displayName}
                src={participant.avatarUrl}
                size="sm"
              />
            )}

            {/* Name */}
            {showName && (
              <span className="text-sm font-medium text-white truncate max-w-[120px]">
                {participant.displayName}
              </span>
            )}

            {/* Status icons inline */}
            {showStatus && (
              <div className="flex items-center gap-1 ml-auto">
                {participant.isMuted && (
                  <div className="rounded-full bg-red-500/80 p-1">
                    <MicrophoneOff01Icon size={12} className="text-white" />
                  </div>
                )}
                {participant.isHandRaised && (
                  <div className={cn(
                    "rounded-full bg-amber-500/80 p-1",
                    !prefersReducedMotion && "chalk-animate-hand-bounce"
                  )}>
                    <HandIcon size={12} className="text-white" />
                  </div>
                )}
                {participant.isScreenSharing && (
                  <div className="rounded-full bg-primary/80 p-1">
                    <Monitor01Icon size={12} className="text-white" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

VideoTile.displayName = 'VideoTile';
