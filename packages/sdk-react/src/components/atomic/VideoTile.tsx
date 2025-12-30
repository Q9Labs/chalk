import React, { useEffect, useRef } from 'react';
import { cn } from '../../utils/cn';
import { MicOff, Monitor, Hand, Pin } from 'lucide-react';
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

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (videoTrack && participant.isVideoEnabled) {
      const stream = new MediaStream([videoTrack]);
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    } else {
      videoEl.srcObject = null;
    }
  }, [videoTrack, participant.isVideoEnabled]);

  const showVideo = participant.isVideoEnabled && videoTrack;
  const isPoorConnection = participant.connectionQuality && participant.connectionQuality < 3;

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
