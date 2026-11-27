import type { ReactNode } from "react";
import type { CallNetwork } from "./call-network";

/** The call-wide controls a host sees in the call menu. A control that is missing here is not shown. */
export interface CallHostControls {
  /** How many other people are unmuted, and the way to mute them all. */
  readonly muteEveryone?: { readonly unmutedCount: number; readonly onMute: () => Promise<void> };
  /** Focus allowance control for holders of focus.manage. */
  readonly focusAllowance?: { readonly active: boolean; readonly onAllow: (minutes: number) => Promise<void>; readonly onEnd: () => Promise<void> };
}

export interface SpaceHeaderProps {
  spaceName: string;
  people?: readonly { readonly participantId: string; readonly displayName: string; readonly identityKind?: "user" | "agent" | "guest" }[];
  onTogglePeople?: () => void;
  knockCount?: number;
  shareUrl?: string;
  /** Mute everyone, for a host. Without it the call menu has no host row. */
  hostControls?: CallHostControls;
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
    readonly onToggleFullscreen?: () => void;
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

/** A host alone at call start sees the menu titled for what to do next. */
export function detailsTitle(spaceName: string, inviteOpen: boolean | undefined): string {
  return inviteOpen ? "Your call is ready" : spaceName;
}
