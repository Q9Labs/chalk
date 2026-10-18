export interface SpaceHeaderProps {
  spaceName: string;
  colorScheme?: "light" | "dark";
  onColorSchemeChange?: (colorScheme: "light" | "dark") => void;
  duration?: number;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: "grid" | "focus";
  onLayoutChange?: (layout: "grid" | "focus") => void;
  className?: string;
}

export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
