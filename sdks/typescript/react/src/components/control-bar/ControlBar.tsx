import { commandFailureMessage } from "./command-failure";
import { LazyDeviceAccessWaiting } from "../device-access/LazyDeviceAccessCard";
import { isDeviceAccessFailure } from "../device-access/model";
import React, { Suspense, useEffect, useState } from "react";
import { ChalkIconButton, ChalkTooltip } from "../chalk-ui";
import { cn } from "../../utils/cn";
import { HandIcon, VolumeHighIcon } from "../../utils/icons";
import { DevicePopover } from "../device-popover/DevicePopover";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { CallLinkIcon } from "./CallLinkIcon";
import { LeaveMenu } from "./LeaveMenu";
import { DockLayout } from "./DockLayout";
import { ShareControl } from "./ShareControl";
import { useConnectedControlBarBehavior, useControlBarSurfaceBehavior, type ControlBarSurfaceProps, type ControlBarProps, type MediaDevice } from "./control-bar-behavior";
import { MediaGlyph, ShellIcon } from "./ShellIcon";
import { nextCamera } from "./next-camera";
import { ShellStyles } from "./ShellStyles";
export type { ControlBarProps, ControlBarButtonName } from "./control-bar-behavior";
export function ControlBarPresentation(props: ControlBarSurfaceProps): React.JSX.Element {
  return <ControlBarSurface {...props} detectDevices={props.displayOnly ? false : props.detectDevices} />;
}

/** The selected device's name, or the first one when none is chosen yet, for a row of the More sheet. */
function DeviceValue({ devices, selectedDeviceId }: { readonly devices: readonly MediaDevice[]; readonly selectedDeviceId?: string }) {
  const device = devices.find((candidate) => candidate.deviceId === selectedDeviceId) ?? devices[0];
  return device?.label ? <span className="chalk-sheet-value">{device.label}</span> : null;
}

export const ControlBarSurface = React.memo((props: ControlBarSurfaceProps) => {
  const { buttonsToRender, effectiveAudioInputDevices, effectiveAudioOutputDevices, effectiveVideoInputDevices, showLeave } = useControlBarSurfaceBehavior({ ...props, density: props.density ?? "comfortable", detectDevices: props.detectDevices ?? true });
  const [canCaptureDisplay, setCanCaptureDisplay] = useState(false);
  const [deviceSheet, setDeviceSheet] = useState<"mic" | "video" | null>(null);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Detect display-capture support after hydration so server and first client markup agree.
  useEffect(() => setCanCaptureDisplay(typeof navigator.mediaDevices?.getDisplayMedia === "function"), []);
  const has = (button: (typeof buttonsToRender)[number]) => buttonsToRender.includes(button);
  const iconButton = (label: string, icon: React.ReactNode, onClick?: () => void, active?: boolean, badge = 0) => (
    <ChalkTooltip
      trigger={
        <ChalkIconButton size="lg" aria-label={label} aria-pressed={active} onClick={onClick}>
          {icon}
          {badge > 0 ? <span className="chalk-shell-dot" aria-label={`${badge} unread`} /> : null}
        </ChalkIconButton>
      }
    >
      {label}
    </ChalkTooltip>
  );
  const chat = has("chat") && (props.onToggleChat || props.displayOnly) ? iconButton("Chat", <ShellIcon name="chat" />, props.onToggleChat, props.isChatOpen, props.isChatOpen ? 0 : props.unreadChatCount) : null;
  const copyLink = () => void navigator.clipboard.writeText(props.shareUrl ?? location.href).catch(() => props.onCopyError?.());
  const linkLabel = props.onCallLinkToggle ? (props.callLinkOpen ? "Hide call link" : "Show call link") : "Copy call link";
  const reactions =
    has("reactions") && (props.onOpenReactions || props.displayOnly) ? (
      <ChalkTooltip
        trigger={
          <ChalkIconButton
            size="lg"
            className="chalk-shell-reactions-button"
            data-reactions-trigger
            data-hand-raised={props.isHandRaised || undefined}
            aria-label={props.isHandRaised ? "Reactions, hand raised" : "Reactions"}
            aria-expanded={props.reactionsOpen}
            onClick={props.onOpenReactions}
            disabled={props.reactionsDisabled}
          >
            <ShellIcon name="smile" className="chalk-shell-reactions-smile" />
            <ShellIcon name="hand" className="chalk-shell-reactions-hand" />
          </ChalkIconButton>
        }
      >
        Reactions
      </ChalkTooltip>
    ) : null;
  return (
    <div data-part="dock" className={cn("chalk-shell-dock", props.className)} role="toolbar" aria-label="Space controls">
      <ShellStyles />
      {has("mic") ? (
        <DevicePopover
          type="mic"
          isActive={!props.isMuted}
          busy={props.microphonePending}
          onCancelPending={props.onCancelMicrophonePending}
          toggleDisabled={props.mediaEnableDisabled && props.isMuted}
          onToggle={props.onToggleMute ?? (() => {})}
          devices={effectiveAudioInputDevices}
          selectedDeviceId={props.selectedAudioInput}
          onDeviceChange={props.onAudioInputChange ?? (() => {})}
          secondaryDevices={effectiveAudioOutputDevices}
          selectedSecondaryDeviceId={props.selectedAudioOutput}
          onSecondaryDeviceChange={props.onAudioOutputChange}
          track={props.microphoneTrack}
          warning={props.microphoneWarning}
          speakingWhileMuted={props.speakingWhileMuted}
          noiseSuppression={props.noiseSuppression}
          onNoiseSuppressionChange={props.onNoiseSuppressionChange}
          onTestSpeaker={props.onTestSpeaker}
          access={props.deviceAccess?.microphone}
          sheetOpen={deviceSheet === "mic"}
          onSheetOpenChange={(open) => setDeviceSheet(open ? "mic" : null)}
        />
      ) : null}
      {has("video") ? (
        <DevicePopover
          type="video"
          isActive={props.isVideoEnabled ?? true}
          busy={props.cameraPending}
          onCancelPending={props.onCancelCameraPending}
          toggleDisabled={props.mediaEnableDisabled && !props.isVideoEnabled}
          onToggle={props.onToggleVideo ?? (() => {})}
          devices={effectiveVideoInputDevices}
          selectedDeviceId={props.selectedVideoInput}
          onDeviceChange={props.onVideoInputChange ?? (() => {})}
          track={props.cameraTrack}
          captureCameraPreview={props.captureCameraPreview}
          warning={props.cameraWarning}
          mirrored={props.mirrored}
          onMirrorChange={props.onMirrorChange}
          access={props.deviceAccess?.camera}
          sheetOpen={deviceSheet === "video"}
          onSheetOpenChange={(open) => setDeviceSheet(open ? "video" : null)}
        />
      ) : null}
      {has("screenshare") && canCaptureDisplay ? (
        <ShareControl access={props.deviceAccess?.screen} disabled={props.mediaEnableDisabled && !props.isScreenSharing} startDisabled={props.mediaEnableDisabled} sharing={props.isScreenSharing ?? false} onToggle={props.onToggleScreenShare} onStart={props.onStartScreenShare} />
      ) : null}
      {reactions}
      {(!reactions || props.reactionsDisabled) && has("handraise") ? iconButton(props.isHandRaised ? "Lower hand" : "Raise hand", <HandIcon />, props.onToggleHandRaise, props.isHandRaised) : null}
      {has("whiteboard") && (props.onToggleWhiteboard || props.displayOnly) ? <span className="chalk-shell-desktop">{iconButton("Board", <ShellIcon name="pen" />, props.onToggleWhiteboard, props.isWhiteboardOpen)}</span> : null}

      <span className="chalk-shell-phone">
        <DockLayout
          layout={props.layout ?? "focus"}
          onLayoutChange={props.onLayoutChange ?? (() => {})}
          devices={
            <>
              {has("mic") ? (
                <button type="button" className="chalk-sheet-row" aria-haspopup="dialog" onClick={() => setDeviceSheet("mic")}>
                  <VolumeHighIcon />
                  <span className="chalk-sheet-label-text">Microphone and speaker</span>
                  <DeviceValue devices={effectiveAudioInputDevices} selectedDeviceId={props.selectedAudioInput} />
                </button>
              ) : null}
              {has("video") ? (
                <button type="button" className="chalk-sheet-row" aria-haspopup="dialog" onClick={() => setDeviceSheet("video")}>
                  <MediaGlyph kind="cam" slashed={false} busy={false} />
                  <span className="chalk-sheet-label-text">Camera</span>
                  <DeviceValue devices={effectiveVideoInputDevices} selectedDeviceId={props.selectedVideoInput} />
                </button>
              ) : null}
            </>
          }
        >
          {has("video") && effectiveVideoInputDevices.length >= 2 ? (
            <button
              type="button"
              className="chalk-sheet-row"
              disabled={!props.onVideoInputChange}
              onClick={() => {
                const camera = nextCamera(effectiveVideoInputDevices, props.selectedVideoInput, props.cameraTrack);
                if (camera) props.onVideoInputChange?.(camera.deviceId);
              }}
            >
              <ShellIcon name="flip" />
              <span>Flip camera</span>
            </button>
          ) : null}
          {has("screenshare") && canCaptureDisplay ? (
            <button type="button" className="chalk-sheet-row" disabled={props.mediaEnableDisabled && !props.isScreenSharing} onClick={props.deviceAccess?.screen ? () => props.deviceAccess?.screen?.onOpenChange(true) : props.onToggleScreenShare}>
              <ShellIcon name="share" />
              <span>{props.isScreenSharing ? "Stop sharing" : "Share screen"}</span>
            </button>
          ) : null}
          {has("whiteboard") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleWhiteboard}>
              <ShellIcon name="pen" />
              <span>Board</span>
            </button>
          ) : null}
          {has("chat") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleChat}>
              <ShellIcon name="chat" />
              <span>Chat</span>
              {props.unreadChatCount && !props.isChatOpen ? (
                <span className="chalk-sheet-badge" aria-label={`${props.unreadChatCount} unread`}>
                  {props.unreadChatCount}
                </span>
              ) : null}
              <ShellIcon name="right" size={20} className="chalk-shell-sheet-end" />
            </button>
          ) : null}
          {has("participants") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleParticipants}>
              <ShellIcon name="users" />
              <span>People</span>
              <ShellIcon name="right" size={20} className="chalk-shell-sheet-end" />
            </button>
          ) : null}
        </DockLayout>
      </span>
      {showLeave ? (
        <LeaveMenu
          onLeave={props.onLeft}
          onEndForEveryone={props.onEndForEveryone}
          renderButton={(buttonProps) => (
            <ChalkIconButton {...buttonProps} size="lg" tone="danger" aria-label="Leave call">
              <ShellIcon name="hang" />
            </ChalkIconButton>
          )}
        />
      ) : null}
      <span className="chalk-shell-corner chalk-shell-people">
        <ChalkTooltip
          trigger={
            <ChalkIconButton size="lg" data-call-link-trigger aria-label={linkLabel} aria-pressed={props.onCallLinkToggle ? (props.callLinkOpen ?? false) : undefined} onClick={props.onCallLinkToggle ?? copyLink}>
              <CallLinkIcon />
            </ChalkIconButton>
          }
        >
          {linkLabel}
        </ChalkTooltip>
      </span>
      {has("record") && (props.onToggleRecording || props.displayOnly) ? (
        <span className="chalk-shell-corner chalk-shell-record chalk-shell-desktop">{iconButton(props.isRecording ? "Stop recording" : "Record", <ShellIcon name="rec" />, props.isRecordingPending ? undefined : props.onToggleRecording, props.isRecording)}</span>
      ) : null}
      <span className="chalk-shell-corner chalk-shell-chat">{chat}</span>
    </div>
  );
});
ControlBarSurface.displayName = "ControlBarSurface";
export function ControlBar(props: ControlBarProps): React.JSX.Element {
  const { surfaceProps, commandError, commandSource, commandAction, mediaNotice, requestingDevice, cardUnavailable } = useConnectedControlBarBehavior(props);
  const failure = !props.onCommandError && commandError && (cardUnavailable || !isDeviceAccessFailure(commandError, commandSource)) ? commandFailureMessage(commandError, commandSource, commandAction) : undefined;
  return (
    <>
      <ControlBarSurface {...surfaceProps} />
      <CommandErrorAlert message={mediaNotice ?? failure} />
      {requestingDevice ? (
        <Suspense fallback={null}>
          <LazyDeviceAccessWaiting device={requestingDevice} />
        </Suspense>
      ) : null}
    </>
  );
}
