import type { ReactNode } from "react";
import type { CallNetwork } from "./call-network";

export interface SpaceHeaderProps {
  spaceName: string;
  people?: readonly { readonly participantId: string; readonly displayName: string }[];
  onTogglePeople?: () => void;
  knockCount?: number;
  shareUrl?: string;
  callLinkOpen?: boolean;
  onCallLinkToggle?: () => void;
  diagnostics?: readonly { readonly label: string; readonly value: string }[];
  /** Connection quality and its charts for the call menu. Without it the menu has no Connection row. */
  network?: CallNetwork;
  /** Whether the camera is on, so a very poor link can offer to turn it off. */
  videoOn?: boolean;
  /** The "Turn off video" action of the connection chip. The video stays off until the person turns it back on. */
  onTurnOffVideo?: () => void;
  onReportProblem?: (report: { readonly description: string; readonly diagnostics?: string }) => void | Promise<void>;
  reportUnavailableReason?: string;
  onOpenReportProblem?: () => void;
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
  timeLeft?: number | null;
  isRecording?: boolean;
  isTranscribing?: boolean;
  layout?: "grid" | "focus";
  onLayoutChange?: (layout: "grid" | "focus") => void;
  /** A control for notices that have no room on the stage, placed at the header's end, before the people button. */
  notices?: ReactNode;
  className?: string;
}

export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
