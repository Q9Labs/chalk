import type React from "react";
import type { RefObject } from "react";

import { Avatar } from "../../atomic";
import { cn } from "../../../utils/cn";
import { getParticipantColor, type ParticipantGradientPreference } from "../../../utils/colorGenerator";

interface PreJoinMobilePreviewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  displayName: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  audioLevel: number;
  participantGradient: string;
  participantGradientPreference?: ParticipantGradientPreference;
}

export function PreJoinMobilePreview({ videoRef, displayName, isVideoEnabled, isAudioEnabled, audioLevel, participantGradient, participantGradientPreference }: PreJoinMobilePreviewProps): React.JSX.Element {
  const participantColors = getParticipantColor(displayName, participantGradientPreference);

  return (
    <div className="absolute inset-0 w-full h-full" style={{ "--primary": participantColors.primary } as React.CSSProperties}>
      {/* Base gradient background - always visible */}
      <div
        className="absolute inset-0"
        style={{
          background: participantGradient,
          opacity: 0.8,
        }}
      />

      {/* Dark overlay for better contrast */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Video element */}
      <video ref={videoRef} autoPlay playsInline muted className={cn("absolute inset-0 w-full h-full object-cover transition-opacity duration-300", isVideoEnabled ? "opacity-100" : "opacity-0")} style={{ transform: "scaleX(-1)" }} />

      {/* Avatar fallback when video is off */}
      {!isVideoEnabled && (
        <div className="absolute inset-0 flex items-center justify-center">
          {/* Audio pulse rings */}
          {isAudioEnabled && audioLevel > 0.05 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="absolute rounded-full bg-[var(--primary)]/20 animate-ping"
                style={{
                  width: 100 + audioLevel * 80,
                  height: 100 + audioLevel * 80,
                  animationDuration: "1.5s",
                }}
              />
              <div
                className="absolute rounded-full bg-[var(--primary)]/10 animate-ping"
                style={{
                  width: 140 + audioLevel * 120,
                  height: 140 + audioLevel * 120,
                  animationDuration: "2s",
                  animationDelay: "0.2s",
                }}
              />
            </div>
          )}

          {/* Avatar */}
          <Avatar
            name={displayName}
            size="xl"
            gradientPreference={participantGradientPreference}
            className="opacity-95 relative z-10 transition-transform duration-75"
            style={{
              transform: `scale(${1 + audioLevel * 0.1})`,
            }}
          />
        </div>
      )}
    </div>
  );
}
