import React, { useEffect, useRef } from "react";
import { cn } from "../../utils/cn";
import { MicrophoneOff01Icon } from "../../utils/icons";

export interface ThumbnailProps {
  videoTrack?: MediaStreamTrack | null;
  muted?: boolean;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  active?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: "w-[80px] h-[45px]",
  md: "w-[120px] h-[67.5px]",
  lg: "w-[160px] h-[90px]",
};

export const Thumbnail = React.memo(({ videoTrack, muted, size = "md", onClick, active, className }: ThumbnailProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (videoTrack) {
      const stream = new MediaStream([videoTrack]);
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    } else {
      videoEl.srcObject = null;
    }
  }, [videoTrack]);

  return (
    <div
      className={cn("relative shrink-0 overflow-hidden rounded-[var(--chalk-border-radius-sm)] bg-card transition-all duration-200", active && "ring-2 ring-accent", onClick && "cursor-pointer hover:opacity-90", sizeClasses[size], className)}
      onClick={onClick}
      role="button"
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={active}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          onClick();
        }
      }}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />

      {muted && (
        <div className="absolute bottom-1 right-1 rounded-full bg-black/50 p-0.5 text-white backdrop-blur-sm">
          <MicrophoneOff01Icon size={10} />
        </div>
      )}
    </div>
  );
});

Thumbnail.displayName = "Thumbnail";
