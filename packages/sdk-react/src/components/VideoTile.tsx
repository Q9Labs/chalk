/**
 * VideoTile component - Displays a single participant's video
 */

import React, { useEffect, useRef, type CSSProperties } from 'react';
import type { Participant } from '@chalk/core';

export interface VideoTileProps {
  /** The participant to display */
  participant: Participant;
  /** Additional CSS class names */
  className?: string;
  /** Inline styles */
  style?: CSSProperties;
  /** Whether to mirror the video (usually for local participant) */
  mirror?: boolean;
  /** Whether to show the participant name overlay */
  showName?: boolean;
  /** Whether to show audio/video status indicators */
  showStatus?: boolean;
  /** Custom render for the name overlay */
  renderName?: (participant: Participant) => React.ReactNode;
  /** Custom render for status indicators */
  renderStatus?: (participant: Participant) => React.ReactNode;
  /** Called when the video element is ready */
  onVideoReady?: (video: HTMLVideoElement) => void;
}

/**
 * VideoTile - Displays a participant's video with optional overlays
 *
 * @example
 * ```tsx
 * // Basic usage
 * <VideoTile participant={participant} />
 *
 * // With options
 * <VideoTile
 *   participant={localParticipant}
 *   mirror={true}
 *   showName={true}
 *   showStatus={true}
 * />
 *
 * // Custom name renderer
 * <VideoTile
 *   participant={participant}
 *   renderName={(p) => <CustomNameBadge name={p.displayName} role={p.role} />}
 * />
 * ```
 */
export function VideoTile({
  participant,
  className,
  style,
  mirror = false,
  showName = true,
  showStatus = true,
  renderName,
  renderStatus,
  onVideoReady,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach video track to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (participant.videoTrack && participant.videoEnabled) {
      const stream = new MediaStream([participant.videoTrack]);
      video.srcObject = stream;
      video.play().catch(() => {
        // Autoplay might be blocked, user interaction required
      });
      onVideoReady?.(video);
    } else {
      video.srcObject = null;
    }

    return () => {
      video.srcObject = null;
    };
  }, [participant.videoTrack, participant.videoEnabled, onVideoReady]);

  const containerStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    backgroundColor: '#1a1a2e',
    borderRadius: '8px',
    overflow: 'hidden',
    ...style,
  };

  const videoStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: mirror ? 'scaleX(-1)' : undefined,
  };

  const overlayStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '8px 12px',
    background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const nameStyle: CSSProperties = {
    color: 'white',
    fontSize: '14px',
    fontWeight: 500,
    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
  };

  const statusStyle: CSSProperties = {
    display: 'flex',
    gap: '4px',
    fontSize: '16px',
  };

  const avatarStyle: CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    backgroundColor: '#4a5568',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    fontSize: '24px',
    fontWeight: 600,
  };

  const getInitials = (name: string): string => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const defaultNameRender = () => (
    <span style={nameStyle}>
      {participant.displayName}
      {participant.isLocal && ' (You)'}
    </span>
  );

  const defaultStatusRender = () => (
    <span style={statusStyle}>
      {!participant.audioEnabled && <span title="Muted">🔇</span>}
      {!participant.videoEnabled && <span title="Camera off">📵</span>}
      {participant.isScreenSharing && <span title="Sharing screen">🖥️</span>}
      {participant.handRaised && <span title="Hand raised">✋</span>}
    </span>
  );

  return (
    <div
      className={`chalk-video-tile ${className ?? ''}`}
      style={containerStyle}
      data-participant-id={participant.id}
      data-is-local={participant.isLocal}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={participant.isLocal}
        style={{
          ...videoStyle,
          display: participant.videoEnabled ? 'block' : 'none',
        }}
      />

      {/* Avatar fallback when video is off */}
      {!participant.videoEnabled && (
        <div style={avatarStyle}>{getInitials(participant.displayName)}</div>
      )}

      {/* Speaking indicator */}
      {participant.isSpeaking && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: '3px solid #10b981',
            borderRadius: '8px',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Bottom overlay with name and status */}
      {(showName || showStatus) && (
        <div style={overlayStyle}>
          {showName && (renderName?.(participant) ?? defaultNameRender())}
          {showStatus && (renderStatus?.(participant) ?? defaultStatusRender())}
        </div>
      )}
    </div>
  );
}
