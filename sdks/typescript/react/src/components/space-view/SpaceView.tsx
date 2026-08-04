"use client";

import type { ActiveReaction, Reaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useState } from "react";

import { AudioOutput, type AudioParticipant } from "../audio-output/AudioOutput";
import { ChatPanel, type ChatPanelProps } from "../composite/ChatPanel";
import { SpaceHeader } from "../space-header/SpaceHeader";
import { SpaceInfoDialog, type SpaceInfoDialogProps } from "../space-info-dialog/SpaceInfoDialog";
import { ControlBar, type ControlBarButtonName, type ControlBarProps } from "../control-bar/ControlBar";
import { InviteDialog, type InviteDialogProps } from "../invite-dialog/InviteDialog";
import { LeaveDialog } from "../leave-dialog/LeaveDialog";
import { AdmissionPanel, type AdmissionPanelProps } from "../admission-panel/AdmissionPanel";
import { ParticipantsPanel, type ParticipantsPanelProps } from "../participants-panel/ParticipantsPanel";
import { ParticipantGrid, type Participant, type ParticipantGridProps } from "../participant-grid/ParticipantGrid";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { ReconnectingOverlay, type ReconnectingOverlayProps } from "../reconnecting-overlay/ReconnectingOverlay";
import { SettingsDialog } from "../composite/SettingsDialog";
import { ScreenShareView, type ScreenShareViewProps } from "../composite/ScreenShareView";
import { ToastStack, type Toast } from "../toast-stack/ToastStack";
import { TranscriptPanel, type TranscriptPanelProps } from "../transcript-panel/TranscriptPanel";
import { WhiteboardView, type WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { cn } from "../../utils/cn";

type SpaceLayout = NonNullable<ParticipantGridProps["layout"]>;
export type SpacePanel = "chat" | "participants" | "transcript" | "admission" | "settings";

export type SpaceViewPanelProps = {
  readonly active: SpacePanel | null;
  readonly onChange: (panel: SpacePanel | null) => void;
  readonly chat?: Omit<ChatPanelProps, "variant" | "onClose">;
  readonly participants?: Omit<ParticipantsPanelProps, "variant" | "onClose">;
  readonly transcript?: Omit<TranscriptPanelProps, "variant" | "onClose">;
  readonly admission?: AdmissionPanelProps;
  readonly settings?: React.ReactNode;
};

export type SpaceViewSettingsDialogProps = Omit<React.ComponentProps<typeof SettingsDialog>, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type SpaceViewInfoDialogProps = Omit<SpaceInfoDialogProps, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type SpaceViewInviteDialogProps = Omit<InviteDialogProps, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type SpaceViewReactions = {
  readonly reactions: readonly ActiveReaction[];
  readonly allowedReactions?: readonly Reaction[];
  readonly onSelect: (reaction: Reaction) => void | Promise<void>;
};

export type SpaceViewScreenShare = Omit<ScreenShareViewProps, "participants" | "className"> & {
  readonly content?: React.ReactNode;
};

export type SpaceViewWhiteboard = {
  readonly isOpen: boolean;
  readonly props: WhiteboardViewProps;
};

export interface SpaceViewProps {
  readonly spaceName: string;
  readonly displayName: string;
  readonly logoUrl?: string;
  readonly inviteLink?: string;
  readonly duration?: number;
  readonly layout?: SpaceLayout;
  readonly onLayoutChange?: (layout: SpaceLayout) => void;
  readonly participants: readonly Participant[];
  readonly audioParticipants?: readonly AudioParticipant[];
  readonly screenShare?: SpaceViewScreenShare;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly controls?: Omit<ControlBarProps, "placement" | "density" | "duration" | "onLeft">;
  readonly mobileControlButtons?: readonly ControlBarButtonName[];
  readonly panels?: SpaceViewPanelProps;
  readonly infoDialog?: SpaceViewInfoDialogProps;
  readonly settingsDialog?: SpaceViewSettingsDialogProps;
  readonly inviteDialog?: SpaceViewInviteDialogProps;
  readonly reactions?: SpaceViewReactions;
  readonly toasts?: readonly Toast[];
  readonly onDismissToast?: (id: string) => void;
  readonly reconnecting?: Omit<ReconnectingOverlayProps, "isVisible"> & {
    readonly isVisible: boolean;
  };
  readonly overlay?: React.ReactNode;
  readonly onLeft?: () => void | Promise<void>;
  readonly onEndEpisode?: () => void | Promise<void>;
  readonly className?: string;
}

const DEFAULT_REACTIONS: readonly Reaction[] = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

export function SpaceView({
  spaceName,
  displayName,
  logoUrl,
  inviteLink,
  duration = 0,
  layout = "focus",
  onLayoutChange,
  participants,
  audioParticipants = [],
  screenShare,
  whiteboard,
  controls = { buttons: [] },
  mobileControlButtons,
  panels,
  infoDialog,
  settingsDialog,
  inviteDialog,
  reactions,
  toasts = [],
  onDismissToast,
  reconnecting,
  overlay,
  onLeft,
  onEndEpisode,
  className,
}: SpaceViewProps): React.JSX.Element {
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [isLeaveDialogOpen, setLeaveDialogOpen] = useState(false);

  const panelContent = panels ? renderPanel(panels) : null;
  const desktopButtons = controls.buttons;
  const compactButtons = mobileControlButtons ? [...mobileControlButtons] : desktopButtons;
  const openReactionPicker = () => {
    setReactionPickerOpen(true);
    controls.onOpenReactions?.();
  };
  const closeReactionPicker = () => setReactionPickerOpen(false);
  const confirmLeave = () => {
    setLeaveDialogOpen(false);
    void onLeft?.();
  };
  const confirmEndEpisode = () => {
    setLeaveDialogOpen(false);
    void onEndEpisode?.();
  };

  const controlProps = {
    ...controls,
    participantColorSeed: controls.participantColorSeed ?? displayName,
    duration: duration,
    onOpenReactions: reactions ? openReactionPicker : controls.onOpenReactions,
    onLeft: onLeft ? () => setLeaveDialogOpen(true) : undefined,
  };

  return (
    <main data-chalk className={cn("chalk-root chalk-textured-surface relative h-full min-h-0 overflow-hidden bg-[var(--chalk-canvas)] text-[var(--chalk-text)]", className)}>
      <section className="chalk-textured-surface relative mx-auto flex h-full w-full max-w-[1440px] flex-col overflow-hidden border-x border-[var(--chalk-line)] bg-[var(--chalk-chrome)]">
        <AudioOutput participants={[...audioParticipants]} />
        <SpaceHeader
          spaceName={spaceName}
          logoUrl={logoUrl}
          duration={duration}
          layout={layout}
          onLayoutChange={onLayoutChange}
          onInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
          onInvite={inviteDialog ? () => inviteDialog.onOpenChange(true) : undefined}
          onSettings={settingsDialog ? () => settingsDialog.onOpenChange(true) : undefined}
          className="relative z-20"
        />

        <div className={cn("relative mx-auto flex min-h-0 w-full max-w-[1320px] flex-1 gap-3 overflow-hidden px-3 pt-5 pb-3 sm:px-5 sm:pt-6 lg:px-8", panelContent && "lg:grid lg:grid-cols-[minmax(0,1fr)_340px]")}>
          <section className="chalk-textured-surface min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[var(--chalk-stage)]" aria-label="Space stage">
            {whiteboard?.isOpen ? (
              <WhiteboardView {...whiteboard.props} className={cn("h-full min-h-0", whiteboard.props.className)} />
            ) : layout === "presentation" && screenShare ? (
              (screenShare.content ?? <ScreenShareView {...screenShare} participants={[...participants]} className="h-full" />)
            ) : (
              <ParticipantGrid participants={[...participants]} layout={layout} className="h-full" screenShareContent={layout === "presentation" ? screenShare?.content : undefined} />
            )}
          </section>

          {panelContent ? (
            <aside className="chalk-textured-surface absolute inset-x-3 top-20 bottom-24 z-40 min-h-0 overflow-hidden rounded-[10px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)] lg:static lg:block lg:w-[340px] lg:shrink-0">{panelContent}</aside>
          ) : null}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
          <div className="pointer-events-auto hidden md:block">
            <ControlBar {...controlProps} placement="floating" density="comfortable" buttons={desktopButtons} />
          </div>
          <div className="pointer-events-auto md:hidden">
            <ControlBar {...controlProps} placement="floating" density="compact" buttons={compactButtons} />
          </div>
        </div>

        <ReactionsOverlay reactions={reactions?.reactions.slice(-6) ?? []} />
        {reactions ? (
          <div className="absolute bottom-24 left-1/2 z-50 -translate-x-1/2">
            <ReactionPicker
              isOpen={isReactionPickerOpen}
              onClose={closeReactionPicker}
              allowedReactions={reactions.allowedReactions ?? DEFAULT_REACTIONS}
              onSelect={(reaction) => {
                const allowedReactions = reactions.allowedReactions ?? DEFAULT_REACTIONS;
                if (!isAllowedReaction(reaction, allowedReactions)) return;
                void Promise.resolve(reactions.onSelect(reaction)).finally(closeReactionPicker);
              }}
              size="compact"
            />
          </div>
        ) : null}

        {overlay}
        {reconnecting ? <ReconnectingOverlay {...reconnecting} /> : null}
        {infoDialog ? <SpaceInfoDialog {...infoDialog} isOpen={infoDialog.isOpen} onClose={() => infoDialog.onOpenChange(false)} /> : null}
        {settingsDialog ? <SettingsDialog {...settingsDialog} isOpen={settingsDialog.isOpen} onClose={() => settingsDialog.onOpenChange(false)} /> : null}
        {inviteDialog ? <InviteDialog {...inviteDialog} inviteLink={inviteDialog.inviteLink || inviteLink || ""} isOpen={inviteDialog.isOpen} onClose={() => inviteDialog.onOpenChange(false)} /> : null}
        {onLeft ? <LeaveDialog isOpen={isLeaveDialogOpen} onClose={() => setLeaveDialogOpen(false)} onConfirm={confirmLeave} onEndEpisode={onEndEpisode ? confirmEndEpisode : undefined} /> : null}
        {onDismissToast ? <ToastStack toasts={[...toasts]} onDismiss={onDismissToast} /> : null}
      </section>
    </main>
  );
}

function renderPanel(panels: SpaceViewPanelProps): React.ReactNode {
  switch (panels.active) {
    case "chat":
      return panels.chat ? <ChatPanel {...panels.chat} variant="sidebar" onClose={() => panels.onChange(null)} /> : null;
    case "participants":
      return panels.participants ? <ParticipantsPanel {...panels.participants} variant="sidebar" onClose={() => panels.onChange(null)} /> : null;
    case "transcript":
      return panels.transcript ? <TranscriptPanel {...panels.transcript} variant="sidebar" onClose={() => panels.onChange(null)} /> : null;
    case "admission":
      return panels.admission ? <AdmissionPanel {...panels.admission} /> : null;
    case "settings":
      return panels.settings ?? null;
    case null:
      return null;
  }
}

function isAllowedReaction(value: string, allowedReactions: readonly Reaction[]): value is Reaction {
  return allowedReactions.some((reaction) => reaction === value);
}
