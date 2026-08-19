"use client";

import type { Reaction } from "@q9labsai/chalk-client";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useCan, useMedia, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { cn } from "../../utils/cn";
import { AudioOutput } from "../audio-output/AudioOutput";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ChatPanel } from "../composite/ChatPanel";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { ScreenShareView } from "../composite/ScreenShareView";
import { SettingsPanel } from "../composite/SettingsPanel";
import { ControlBar, type ControlBarButtonName } from "../control-bar/ControlBar";
import { InviteDialog } from "../invite-dialog/InviteDialog";
import { LeaveDialog } from "../leave-dialog/LeaveDialog";
import { ParticipantGrid } from "../participant-grid/ParticipantGrid";
import { ParticipantsPanel } from "../participants-panel/ParticipantsPanel";
import { ParticipantVolumeProvider } from "../participants-panel/participant-volume-context";
import { ReconnectingOverlay } from "../reconnecting-overlay/ReconnectingOverlay";
import { SpaceHeader } from "../space-header/SpaceHeader";
import { SpaceInfoDialog } from "../space-info-dialog/SpaceInfoDialog";
import { TranscriptPanel } from "../transcript-panel/TranscriptPanel";
import { WhiteboardView } from "../whiteboard-view/WhiteboardView";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { getThemeMode } from "../theme";
import type { SpacePanel, SpaceViewFeatures, SpaceViewProps } from "./SpaceView";

const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

export function ClassicSpaceView({
  spaceName,
  logoUrl,
  inviteLink,
  pickChatFiles,
  palette = "light",
  texture = "none",
  layout: controlledLayout,
  onLayoutChange,
  initialPanel = null,
  features,
  infoDialog,
  inviteDialog,
  settingsDialog,
  onOpenDiagnostics,
  onOpenFeedback,
  onOpenSettings,
  onToggleWhiteboard,
  whiteboard,
  reconnecting,
  overlay,
  onLeft,
  onEndEpisode,
  className,
}: SpaceViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const media = useMedia();
  const canPublishScreen = useCan("publishScreen");
  const canSendChat = useCan("sendChat");
  const canSendReaction = useCan("sendReaction");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canManageAdmission = useCan("manageAdmission");
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus" | "presentation">("focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [isLeaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const layout = controlledLayout ?? uncontrolledLayout;
  const feature = (name: keyof SpaceViewFeatures) => features?.[name] !== false;
  const localId = self.participantId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantsSlice.roster, self.displayName]);
  const hasActiveScreenShare = Boolean(tiles.find((participant) => participant.isScreenSharing && participant.screenShareTrack));
  const renderedLayout = hasActiveScreenShare ? "presentation" : layout;

  useEffect(() => setActivePanel(initialPanel), [initialPanel]);

  useEffect(() => {
    if (feature("admission") && canManageAdmission && participantsSlice.admissionQueue.length > 0) setActivePanel("admission");
  }, [canManageAdmission, participantsSlice.admissionQueue.length, features?.admission]);
  const buttons: ControlBarButtonName[] = [
    "mic",
    "video",
    ...(feature("screenShare") && canPublishScreen ? ["screenshare" as const] : []),
    ...(feature("participants") ? ["participants" as const] : []),
    ...(feature("chat") && canSendChat ? ["chat" as const] : []),
    ...(feature("handRaise") ? ["handraise" as const] : []),
    ...(feature("reactions") && canSendReaction ? ["reactions" as const] : []),
    ...(feature("whiteboard") && canDrawWhiteboard ? ["whiteboard" as const] : []),
    ...(onOpenDiagnostics ? ["diagnostics" as const] : []),
    ...(feature("info") && infoDialog ? ["info" as const] : []),
    ...(feature("settings") ? ["settings" as const] : []),
    ...(onOpenFeedback ? ["feedback" as const] : []),
    "leave",
  ];

  const updateLayout = (nextLayout: "grid" | "focus" | "presentation") => {
    if (controlledLayout === undefined) setUncontrolledLayout(nextLayout);
    onLayoutChange?.(nextLayout);
  };

  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError(null);
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "This command could not be completed.");
    }
  }, []);

  const settingsContent = React.isValidElement<{ readonly onClose?: () => void }>(settingsDialog)
    ? React.cloneElement(settingsDialog, {
        onClose: () => {
          settingsDialog.props.onClose?.();
          setActivePanel(null);
        },
      })
    : settingsDialog;

  useEffect(() => {
    if (activePanel !== "settings" || !React.isValidElement<{ readonly isOpen?: boolean }>(settingsDialog) || settingsDialog.props.isOpen !== false) return;
    setActivePanel(null);
  }, [activePanel, settingsDialog]);

  return (
    <ParticipantVolumeProvider>
      <main
        data-chalk
        data-chalk-skin="classic"
        data-chalk-theme={getThemeMode(palette)}
        data-chalk-palette={palette}
        data-chalk-texture={texture}
        className={cn("chalk-root chalk-textured-surface relative h-full min-h-0 overflow-hidden bg-[var(--chalk-app-canvas)] text-[var(--chalk-app-text)]", className)}
      >
        <section className="chalk-textured-surface relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-chrome)]">
          <AudioOutput />
          <SpaceHeader
            spaceName={spaceName}
            logoUrl={logoUrl}
            layout={renderedLayout}
            onLayoutChange={updateLayout}
            onInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
            onInvite={inviteDialog ? () => inviteDialog.onOpenChange(true) : undefined}
            onSettings={
              feature("settings")
                ? () => {
                    setActivePanel("settings");
                    onOpenSettings?.();
                  }
                : undefined
            }
            className="relative z-20"
          />

          <div className={cn("relative flex min-h-0 w-full flex-1 gap-3 overflow-hidden px-3 pt-5 pb-3 sm:px-5 sm:pt-6 lg:px-8", activePanel && "lg:grid lg:grid-cols-[minmax(0,1fr)_340px]")}>
            <section className="chalk-textured-surface min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[var(--chalk-app-stage)]" aria-label="Space stage">
              {whiteboard?.isOpen ? <WhiteboardView {...whiteboard.props} className={cn("h-full min-h-0", whiteboard.props.className)} /> : hasActiveScreenShare ? <ScreenShareView className="h-full" /> : <ParticipantGrid layout={renderedLayout} className="h-full" />}
            </section>

            {activePanel ? (
              <aside className="chalk-textured-surface absolute inset-x-3 top-20 bottom-24 z-40 min-h-0 overflow-hidden rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] shadow-[var(--chalk-app-shadow-sm)] lg:static lg:block lg:w-[340px] lg:shrink-0">
                {activePanel === "chat" && feature("chat") && canSendChat ? <ChatPanel variant="sidebar" onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
                {activePanel === "participants" && feature("participants") ? <ParticipantsPanel variant="sidebar" onClose={() => setActivePanel(null)} /> : null}
                {activePanel === "transcript" && feature("transcript") ? <TranscriptPanel variant="sidebar" onClose={() => setActivePanel(null)} /> : null}
                {activePanel === "admission" && feature("admission") ? <AdmissionPanel /> : null}
                {activePanel === "settings" && feature("settings") ? (settingsContent ?? <SettingsPanel onClose={() => setActivePanel(null)} />) : null}
              </aside>
            ) : null}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
            <div className="pointer-events-auto hidden md:block">
              <ControlBar
                placement="floating"
                density="comfortable"
                buttons={buttons}
                activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
                onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
                onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
                onToggleWhiteboard={onToggleWhiteboard}
                onOpenReactions={() => setReactionPickerOpen(true)}
                onOpenInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
                onOpenDiagnostics={onOpenDiagnostics}
                onOpenFeedback={onOpenFeedback}
                onOpenSettings={() => {
                  setActivePanel("settings");
                  onOpenSettings?.();
                }}
                onCommandError={setCommandError}
                onLeaveRequest={onLeft ? () => setLeaveDialogOpen(true) : undefined}
              />{" "}
            </div>
            <div className="pointer-events-auto md:hidden">
              <ControlBar
                placement="floating"
                density="compact"
                buttons={buttons}
                activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
                onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
                onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
                onToggleWhiteboard={onToggleWhiteboard}
                onOpenReactions={() => setReactionPickerOpen(true)}
                onOpenInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
                onOpenDiagnostics={onOpenDiagnostics}
                onOpenFeedback={onOpenFeedback}
                onOpenSettings={() => {
                  setActivePanel("settings");
                  onOpenSettings?.();
                }}
                onCommandError={setCommandError}
                onLeaveRequest={onLeft ? () => setLeaveDialogOpen(true) : undefined}
              />{" "}
            </div>
          </div>

          {feature("reactions") ? <ReactionsOverlay /> : null}
          {feature("reactions") && canSendReaction ? (
            <div className="absolute bottom-24 left-1/2 z-50 -translate-x-1/2">
              <ReactionPicker isOpen={isReactionPickerOpen} onClose={() => setReactionPickerOpen(false)} allowedReactions={[...DEFAULT_REACTIONS]} onSelect={(reaction) => void runCommand(() => client.reactions.send(reaction as Reaction)).finally(() => setReactionPickerOpen(false))} size="compact" />
            </div>
          ) : null}
          {overlay}
          <CommandErrorAlert message={commandError ?? undefined} />
          {reconnecting ? <ReconnectingOverlay {...reconnecting} /> : null}
          {infoDialog ? <SpaceInfoDialog {...infoDialog} isOpen={infoDialog.isOpen} onClose={() => infoDialog.onOpenChange(false)} /> : null}
          {inviteDialog ? <InviteDialog {...inviteDialog} inviteLink={inviteDialog.inviteLink || inviteLink || ""} isOpen={inviteDialog.isOpen} onClose={() => inviteDialog.onOpenChange(false)} /> : null}
          {onLeft ? (
            <LeaveDialog
              isOpen={isLeaveDialogOpen}
              onClose={() => setLeaveDialogOpen(false)}
              onConfirm={() => {
                setLeaveDialogOpen(false);
                void runCommand(() => Promise.resolve(onLeft()));
              }}
              onEndEpisode={
                onEndEpisode
                  ? () => {
                      setLeaveDialogOpen(false);
                      void runCommand(() => Promise.resolve(onEndEpisode()));
                    }
                  : undefined
              }
              palette={palette}
              texture={texture}
            />
          ) : null}
        </section>
      </main>
    </ParticipantVolumeProvider>
  );
}
