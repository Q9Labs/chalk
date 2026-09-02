"use client";

import type { Reaction } from "@q9labsai/chalk-client";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useAdmissionControl, useCan, useMedia, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { useEpisodeDuration } from "../../internal/useEpisodeDuration";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { useSoundCues } from "../../internal/useSoundCues";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { cn } from "../../utils/cn";
import { AudioOutput } from "../audio-output/AudioOutput";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ChatPanel } from "../composite/ChatPanel";
import { ReactionPicker } from "../composite/ReactionPicker";
import { ReactionsOverlay } from "../composite/ReactionsOverlay";
import { SettingsPanel } from "../composite/SettingsPanel";
import { ControlBar, type ControlBarButtonName } from "../control-bar/ControlBar";
import { InviteDialog } from "../invite-dialog/InviteDialog";
import { LeaveDialog } from "../leave-dialog/LeaveDialog";
import { ParticipantsPanel } from "../participants-panel/ParticipantsPanel";
import { ParticipantVolumeProvider } from "../participants-panel/participant-volume-context";
import { ReconnectingOverlay } from "../reconnecting-overlay/ReconnectingOverlay";
import { SpaceHeader } from "../space-header/SpaceHeader";
import { SpaceInfoDialog } from "../space-info-dialog/SpaceInfoDialog";
import { TranscriptPanel } from "../transcript-panel/TranscriptPanel";
import { ToastStack, type Toast } from "../toast-stack/ToastStack";
import { getThemeMode } from "../theme";
import type { SpacePanel, SpaceViewFeatures, SpaceViewProps } from "./SpaceView";
import { SpaceDrawer } from "./SpaceDrawer";
import { SpaceStage } from "./SpaceStage";
import { DRAWER_EXIT_MS, useDrawerPresence } from "./useDrawerPresence";
import { useContentLayoutSwitch } from "./useContentLayoutSwitch";

const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

export function ClassicSpaceView({
  spaceName,
  logoUrl,
  inviteLink,
  pickChatFiles,
  palette = "light",
  texture = "none",
  stageBackground = true,
  layout: controlledLayout,
  onLayoutChange,
  initialPanel = null,
  features,
  infoDialog,
  inviteDialog,
  settingsDialog,
  generatedAvatars = true,
  commandError: externalCommandError,
  onDismissCommandError,
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
  const admissionControl = useAdmissionControl();
  const media = useMedia();
  const canPublishScreen = useCan("publishScreen");
  const canSendChat = useCan("sendChat");
  const canSendReaction = useCan("sendReaction");
  const canDrawWhiteboard = useCan("drawWhiteboard");
  const canManageAdmission = useCan("manageAdmission");
  const episodeDuration = useEpisodeDuration();
  const [uncontrolledLayout, setUncontrolledLayout] = useState<"grid" | "focus" | "presentation">("focus");
  const [activePanel, setActivePanel] = useState<SpacePanel | null>(initialPanel);
  const [isReactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [isLeaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [leavePending, setLeavePending] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [endEpisodePending, setEndEpisodePending] = useState(false);
  const [endEpisodeError, setEndEpisodeError] = useState<string | null>(null);
  const layout = controlledLayout ?? uncontrolledLayout;
  const feature = (name: keyof SpaceViewFeatures) => features?.[name] !== false;
  const localId = self.participantId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantsSlice.roster, self.displayName]);

  useEffect(() => setActivePanel(initialPanel), [initialPanel]);

  useEffect(() => {
    if (feature("admission") && feature("participants") && canManageAdmission && participantsSlice.admissionQueue.length + (admissionControl?.requests.length ?? 0) > 0) setActivePanel("participants");
  }, [admissionControl?.requests.length, canManageAdmission, participantsSlice.admissionQueue.length, features?.admission, features?.participants]);
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
    ...(onOpenFeedback ? ["feedback" as const] : []),
    "leave",
  ];

  const updateLayout = (nextLayout: "grid" | "focus" | "presentation") => {
    if (controlledLayout === undefined) setUncontrolledLayout(nextLayout);
    onLayoutChange?.(nextLayout);
  };
  const hasStageContent = whiteboard?.isOpen === true || tiles.some((tile) => tile.isScreenSharing === true && Boolean(tile.screenShareTrack));
  useContentLayoutSwitch(hasStageContent, layout, updateLayout);
  useSoundCues(feature("sounds"));
  const prefersReducedMotion = usePrefersReducedMotion();
  const settingsDialogIsControlled = React.isValidElement<{ readonly isOpen?: boolean }>(settingsDialog) && typeof settingsDialog.props.isOpen === "boolean";
  const drawerPanel = settingsDialogIsControlled && activePanel === "settings" ? null : activePanel;
  const drawer = useDrawerPresence(drawerPanel, prefersReducedMotion ? 0 : DRAWER_EXIT_MS);
  const openSettings = () => {
    if (!settingsDialogIsControlled) setActivePanel("settings");
    onOpenSettings?.();
  };

  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    try {
      await command();
      setCommandError(null);
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "This command could not be completed.");
    }
  }, []);

  const leaveSpace = async () => {
    if (!onLeft || leavePending) return;
    setLeavePending(true);
    setLeaveError(null);
    try {
      await onLeft();
      setLeaveDialogOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not leave this Space.";
      setLeaveError(message);
      setCommandError(message);
    } finally {
      setLeavePending(false);
    }
  };

  const endEpisode = async () => {
    if (!onEndEpisode || endEpisodePending) return;
    setEndEpisodePending(true);
    setEndEpisodeError(null);
    try {
      await onEndEpisode();
      setLeaveDialogOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not end this Episode.";
      setEndEpisodeError(message);
      setCommandError(message);
    } finally {
      setEndEpisodePending(false);
    }
  };

  const displayedCommandError = externalCommandError ?? commandError;
  const commandToasts: Toast[] = displayedCommandError ? [{ id: "space-command-error", message: displayedCommandError, type: "error" }] : [];
  const dismissCommandError = () => {
    setCommandError(null);
    onDismissCommandError?.();
  };

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
          <SpaceHeader spaceName={spaceName} logoUrl={logoUrl} duration={episodeDuration} layout={layout} onLayoutChange={updateLayout} onInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined} onSettings={feature("settings") ? openSettings : undefined} className="relative z-20" />

          <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pt-1 sm:px-4 lg:px-5">
              <section className={cn("min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px]", stageBackground ? "chalk-textured-surface bg-[var(--chalk-app-stage)]" : "bg-transparent")} aria-label="Space stage">
                <SpaceStage tiles={tiles} layout={layout} generatedAvatars={generatedAvatars} whiteboard={whiteboard} className="h-full" />
              </section>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
                <div className="pointer-events-auto hidden md:block">
                  <ControlBar
                    placement="floating"
                    density="comfortable"
                    duration={episodeDuration}
                    buttons={buttons}
                    activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
                    onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
                    onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
                    onToggleWhiteboard={onToggleWhiteboard}
                    onOpenReactions={() => setReactionPickerOpen((current) => !current)}
                    onOpenInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
                    onOpenDiagnostics={onOpenDiagnostics}
                    onOpenFeedback={onOpenFeedback}
                    onOpenSettings={openSettings}
                    onCommandError={setCommandError}
                    onLeaveRequest={onLeft ? () => setLeaveDialogOpen(true) : undefined}
                  />{" "}
                </div>
                <div className="pointer-events-auto md:hidden">
                  <ControlBar
                    placement="floating"
                    density="compact"
                    duration={episodeDuration}
                    buttons={buttons}
                    activePanel={activePanel === "chat" || activePanel === "participants" ? activePanel : null}
                    onToggleChat={() => setActivePanel((current) => (current === "chat" ? null : "chat"))}
                    onToggleParticipants={() => setActivePanel((current) => (current === "participants" ? null : "participants"))}
                    onToggleWhiteboard={onToggleWhiteboard}
                    onOpenReactions={() => setReactionPickerOpen((current) => !current)}
                    onOpenInfo={infoDialog ? () => infoDialog.onOpenChange(true) : undefined}
                    onOpenDiagnostics={onOpenDiagnostics}
                    onOpenFeedback={onOpenFeedback}
                    onOpenSettings={openSettings}
                    onCommandError={setCommandError}
                    onLeaveRequest={onLeft ? () => setLeaveDialogOpen(true) : undefined}
                  />{" "}
                </div>
              </div>

              {feature("reactions") ? <ReactionsOverlay /> : null}
              {feature("reactions") && canSendReaction ? (
                <div className="absolute bottom-24 left-1/2 z-50 -translate-x-1/2">
                  <ReactionPicker
                    isOpen={isReactionPickerOpen}
                    onClose={() => setReactionPickerOpen(false)}
                    allowedReactions={[...DEFAULT_REACTIONS]}
                    onSelect={(reaction) => void runCommand(() => client.reactions.send(reaction as Reaction)).finally(() => setReactionPickerOpen(false))}
                    size="compact"
                  />
                </div>
              ) : null}
            </div>

            <SpaceDrawer state={drawer.state} onClose={() => setActivePanel(null)}>
              {drawer.panel === "chat" && feature("chat") && canSendChat ? <ChatPanel variant="sidebar" generatedAvatars={generatedAvatars} onClose={() => setActivePanel(null)} pickChatFiles={pickChatFiles} /> : null}
              {drawer.panel === "participants" && feature("participants") ? <ParticipantsPanel variant="sidebar" admissionEnabled={feature("admission")} generatedAvatars={generatedAvatars} onCommandError={setCommandError} onClose={() => setActivePanel(null)} /> : null}
              {drawer.panel === "transcript" && feature("transcript") ? <TranscriptPanel variant="sidebar" onClose={() => setActivePanel(null)} /> : null}
              {drawer.panel === "admission" && feature("admission") ? <AdmissionPanel className="h-full w-full rounded-none shadow-none" onClose={() => setActivePanel(null)} /> : null}
              {drawer.panel === "settings" && feature("settings") && !settingsDialogIsControlled ? (settingsContent ?? <SettingsPanel className="w-full border-0 shadow-none" onClose={() => setActivePanel(null)} />) : null}
            </SpaceDrawer>
          </div>

          {settingsDialogIsControlled ? settingsContent : null}
          {overlay}
          <ToastStack toasts={commandToasts} onDismiss={dismissCommandError} position="bottom-right" palette={palette} texture={texture} />
          {reconnecting ? <ReconnectingOverlay {...reconnecting} /> : null}
          {infoDialog ? <SpaceInfoDialog {...infoDialog} duration={episodeDuration} isOpen={infoDialog.isOpen} onClose={() => infoDialog.onOpenChange(false)} /> : null}
          {inviteDialog ? <InviteDialog {...inviteDialog} inviteLink={inviteDialog.inviteLink || inviteLink || ""} isOpen={inviteDialog.isOpen} onClose={() => inviteDialog.onOpenChange(false)} /> : null}
          {onLeft ? (
            <LeaveDialog
              isOpen={isLeaveDialogOpen}
              onClose={() => setLeaveDialogOpen(false)}
              onConfirm={() => void leaveSpace()}
              onEndEpisode={onEndEpisode ? () => void endEpisode() : undefined}
              canEndEpisode={Boolean(onEndEpisode)}
              leavePending={leavePending}
              leaveError={leaveError}
              endEpisodePending={endEpisodePending}
              endEpisodeError={endEpisodeError}
              palette={palette}
              texture={texture}
            />
          ) : null}
        </section>
      </main>
    </ParticipantVolumeProvider>
  );
}
