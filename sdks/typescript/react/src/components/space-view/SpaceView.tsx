"use client";
import type { ChatUploadFile } from "@q9labsai/chalk-client";
import React from "react";
import { type InviteDialogProps } from "../invite-dialog/InviteDialog";
import { type ReconnectingOverlayProps } from "../reconnecting-overlay/ReconnectingOverlay";
import { type SpaceInfoDialogProps } from "../space-info-dialog/SpaceInfoDialog";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { ClassicSpaceView } from "./ClassicSpaceView";
export type SpacePanel = "chat" | "participants" | "transcript" | "admission" | "settings";
export interface SpaceViewFeatures {
  readonly chat?: boolean;
  readonly participants?: boolean;
  readonly admission?: boolean;
  readonly screenShare?: boolean;
  readonly recording?: boolean;
  readonly whiteboard?: boolean;
  readonly reactions?: boolean;
  readonly handRaise?: boolean;
  readonly info?: boolean;
  readonly settings?: boolean;
  readonly transcript?: boolean;
  /** Join / leave / message / hand-raise / reaction cues. */
  readonly sounds?: boolean;
}
export interface SpaceViewInfoDialogProps extends Omit<SpaceInfoDialogProps, "isOpen" | "onClose"> {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}
export interface SpaceViewInviteDialogProps extends Omit<InviteDialogProps, "isOpen" | "onClose"> {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}
export interface SpaceViewWhiteboard {
  readonly isOpen: boolean;
  readonly props: WhiteboardViewProps;
}
export interface SpaceViewProps {
  readonly colorScheme?: "light" | "dark";
  readonly spaceName: string;
  readonly logoUrl?: string;
  readonly inviteLink?: string;
  readonly pickChatFiles?: () => Promise<readonly ChatUploadFile[]>;
  readonly stageBackground?: boolean;
  readonly layout?: "grid" | "focus";
  readonly onLayoutChange?: (layout: "grid" | "focus") => void;
  readonly initialPanel?: SpacePanel | null;
  readonly features?: SpaceViewFeatures;
  readonly infoDialog?: SpaceViewInfoDialogProps;
  readonly inviteDialog?: SpaceViewInviteDialogProps;
  readonly settingsDialog?: React.ReactNode;
  readonly generatedAvatars?: boolean;
  readonly commandError?: string;
  readonly onDismissCommandError?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onToggleWhiteboard?: () => void;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly reconnecting?: Omit<ReconnectingOverlayProps, "isVisible"> & {
    readonly isVisible: boolean;
  };
  readonly overlay?: React.ReactNode;
  readonly onLeft?: () => void | Promise<void>;
  readonly onEndEpisode?: () => void | Promise<void>;
  readonly className?: string;
}
export function SpaceView(props: SpaceViewProps): React.JSX.Element {
  const themedProps = { ...props, logoUrl: logoForColorScheme(props.logoUrl, props.colorScheme ?? "light") };
  return <>{<ClassicSpaceView {...themedProps} />}</>;
}
function logoForColorScheme(logoUrl: string | undefined, colorScheme: "light" | "dark"): string | undefined {
  if (!logoUrl || colorScheme !== "dark") return logoUrl;
  return logoUrl.replace(/chalk-logo\.svg(?=$|[?#])/u, "chalk-logo-on-dark.svg");
}
