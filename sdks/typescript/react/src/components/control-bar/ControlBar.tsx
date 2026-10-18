import React, { useRef, useState } from "react";
import { ChalkIconButton, ChalkTooltip } from "../chalk-ui";
import { cn } from "../../utils/cn";
import { CallEnd01Icon, CircleIcon, Edit02Icon, Message01Icon, SmileIcon, UserGroupIcon, Maximize01Icon, Share01Icon } from "../../utils/icons";
import { DevicePopover } from "../device-popover/DevicePopover";
import { CommandErrorAlert } from "../composite/CommandErrorAlert";
import { LeaveMenu } from "./LeaveMenu";
import { DockLayout } from "./DockLayout";
import { ShareControl } from "./ShareControl";
import { useConnectedControlBarBehavior, useControlBarSurfaceBehavior, type ControlBarSurfaceProps, type ControlBarProps } from "./control-bar-behavior";
import "./shell.css";
export type { ControlBarProps, ControlBarButtonName } from "./control-bar-behavior";
export function ControlBarPresentation(props: ControlBarSurfaceProps): React.JSX.Element {
  return <ControlBarSurface {...props} detectDevices={props.displayOnly ? false : props.detectDevices} />;
}

export const ControlBarSurface = React.memo((props: ControlBarSurfaceProps) => {
  const { buttonsToRender, effectiveAudioInputDevices, effectiveAudioOutputDevices, effectiveVideoInputDevices, showLeave } = useControlBarSurfaceBehavior({ ...props, density: props.density ?? "comfortable", detectDevices: props.detectDevices ?? true });
  const dock = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const has = (button: (typeof buttonsToRender)[number]) => buttonsToRender.includes(button);
  const iconButton = (label: string, icon: React.ReactNode, onClick?: () => void, active?: boolean, badge = 0, hand = false) => (
    <ChalkTooltip
      trigger={
        <ChalkIconButton size="lg" aria-label={label} aria-pressed={active} onClick={onClick}>
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
  const chat = has("chat") && (props.onToggleChat || props.displayOnly) ? iconButton("Chat", <Message01Icon />, props.onToggleChat, props.isChatOpen, props.isChatOpen ? 0 : props.unreadChatCount) : null;
  const reactions = has("reactions") && (props.onOpenReactions || props.displayOnly) ? iconButton("Reactions", <SmileIcon />, props.onOpenReactions, undefined, 0, props.isHandRaised) : null;
  return (
    <div ref={dock} data-part="dock" className={cn("chalk-shell-dock", props.className)} role="toolbar" aria-label="Call controls">
      {has("mic") ? (
        <DevicePopover
          type="mic"
          isActive={!props.isMuted}
          busy={props.microphonePending}
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
          onToggle={props.onToggleVideo ?? (() => {})}
          devices={effectiveVideoInputDevices}
          selectedDeviceId={props.selectedVideoInput}
          onDeviceChange={props.onVideoInputChange ?? (() => {})}
          track={props.cameraTrack}
          warning={props.cameraWarning}
          mirrored={props.mirrored}
          onMirrorChange={props.onMirrorChange}
        />
      ) : null}
      <span className="chalk-shell-gap chalk-shell-desktop" />
      {has("screenshare") ? <ShareControl sharing={props.isScreenSharing ?? false} onToggle={props.onToggleScreenShare} onStart={props.onStartScreenShare} /> : null}
      {reactions}
      {has("whiteboard") && (props.onToggleWhiteboard || props.displayOnly) ? <span className="chalk-shell-desktop">{iconButton("Board", <Edit02Icon />, props.onToggleWhiteboard, props.isWhiteboardOpen)}</span> : null}
      {has("record") && (props.onToggleRecording || props.displayOnly) ? (
        <span className="chalk-shell-desktop">{iconButton(props.isRecording ? "Stop recording" : "Record", <CircleIcon className={props.isRecording ? "fill-current" : ""} />, props.isRecordingPending ? undefined : props.onToggleRecording, props.isRecording)}</span>
      ) : null}
      <span className="chalk-shell-desktop">{iconButton(fullscreen ? "Exit fullscreen" : "Fullscreen", <Maximize01Icon />, toggleFullscreen, fullscreen)}</span>
      <span className="chalk-shell-gap chalk-shell-desktop" />

      <span className="chalk-shell-phone">
        <DockLayout
          layout={props.layout ?? "focus"}
          onLayoutChange={props.onLayoutChange ?? (() => {})}
          microphone={
            <DevicePopover
              type="mic"
              isActive={!props.isMuted}
              onToggle={props.onToggleMute ?? (() => {})}
              devices={effectiveAudioInputDevices}
              selectedDeviceId={props.selectedAudioInput}
              onDeviceChange={props.onAudioInputChange ?? (() => {})}
              secondaryDevices={effectiveAudioOutputDevices}
              selectedSecondaryDeviceId={props.selectedAudioOutput}
              onSecondaryDeviceChange={props.onAudioOutputChange}
              orientation="down"
            />
          }
          camera={<DevicePopover type="video" isActive={props.isVideoEnabled ?? true} onToggle={props.onToggleVideo ?? (() => {})} devices={effectiveVideoInputDevices} selectedDeviceId={props.selectedVideoInput} onDeviceChange={props.onVideoInputChange ?? (() => {})} orientation="down" />}
        >
          <button type="button" className="chalk-sheet-row" onClick={() => void navigator.clipboard.writeText(location.href).catch(() => props.onCopyError?.())}>
            <Share01Icon />
            <span>Copy link</span>
          </button>
          {has("whiteboard") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleWhiteboard}>
              <Edit02Icon />
              <span>Board</span>
            </button>
          ) : null}
          {has("chat") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleChat}>
              <Message01Icon />
              <span>Chat</span>
            </button>
          ) : null}
          {has("participants") ? (
            <button type="button" className="chalk-sheet-row" onClick={props.onToggleParticipants}>
              <UserGroupIcon />
              <span>People</span>
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
              <CallEnd01Icon />
            </ChalkIconButton>
          )}
        />
      ) : null}
      <span className="chalk-shell-corner chalk-shell-people">{iconButton("Copy call link", <Share01Icon />, () => void navigator.clipboard.writeText(location.href).catch(() => props.onCopyError?.()))}</span>
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
      {!props.onCommandError ? <CommandErrorAlert message={commandError ?? undefined} /> : null}
    </>
  );
}
