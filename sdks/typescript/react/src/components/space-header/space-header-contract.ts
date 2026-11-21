import type { ReactNode } from "react";
import type { CallNetwork } from "./call-network";

/** The symptom picker the report dialog shows; the codes ride on `picked_symptom` fields and into the stored report. Other slices own each area's code; "Something else" stores `not_applicable`, and no pick stores `unavailable(not_picked)`. */
export const REPORT_SYMPTOMS = [
  { code: "join.no_media", label: "I couldn't join" },
  { code: "audio.not_heard", label: "Others can't hear me" },
  { code: "audio.cant_hear", label: "I can't hear others" },
  { code: "video.frozen", label: "Video froze or went black" },
  { code: "share.wont_stop", label: "Screen share won't stop" },
  { code: "board.view_jumped", label: "The whiteboard jumped" },
  { code: "access.connection_lost", label: "I got disconnected" },
  { code: "end.wrong_screen", label: "The call ended wrongly" },
  { code: "not_applicable", label: "Something else" },
] as const;
export type ReportSymptom = (typeof REPORT_SYMPTOMS)[number]["code"];
export type ReportProblemInput = { readonly description: string; readonly diagnostics?: string; readonly pickedSymptom?: ReportSymptom };
/** The stored report's outcome a sender hands back: its CHK code and the journey the op and surfaces join on. */
export type ReportProblemResult = { readonly code?: string; readonly journeyId?: string };
/** A send that failed mid-flight may still carry the journey its records were written under. */
export type ReportProblemError = Error & { readonly journeyId?: string };
export type ReportProblem = {
  (report: ReportProblemInput): void | Promise<ReportProblemResult | void>;
  /** The kernel `surface` observer the dialog's `report.dialog` surfaces emit through; a host without one leaves surfaces unobserved. */
  readonly observe?: import("../observed-surface").SurfaceObserver;
};

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
  onReportProblem?: ReportProblem;
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
