import React, { useEffect, useRef, useState } from "react";
import { ChalkIconButton, ChalkTooltip } from "../chalk-ui";
import { cn } from "../../utils/cn";
import { HandIcon } from "../../utils/icons";
import { DevicePopover } from "../device-popover/DevicePopover";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { CallLinkIcon } from "./CallLinkIcon";
import { LeaveMenu } from "./LeaveMenu";
import { DockLayout } from "./DockLayout";
import { ShareControl } from "./ShareControl";
import { useConnectedControlBarBehavior, useControlBarSurfaceBehavior, type ControlBarSurfaceProps, type ControlBarProps } from "./control-bar-behavior";
import { ShellIcon } from "./ShellIcon";
import { nextCamera } from "./next-camera";
import { ShellStyles } from "./ShellStyles";
export type { ControlBarProps, ControlBarButtonName } from "./control-bar-behavior";
export function ControlBarPresentation(props: ControlBarSurfaceProps): React.JSX.Element {
  return <ControlBarSurface {...props} detectDevices={props.displayOnly ? false : props.detectDevices} />;
}

export const ControlBarSurface = React.memo((props: ControlBarSurfaceProps) => {
  const { buttonsToRender, effectiveAudioInputDevices, effectiveAudioOutputDevices, effectiveVideoInputDevices, showLeave } = useControlBarSurfaceBehavior({ ...props, density: props.density ?? "comfortable", detectDevices: props.detectDevices ?? true });
  const dock = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [canCaptureDisplay, setCanCaptureDisplay] = useState(false);
  useEffect(() => setCanCaptureDisplay(typeof navigator.mediaDevices?.getDisplayMedia === "function"), []);
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const has = (button: (typeof buttonsToRender)[number]) => buttonsToRender.includes(button);
  const iconButton = (label: string, icon: React.ReactNode, onClick?: () => void, active?: boolean, badge = 0, hand = false, disabled = false) => (
    <ChalkTooltip
      trigger={
        <ChalkIconButton size="lg" aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}>
          {icon}
          {badge > 0 ? <span className="chalk-shell-dot" aria-label={`${badge} unread`} /> : null}
          {hand ? <span className="chalk-shell-dot" aria-label="Hand raised" /> : null}
        </ChalkIconButton>
      }
    >
      {label}
    </ChalkTooltip>
  );
  const toggleFullscreen = () => {
    const frame = dock.current?.closest<HTMLElement>("[data-part=call-frame]") ?? dock.current?.closest<HTMLElement>("[data-chalk]");
    const request = document.fullscreenElement ? document.exitFullscreen() : frame?.requestFullscreen();
    void request?.then(() => setFullscreen(Boolean(document.fullscreenElement))).catch(() => props.onFullscreenError?.());
  };
  const chat = has("chat") && (props.onToggleChat || props.displayOnly) ? iconButton("Chat", <ShellIcon name="chat" />, props.onToggleChat, props.isChatOpen, props.isChatOpen ? 0 : props.unreadChatCount) : null;
  const copyLink = () => void navigator.clipboard.writeText(props.shareUrl ?? location.href).catch(() => props.onCopyError?.());
  const linkLabel = props.onCallLinkToggle ? (props.callLinkOpen ? "Hide call link" : "Show call link") : "Copy call link";
  const reactions = has("reactions") && (props.onOpenReactions || props.displayOnly) ? iconButton("Reactions", <ShellIcon name="smile" />, props.onOpenReactions, undefined, 0, props.isHandRaised, props.reactionsDisabled) : null;
  return (
    <div ref={dock} data-part="dock" className={cn("chalk-shell-dock", props.className)} role="toolbar" aria-label="Space controls">
      <ShellStyles />
      {has("mic") ? (
        <DevicePopover
          type="mic"
          isActive={!props.isMuted}
          busy={props.microphonePending}
          disabled={props.mediaEnableDisabled && props.isMuted}
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
        />
      ) : null}
      {has("video") ? (
        <DevicePopover
          type="video"
          isActive={props.isVideoEnabled ?? true}
          busy={props.cameraPending}
          disabled={props.mediaEnableDisabled && !props.isVideoEnabled}
          onToggle={props.onToggleVideo ?? (() => {})}
          devices={effectiveVideoInputDevices}
          selectedDeviceId={props.selectedVideoInput}
          onDeviceChange={props.onVideoInputChange ?? (() => {})}
          track={props.cameraTrack}
          captureCameraPreview={props.captureCameraPreview}
          warning={props.cameraWarning}
          mirrored={props.mirrored}
          onMirrorChange={props.onMirrorChange}
        />
      ) : null}
      <span className="chalk-shell-gap chalk-shell-desktop" />
      {has("screenshare") ? <ShareControl disabled={props.mediaEnableDisabled && !props.isScreenSharing} startDisabled={props.mediaEnableDisabled} sharing={props.isScreenSharing ?? false} onToggle={props.onToggleScreenShare} onStart={props.onStartScreenShare} /> : null}
      {reactions}
      {(!reactions || props.reactionsDisabled) && has("handraise") ? iconButton(props.isHandRaised ? "Lower hand" : "Raise hand", <HandIcon />, props.onToggleHandRaise, props.isHandRaised) : null}
      {has("whiteboard") && (props.onToggleWhiteboard || props.displayOnly) ? <span className="chalk-shell-desktop">{iconButton("Board", <ShellIcon name="pen" />, props.onToggleWhiteboard, props.isWhiteboardOpen)}</span> : null}
      {has("record") && (props.onToggleRecording || props.displayOnly) ? <span className="chalk-shell-desktop">{iconButton(props.isRecording ? "Stop recording" : "Record", <ShellIcon name="rec" />, props.isRecordingPending ? undefined : props.onToggleRecording, props.isRecording)}</span> : null}
      <span className="chalk-shell-desktop">{iconButton(fullscreen ? "Exit fullscreen" : "Fullscreen", <ShellIcon name={fullscreen ? "min" : "max"} />, toggleFullscreen, fullscreen)}</span>
      <span className="chalk-shell-gap chalk-shell-desktop" />

      <span className="chalk-shell-phone">
        <DockLayout layout={props.layout ?? "focus"} onLayoutChange={props.onLayoutChange ?? (() => {})}>
          <button type="button" data-call-link-trigger className="chalk-sheet-row" aria-pressed={props.onCallLinkToggle ? (props.callLinkOpen ?? false) : undefined} onClick={props.onCallLinkToggle ?? copyLink}>
            <CallLinkIcon />
            <span>{props.onCallLinkToggle ? linkLabel : "Copy link"}</span>
          </button>
          {has("video") && effectiveVideoInputDevices.length >= 2 ? (
            <button
              type="button"
              className="chalk-sheet-row"
              disabled={!props.onVideoInputChange || props.mediaEnableDisabled}
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
            <button type="button" className="chalk-sheet-row" disabled={props.mediaEnableDisabled && !props.isScreenSharing} onClick={props.onToggleScreenShare}>
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
      <span className="chalk-shell-corner chalk-shell-chat">{chat}</span>
    </div>
  );
});
ControlBarSurface.displayName = "ControlBarSurface";
export function ControlBar(props: ControlBarProps): React.JSX.Element {
  const { surfaceProps, commandError } = useConnectedControlBarBehavior(props);
  return (
    <>
      <ControlBarSurface {...surfaceProps} />
      {!props.onCommandError ? <CommandErrorAlert message={commandError?.message} /> : null}
    </>
  );
}
