import React, { useRef, useEffect } from 'react';
import { cn } from '../../utils/cn';
import { VideoTile } from '../atomic';
import type { Participant } from './VideoGrid';

export interface ScreenShareViewProps {
  screenShareTrack: MediaStreamTrack;
  sharedByName: string;
  participants: Participant[];
  onStopShare?: () => void;
  showThumbnails?: boolean;
  thumbnailPosition?: 'bottom' | 'right';
  className?: string;
}

export const ScreenShareView = React.memo(({
  screenShareTrack,
  sharedByName,
  participants,
  onStopShare,
  showThumbnails = true,
  thumbnailPosition = 'bottom',
  className,
}: ScreenShareViewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !screenShareTrack) return;

    // Validate track is active and not ended
    if (screenShareTrack.readyState === 'ended') {
      console.warn('[ScreenShareView] Screen share track is ended');
      return;
    }

    try {
      const stream = new MediaStream([screenShareTrack]);
      videoEl.srcObject = stream;
      videoEl.play().catch((error) => {
        console.error('[ScreenShareView] Failed to play video:', error);
      });
    } catch (error) {
      console.error('[ScreenShareView] Failed to create MediaStream:', error);
    }

    // Cleanup function
    return () => {
      if (videoEl.srcObject) {
        const stream = videoEl.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        videoEl.srcObject = null;
      }
    };
  }, [screenShareTrack]);

  return (
    <div 
      className={cn(
        "flex h-full w-full gap-4",
        thumbnailPosition === 'bottom' ? "flex-col" : "flex-row",
        className
      )}
    >
      <div className="relative flex-1 min-h-0 min-w-0 rounded-lg overflow-hidden bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-subtle)] group">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain bg-black"
        />
        
        <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-sm font-medium">
          Shared by {sharedByName}
        </div>

        {onStopShare && (
           <div className="absolute bottom-4 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={onStopShare}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-md font-medium shadow-lg transition-colors"
              >
                Stop Sharing
              </button>
           </div>
        )}
      </div>

      {showThumbnails && participants.length > 0 && (
        <div 
          className={cn(
            "flex gap-2 overflow-auto p-1",
            thumbnailPosition === 'bottom' 
              ? "h-32 w-full flex-row" 
              : "w-64 h-full flex-col"
          )}
        >
          {participants.map((p) => (
             <div 
                key={p.id}
                className={cn(
                  "shrink-0 rounded-lg overflow-hidden border border-[var(--chalk-border-subtle)] bg-[var(--chalk-bg-secondary)] relative",
                   thumbnailPosition === 'bottom' ? "aspect-video h-full" : "aspect-video w-full"
                )}
             >
                <VideoTile
                   participant={{
                      id: p.id,
                      displayName: p.displayName,
                      isLocal: p.isLocal,
                      isSpeaking: p.isSpeaking,
                      isMuted: p.isMuted,
                      isVideoEnabled: p.isVideoEnabled,
                      isScreenSharing: p.isScreenSharing,
                      isHandRaised: p.isHandRaised,
                      connectionQuality: (p.connectionQuality && p.connectionQuality > 0) ? (p.connectionQuality as 1 | 2 | 3 | 4) : undefined,
                      avatarUrl: p.avatarUrl
                   }}
                   videoTrack={p.videoTrack}
                   className="w-full h-full"
                   showName={true}
                   showStatus={true}
                />
             </div>
          ))}
        </div>
      )}
    </div>
  );
});

ScreenShareView.displayName = 'ScreenShareView';
