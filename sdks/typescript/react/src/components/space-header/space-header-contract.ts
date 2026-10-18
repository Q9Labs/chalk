export interface SpaceHeaderProps {
  spaceName: string;
  people?: readonly { readonly participantId: string; readonly displayName: string }[];
  onTogglePeople?: () => void;
  knockCount?: number;
  shareUrl?: string;
  diagnostics?: readonly { readonly label: string; readonly value: string }[];
  weakConnection?: boolean;
  onReportProblem?: (report: { readonly description: string; readonly diagnostics?: string }) => void | Promise<void>;
  shortcuts?: {
    readonly isMuted?: boolean;
    readonly onToggleMute?: () => void;
    readonly onToggleVideo?: () => void;
    readonly onToggleHand?: () => void;
    readonly onToggleChat?: () => void;
    readonly onTogglePeople?: () => void;
    readonly onToggleLayout?: () => void;
    readonly onClosePanel?: () => void;
    readonly onPushToTalk?: (enabled: boolean) => void;
  };
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
