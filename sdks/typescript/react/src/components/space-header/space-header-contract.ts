export interface SpaceHeaderProps {
  spaceName: string;
  logoUrl?: string;
  duration?: number;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: "grid" | "focus" | "presentation";
  onLayoutChange?: (layout: "grid" | "focus" | "presentation") => void;
  onInvite?: () => void;
  onInfo?: () => void;
  onSettings?: () => void;
  className?: string;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}
