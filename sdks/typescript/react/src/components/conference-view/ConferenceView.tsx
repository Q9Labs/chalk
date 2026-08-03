"use client";

import type { ChalkReaction, ChalkRoomReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useState } from "react";

import { AudioOutput, type AudioParticipant } from "../audio-output/AudioOutput";
import { ChatPanel, type ChatPanelProps } from "../composite/ChatPanel";
import { ConferenceHeader } from "../conference-header/ConferenceHeader";
import { ConferenceInfoDialog, type ConferenceInfoDialogProps } from "../conference-info-dialog/ConferenceInfoDialog";
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

export type ConferenceLayout = NonNullable<ParticipantGridProps["layout"]>;
export type ConferencePanel = "chat" | "participants" | "transcript" | "admission" | "settings";
export type ThemePalette = "light" | "warm-charcoal" | "cool-graphite" | "high-contrast-ink" | "espresso-night" | "chalkboard-atelier" | "prism-nocturne" | "oled-signal";
export type ThemeTexture = "none" | "paper" | "slate";

export type ConferenceViewPanelProps = {
  readonly active: ConferencePanel | null;
  readonly onChange: (panel: ConferencePanel | null) => void;
  readonly chat?: Omit<ChatPanelProps, "variant" | "onClose">;
  readonly participants?: Omit<ParticipantsPanelProps, "variant" | "onClose">;
  readonly transcript?: Omit<TranscriptPanelProps, "variant" | "onClose">;
  readonly admission?: AdmissionPanelProps;
  readonly settings?: React.ReactNode;
};

export type ConferenceViewSettingsDialogProps = Omit<React.ComponentProps<typeof SettingsDialog>, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type ConferenceViewInfoDialogProps = Omit<ConferenceInfoDialogProps, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type ConferenceViewInviteDialogProps = Omit<InviteDialogProps, "isOpen" | "onClose"> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export type ConferenceViewReactions = {
  readonly reactions: readonly ChalkRoomReaction[];
  readonly allowedReactions?: readonly ChalkReaction[];
  readonly onSelect: (reaction: ChalkReaction) => void | Promise<void>;
};

export type ConferenceViewScreenShare = Omit<ScreenShareViewProps, "participants" | "className"> & {
  readonly content?: React.ReactNode;
};

export type ConferenceViewWhiteboard = {
  readonly isOpen: boolean;
  readonly props: WhiteboardViewProps;
};

export interface ConferenceViewProps {
  readonly roomName: string;
  readonly displayName: string;
  readonly logoUrl?: string;
  readonly meetingLink?: string;
  readonly duration?: number;
  readonly layout?: ConferenceLayout;
  readonly onLayoutChange?: (layout: ConferenceLayout) => void;
  readonly participants: readonly Participant[];
  readonly audioParticipants?: readonly AudioParticipant[];
  readonly screenShare?: ConferenceViewScreenShare;
  readonly whiteboard?: ConferenceViewWhiteboard;
  readonly controls?: Omit<ControlBarProps, "placement" | "density" | "meetingDuration" | "onLeave">;
  readonly mobileControlButtons?: readonly ControlBarButtonName[];
  readonly panels?: ConferenceViewPanelProps;
  readonly infoDialog?: ConferenceViewInfoDialogProps;
  readonly settingsDialog?: ConferenceViewSettingsDialogProps;
  readonly inviteDialog?: ConferenceViewInviteDialogProps;
  readonly reactions?: ConferenceViewReactions;
  readonly toasts?: readonly Toast[];
  readonly onDismissToast?: (id: string) => void;
  readonly reconnecting?: Omit<ReconnectingOverlayProps, "isVisible"> & {
    readonly isVisible: boolean;
  };
  readonly palette?: ThemePalette;
  readonly texture?: ThemeTexture;
  readonly overlay?: React.ReactNode;
  readonly onLeave?: () => void | Promise<void>;
  readonly className?: string;
}

const DEFAULT_REACTIONS: readonly ChalkReaction[] = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

export function ConferenceView({
  roomName,
  displayName,
  logoUrl,
  meetingLink,
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
  palette = "light",
  texture = "none",
  overlay,
  onLeave,
  className,
}: ConferenceViewProps): React.JSX.Element {
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
    void onLeave?.();
  };

  const controlProps = {
    ...controls,
    participantColorSeed: controls.participantColorSeed ?? displayName,
    meetingDuration: duration,
    onOpenReactions: reactions ? openReactionPicker : controls.onOpenReactions,
    onLeave: onLeave ? () => setLeaveDialogOpen(true) : undefined,
  };

  return (
    <main
      data-chalk
      data-chalk-theme={palette === "light" ? "light" : "dark"}
      data-chalk-palette={palette}
      data-chalk-texture={texture}
      className={cn("chalk-root chalk-textured-surface relative h-dvh min-h-[620px] overflow-hidden bg-[var(--chalk-app-canvas)] text-[var(--chalk-app-text)]", className)}
    >
      <section className="chalk-textured-surface relative mx-auto flex h-full w-full max-w-[1440px] flex-col overflow-hidden border-x border-[var(--chalk-app-line)] bg-[var(--chalk-app-chrome)]">
        <AudioOutput participants={[...audioParticipants]} />
        <ConferenceHeader
          roomName={roomName}
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
          <section className="chalk-textured-surface min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[var(--chalk-app-stage)]" aria-label="Meeting stage">
            {whiteboard?.isOpen ? (
              <WhiteboardView {...whiteboard.props} className={cn("h-full min-h-0", whiteboard.props.className)} />
            ) : layout === "presentation" && screenShare ? (
              (screenShare.content ?? <ScreenShareView {...screenShare} participants={[...participants]} className="h-full" />)
            ) : (
              <ParticipantGrid participants={[...participants]} layout={layout} className="h-full" screenShareContent={layout === "presentation" ? screenShare?.content : undefined} />
            )}
          </section>

          {panelContent ? (
            <aside className="chalk-textured-surface absolute inset-x-3 top-20 bottom-24 z-40 min-h-0 overflow-hidden rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] shadow-[var(--chalk-app-shadow-sm)] lg:static lg:block lg:w-[340px] lg:shrink-0">
              {panelContent}
            </aside>
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
        {infoDialog ? <ConferenceInfoDialog {...infoDialog} isOpen={infoDialog.isOpen} onClose={() => infoDialog.onOpenChange(false)} /> : null}
        {settingsDialog ? <SettingsDialog {...settingsDialog} isOpen={settingsDialog.isOpen} onClose={() => settingsDialog.onOpenChange(false)} /> : null}
        {inviteDialog ? <InviteDialog {...inviteDialog} meetingLink={inviteDialog.meetingLink || meetingLink || ""} isOpen={inviteDialog.isOpen} onClose={() => inviteDialog.onOpenChange(false)} /> : null}
        {onLeave ? <LeaveDialog isOpen={isLeaveDialogOpen} onClose={() => setLeaveDialogOpen(false)} onConfirm={confirmLeave} /> : null}
        {onDismissToast ? <ToastStack toasts={[...toasts]} onDismiss={onDismissToast} /> : null}
      </section>
    </main>
  );
}

function renderPanel(panels: ConferenceViewPanelProps): React.ReactNode {
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

function isAllowedReaction(value: string, allowedReactions: readonly ChalkReaction[]): value is ChalkReaction {
  return allowedReactions.some((reaction) => reaction === value);
}
