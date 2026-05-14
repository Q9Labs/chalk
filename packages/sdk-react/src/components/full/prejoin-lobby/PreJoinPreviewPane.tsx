import type React from "react";
import type { RefObject } from "react";

import { Avatar } from "../../atomic";
import { cn } from "../../../utils/cn";
import { getParticipantColor, type ParticipantGradientPreference } from "../../../utils/colorGenerator";

interface PreJoinPreviewPaneProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  displayName: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  audioLevel: number;
  normalizedAudioLevel: number;
  participantGradient: string;
  participantGradientPreference?: ParticipantGradientPreference;
  controls: React.ReactNode;
}

export function PreJoinPreviewPane({ videoRef, displayName, isVideoEnabled, isAudioEnabled, audioLevel, normalizedAudioLevel, participantGradient, participantGradientPreference, controls }: PreJoinPreviewPaneProps): React.JSX.Element {
  const participantColors = getParticipantColor(displayName, participantGradientPreference);

  return (
    <div className="w-full relative" style={{ "--primary": participantColors.primary } as React.CSSProperties}>
      <div className="absolute -inset-2 rounded-[2rem] opacity-40 blur-2xl" style={{ background: participantGradient }} />
      <div className="absolute -inset-1 rounded-3xl opacity-30 blur-xl" style={{ background: participantGradient }} />

      <div
        className="relative w-full aspect-video rounded-3xl overflow-hidden bg-[var(--chalk-bg-tile)]"
        style={{
          backgroundImage: participantGradient,
          boxShadow: "var(--chalk-shadow-xl), inset 0 1px 0 rgba(255,255,255,0.15)",
        }}
      >
        <video ref={videoRef} autoPlay playsInline muted className={cn("absolute inset-0 w-full h-full object-cover pointer-events-none", isVideoEnabled ? "opacity-100" : "opacity-0")} style={{ transform: "scaleX(-1)" }} />

        <div className="absolute top-5 left-5 z-20">
          <div
            className="flex items-center gap-3 px-4 py-2.5 rounded-full border bg-[var(--chalk-lobby-glass-bg)] border-[var(--chalk-lobby-glass-border)] backdrop-blur-[20px] shadow-lg"
          >
            <div className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0 transition-all duration-300", isAudioEnabled ? "bg-primary shadow-[0_0_10px_var(--primary)] scale-110" : "bg-muted-foreground/40")} />
            <span className="text-sm font-semibold text-foreground">{displayName || "You"}</span>

            {isAudioEnabled && (
              <div className="flex items-center gap-1">
                <div className="w-16 h-2 bg-black/20 dark:bg-white/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--primary)] rounded-full transition-all duration-75 ease-out"
                    style={{
                      width: `${normalizedAudioLevel}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {!isVideoEnabled && (
          <div className="absolute inset-0 flex items-center justify-center">
            {isAudioEnabled && audioLevel > 0.05 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div
                  className="absolute rounded-full bg-primary/20 animate-ping"
                  style={{
                    width: 120 + audioLevel * 100,
                    height: 120 + audioLevel * 100,
                    animationDuration: "1.5s",
                  }}
                />
                <div
                  className="absolute rounded-full bg-primary/10 animate-ping"
                  style={{
                    width: 160 + audioLevel * 150,
                    height: 160 + audioLevel * 150,
                    animationDuration: "2s",
                    animationDelay: "0.2s",
                  }}
                />
              </div>
            )}
            <Avatar
              name={displayName}
              size="2xl"
              gradientPreference={participantGradientPreference}
              className="opacity-90 relative z-10 transition-transform duration-75"
              style={{
                transform: `scale(${1 + audioLevel * 0.1})`,
              }}
            />
          </div>
        )}

        {controls}
      </div>
    </div>
  );
}
