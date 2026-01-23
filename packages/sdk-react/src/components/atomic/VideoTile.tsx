import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { cn } from '../../utils/cn';
import { MicrophoneOff01Icon, Monitor01Icon, HandIcon } from '../../utils/icons';
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
  const participantBorder = useMemo(() => getParticipantBorder(participant.id), [participant.id]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[32px] transition-all duration-300',
        aspectRatioClasses[aspectRatio],
        (participant.isSpeaking || pinned) && 'ring-2 ring-ring',
        onClick && 'cursor-pointer hover:scale-[1.01]',
        className
      )}
      style={{
        background: `var(--card, ${participantGradient})`,
        border: `2px solid var(--border, ${participantBorder})`,
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

      {/* Smoother gradient overlay for name/status */}
      <div
        className="absolute inset-x-0 bottom-0 p-6 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.02) 20%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0.55) 100%)'
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
              {/* Muted indicator - glass style */}
              {participant.isMuted && (
                <div className="rounded-full bg-muted/60 p-2 text-muted-foreground backdrop-blur-md border border-border">
                  <MicrophoneOff01Icon size={16} />
                </div>
              )}
              {/* Hand raised indicator with wave animation */}
              {participant.isHandRaised && (
                <div className={cn(
                  "rounded-full bg-secondary p-2 text-secondary-foreground backdrop-blur-md",
                  !prefersReducedMotion && "chalk-animate-hand-bounce"
                )}>
                  <HandIcon size={16} />
                </div>
              )}
              {/* Screen sharing indicator */}
              {participant.isScreenSharing && (
                <div className="rounded-full bg-chart-3 p-2 text-primary-foreground backdrop-blur-md">
                  <Monitor01Icon size={16} />
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
